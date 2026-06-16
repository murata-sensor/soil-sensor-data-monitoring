"""Alert module for sensor anomaly and low battery detection.

Checks published sensor data against rules defined in the "alert_rules"
sheet of the same spreadsheet. Rules can be added/modified without code changes.

alert_rules sheet schema:
    enabled | field | operator | value | alert_type | message
    TRUE    | bulk_ec  | ==  | 32.768 | sensor_fault | 接触不良・故障の疑い
    TRUE    | vwc      | ==  | 3276.8 | sensor_fault | 接触不良・故障の疑い
    TRUE    | battery2 | <   | 2.5    | low_battery  | 電池残量低下

If the sheet is missing or empty, built-in default rules are used.

Alert delivery (choose one or both):

1. Sheets-based (recommended — no extra Secrets):
   Writes alert rows to the "alerts" sheet in the same spreadsheet.
   A companion GAS script (gas/alert_mailer.gs) watches the sheet and
   sends email via MailApp using the spreadsheet owner's account.

2. SMTP-based (optional fallback):
   ALERT_SMTP_HOST, ALERT_SMTP_PORT, ALERT_SMTP_USER, ALERT_SMTP_PASS,
   ALERT_FROM, ALERT_TO
"""

from __future__ import annotations

import logging
import operator as op
import os
import smtplib
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from email.mime.text import MIMEText
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import pandas as pd
    from .sheets_client import SheetsClient

log = logging.getLogger("ingest.alerts")

JST = timezone(timedelta(hours=9))

# --- Alert rules ---

ALERT_RULES_SHEET = "alert_rules"

OPERATORS: dict[str, object] = {
    "==": op.eq,
    "!=": op.ne,
    "<": op.lt,
    "<=": op.le,
    ">": op.gt,
    ">=": op.ge,
}


@dataclass(frozen=True)
class AlertRule:
    """A single alert rule definition."""

    field: str        # column name in published data (e.g. "bulk_ec", "battery2")
    operator: str     # "==", "!=", "<", "<=", ">", ">="
    value: float      # threshold value
    alert_type: str   # e.g. "sensor_fault", "low_battery"
    message: str      # human-readable description


# Built-in defaults (used when alert_rules sheet is missing or empty)
DEFAULT_RULES: list[AlertRule] = [
    AlertRule(field="bulk_ec", operator="==", value=32.768, alert_type="sensor_fault", message="接触不良・故障の疑い"),
    AlertRule(field="vwc", operator="==", value=3276.8, alert_type="sensor_fault", message="接触不良・故障の疑い"),
    AlertRule(field="battery2", operator="<", value=2.5, alert_type="low_battery", message="電池残量低下"),
]


def load_alert_rules(sheets: "SheetsClient") -> list[AlertRule]:
    """Load alert rules from the alert_rules sheet.

    Falls back to DEFAULT_RULES if the sheet is missing or empty.
    """
    try:
        values = sheets.get_values(f"{ALERT_RULES_SHEET}!A1:F")
    except Exception:
        log.info("alert_rules sheet not found; using default rules")
        return list(DEFAULT_RULES)

    if not values or len(values) < 2:
        log.info("alert_rules sheet is empty; using default rules")
        return list(DEFAULT_RULES)

    header = [h.strip().lower() for h in values[0]]
    rules: list[AlertRule] = []

    for row in values[1:]:
        if len(row) < 6:
            continue
        row_dict = dict(zip(header, row))

        enabled = str(row_dict.get("enabled", "")).strip().upper()
        if enabled != "TRUE":
            continue

        field_name = str(row_dict.get("field", "")).strip()
        oper = str(row_dict.get("operator", "")).strip()
        value_str = str(row_dict.get("value", "")).strip()
        alert_type = str(row_dict.get("alert_type", "")).strip()
        message = str(row_dict.get("message", "")).strip()

        if not field_name or oper not in OPERATORS or not value_str:
            log.warning("Skipping invalid alert rule: field=%r op=%r value=%r", field_name, oper, value_str)
            continue

        try:
            value = float(value_str)
        except ValueError:
            log.warning("Skipping alert rule with non-numeric value: %r", value_str)
            continue

        rules.append(AlertRule(
            field=field_name,
            operator=oper,
            value=value,
            alert_type=alert_type or "unknown",
            message=message or f"{field_name} {oper} {value}",
        ))

    if not rules:
        log.info("No valid rules in alert_rules sheet; using default rules")
        return list(DEFAULT_RULES)

    log.info("Loaded %d alert rule(s) from alert_rules sheet", len(rules))
    return rules


@dataclass
class AlertCondition:
    """A single alert occurrence."""

    alert_type: str  # "sensor_fault" or "low_battery"
    timestamp: str
    addr: str
    sensor_number: str
    details: str


@dataclass
class AlertResult:
    """Aggregated result of alert checks."""

    conditions: list[AlertCondition] = field(default_factory=list)

    @property
    def has_alerts(self) -> bool:
        return len(self.conditions) > 0

    @property
    def sensor_faults(self) -> list[AlertCondition]:
        return [c for c in self.conditions if c.alert_type == "sensor_fault"]

    @property
    def low_battery(self) -> list[AlertCondition]:
        return [c for c in self.conditions if c.alert_type == "low_battery"]


def check_alerts(published: "pd.DataFrame", rules: list[AlertRule] | None = None) -> AlertResult:
    """Check published data against alert rules.

    Args:
        published: DataFrame with columns from PUBLISHED_COLUMNS
                   (date, addr, number, battery1, battery2, bulk_ec, vwc, ...)
        rules: Alert rules to evaluate. If None, uses DEFAULT_RULES.

    Returns:
        AlertResult with any detected alert conditions.
    """
    result = AlertResult()

    if published.empty:
        return result

    if rules is None:
        rules = DEFAULT_RULES

    for _, row in published.iterrows():
        ts = str(row.get("date", ""))
        addr = str(row.get("addr", ""))
        number = str(row.get("number", ""))

        for rule in rules:
            cell_value = _safe_float(row.get(rule.field))
            if cell_value is None:
                continue

            op_func = OPERATORS.get(rule.operator)
            if op_func is None:
                continue

            if op_func(cell_value, rule.value):
                result.conditions.append(AlertCondition(
                    alert_type=rule.alert_type,
                    timestamp=ts,
                    addr=addr,
                    sensor_number=number,
                    details=f"{rule.field}={cell_value} ({rule.message})",
                ))

    return result


# --- Sheets-based alert delivery (primary) ---

ALERTS_SHEET = "alerts"
ALERTS_COLUMNS = ["timestamp", "detected_at", "alert_type", "addr", "sensor_number", "details", "status"]


def write_alerts_to_sheet(result: AlertResult, sheets: "SheetsClient") -> int:
    """Append alert rows to the 'alerts' sheet for GAS to pick up and email.

    Each row is written with status="new" so the GAS trigger knows it hasn't
    been sent yet.

    Returns the number of rows written.
    """
    if not result.has_alerts:
        return 0

    detected_at = datetime.now(JST).strftime("%Y-%m-%d %H:%M:%S+09:00")
    rows: list[list[str]] = []
    for c in result.conditions:
        rows.append([
            c.timestamp,
            detected_at,
            c.alert_type,
            c.addr,
            c.sensor_number,
            c.details,
            "new",
        ])

    n = sheets.append_rows(ALERTS_SHEET, rows)
    log.info("Wrote %d alert row(s) to '%s' sheet", n, ALERTS_SHEET)
    return n


# --- SMTP-based alert delivery (optional fallback) ---


def is_smtp_configured() -> bool:
    """Return True if SMTP email alert environment variables are set."""
    return bool(
        os.environ.get("ALERT_SMTP_HOST")
        and os.environ.get("ALERT_FROM")
        and os.environ.get("ALERT_TO")
    )


def send_alert_email(result: AlertResult) -> bool:
    """Send an alert email summarizing detected conditions.

    Returns True if email was sent successfully, False otherwise.
    """
    if not result.has_alerts:
        return False

    host = os.environ.get("ALERT_SMTP_HOST", "")
    port = int(os.environ.get("ALERT_SMTP_PORT", "587"))
    user = os.environ.get("ALERT_SMTP_USER", "")
    password = os.environ.get("ALERT_SMTP_PASS", "")
    sender = os.environ.get("ALERT_FROM", "")
    recipients = [r.strip() for r in os.environ.get("ALERT_TO", "").split(",") if r.strip()]
    use_tls = os.environ.get("ALERT_SMTP_USE_TLS", "1") != "0"

    if not host or not sender or not recipients:
        log.warning("Alert email not configured; skipping send")
        return False

    subject = _build_subject(result)
    body = _build_body(result)

    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = ", ".join(recipients)

    try:
        with smtplib.SMTP(host, port, timeout=30) as smtp:
            if use_tls:
                smtp.starttls()
            if user and password:
                smtp.login(user, password)
            smtp.sendmail(sender, recipients, msg.as_string())
        log.info("Alert email sent to %s (%d conditions)", recipients, len(result.conditions))
        return True
    except Exception:
        log.exception("Failed to send alert email")
        return False


def _build_subject(result: AlertResult) -> str:
    """Build email subject line."""
    parts: list[str] = []
    if result.sensor_faults:
        parts.append(f"センサ異常 x{len(result.sensor_faults)}")
    if result.low_battery:
        parts.append(f"電池残量低下 x{len(result.low_battery)}")
    return f"[土壌センサ警報] {', '.join(parts)}"


def _build_body(result: AlertResult) -> str:
    """Build email body text."""
    lines: list[str] = []
    lines.append("土壌センサ監視システムからの警報です。\n")

    if result.sensor_faults:
        lines.append("=" * 50)
        lines.append("■ センサ異常値検知（接触不良・故障の疑い）")
        lines.append("=" * 50)
        for c in result.sensor_faults:
            lines.append(
                f"  日時: {c.timestamp}  "
                f"アドレス: {c.addr}  センサ番号: {c.sensor_number}"
            )
            lines.append(f"  詳細: {c.details}")
            lines.append("")

    if result.low_battery:
        lines.append("=" * 50)
        lines.append("■ 電池残量低下")
        lines.append("=" * 50)
        for c in result.low_battery:
            lines.append(
                f"  日時: {c.timestamp}  "
                f"アドレス: {c.addr}  センサ番号: {c.sensor_number}"
            )
            lines.append(f"  詳細: {c.details}")
            lines.append("")

    lines.append("---")
    lines.append("このメールは自動送信されています。")
    return "\n".join(lines)


def _safe_float(value) -> float | None:
    """Safely convert a value to float."""
    if value is None:
        return None
    try:
        f = float(value)
    except (ValueError, TypeError):
        return None
    if f != f:  # NaN
        return None
    return f
