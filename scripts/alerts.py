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
from typing import TYPE_CHECKING, Any, Sequence

if TYPE_CHECKING:
    import pandas as pd
    from .sheets_client import SheetsClient

log = logging.getLogger("ingest.alerts")

JST = timezone(timedelta(hours=9))

# --- Alert rules ---

ALERT_RULES_SHEET = "alert_rules"
MONITORED_SENSORS_SHEET = "monitored_sensors"

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


@dataclass(frozen=True)
class MonitoredSensor:
    """A sensor expected to report within a configured interval."""

    addr: str
    sensor_number: str
    max_silence_hours: float
    message: str


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


def load_monitored_sensors(sheets: "SheetsClient") -> list[MonitoredSensor]:
    """Load opt-in missing-data monitoring configuration."""
    try:
        values = sheets.get_values(f"{MONITORED_SENSORS_SHEET}!A1:E")
    except Exception:
        log.info("monitored_sensors sheet not found; missing-data monitoring disabled")
        return []

    if len(values) < 2:
        return []

    header = [str(value).strip().lower() for value in values[0]]
    sensors: list[MonitoredSensor] = []
    for row in values[1:]:
        row_dict = dict(zip(header, row))
        if str(row_dict.get("enabled", "")).strip().upper() != "TRUE":
            continue
        addr = str(row_dict.get("addr", "")).strip()
        sensor_number = str(row_dict.get("number", "")).strip()
        try:
            max_silence_hours = float(row_dict.get("max_silence_hours", ""))
        except (TypeError, ValueError):
            log.warning("Skipping monitored sensor with invalid max_silence_hours: %r", row)
            continue
        if not addr or not sensor_number or max_silence_hours <= 0:
            log.warning("Skipping invalid monitored sensor: %r", row)
            continue
        sensors.append(MonitoredSensor(
            addr=addr,
            sensor_number=sensor_number,
            max_silence_hours=max_silence_hours,
            message=str(row_dict.get("message", "")).strip() or "データ受信停止",
        ))
    return sensors


@dataclass
class AlertCondition:
    """A single alert occurrence."""

    alert_type: str  # Rule type, "recovery", or "ongoing_<rule type>"
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

    @property
    def data_missing(self) -> list[AlertCondition]:
        return [c for c in self.conditions if c.alert_type == "data_missing"]


def check_alerts(
    published: "pd.DataFrame",
    rules: list[AlertRule] | None = None,
    previous: "pd.DataFrame | None" = None,
    existing_alert_rows: Sequence[Sequence[Any]] | None = None,
    now: datetime | None = None,
) -> AlertResult:
    """Notify on state changes and remind once per JST day for ongoing faults.

    Args:
        published: DataFrame with columns from PUBLISHED_COLUMNS
                   (date, addr, number, battery1, battery2, bulk_ec, vwc, ...)
        rules: Alert rules to evaluate. If None, uses DEFAULT_RULES.
        previous: Stored readings used to establish the preceding state.
                  Missing values do not clear an active abnormal condition.
        existing_alert_rows: Alert history, enabling daily ongoing reminders
                             when supplied (including an empty history).
        now: Notification time; defaults to the current time in JST.

    Returns:
        AlertResult with new conditions, recoveries, and due daily reminders.
    """
    import pandas as pd

    result = AlertResult()

    if published.empty and (previous is None or previous.empty):
        return result

    if rules is None:
        rules = DEFAULT_RULES

    readings = published.assign(_notify=True)
    if previous is not None and not previous.empty:
        readings = pd.concat([previous.assign(_notify=False), readings], ignore_index=True)
    readings = readings.assign(
        _timestamp=pd.to_datetime(readings["date"], format="mixed", utc=True, errors="coerce")
    ).sort_values("_timestamp", kind="stable")
    readings = readings.drop_duplicates(["_timestamp", "addr", "number"], keep="first")
    active: dict[tuple[str, str, int], AlertCondition] = {}
    started: set[tuple[str, str, int]] = set()

    for _, row in readings.iterrows():
        ts = str(row.get("date", ""))
        addr = str(row.get("addr", ""))
        number = str(row.get("number", ""))

        for rule_index, rule in enumerate(rules):
            cell_value = _safe_float(row.get(rule.field))
            if cell_value is None:
                continue

            op_func = OPERATORS.get(rule.operator)
            if op_func is None:
                continue

            key = (addr, number, rule_index)
            was_active = key in active
            is_active = op_func(cell_value, rule.value)
            if is_active:
                active[key] = AlertCondition(
                    alert_type=rule.alert_type,
                    timestamp=ts,
                    addr=addr,
                    sensor_number=number,
                    details=f"{rule.field}={cell_value} ({rule.message})",
                )
            else:
                active.pop(key, None)

            if row["_notify"] and is_active != was_active:
                if is_active:
                    started.add(key)
                result.conditions.append(AlertCondition(
                    alert_type=rule.alert_type if is_active else "recovery",
                    timestamp=ts,
                    addr=addr,
                    sensor_number=number,
                    details=(
                        f"{rule.field}={cell_value} ({rule.message})"
                        if is_active else f"{rule.field}={cell_value} ({rule.message}から復旧)"
                    ),
                ))

    if existing_alert_rows is not None:
        notification_time = now or datetime.now(JST)
        if notification_time.tzinfo is None:
            notification_time = notification_time.replace(tzinfo=JST)
        today = notification_time.astimezone(JST).date()
        notified_today: set[tuple[str, str, str, str]] = set()
        for alert_row in existing_alert_rows:
            if len(alert_row) < 6:
                continue
            try:
                detected_at = datetime.fromisoformat(str(alert_row[1]).replace("Z", "+00:00"))
            except ValueError:
                continue
            if detected_at.tzinfo is None:
                detected_at = detected_at.replace(tzinfo=JST)
            if detected_at.astimezone(JST).date() == today:
                notified_today.add((
                    str(alert_row[3]), str(alert_row[4]),
                    str(alert_row[2]).removeprefix("ongoing_"),
                    str(alert_row[5]).partition("=")[0],
                ))

        for key, condition in active.items():
            marker = (condition.addr, condition.sensor_number, condition.alert_type, rules[key[2]].field)
            if key in started or marker in notified_today:
                continue
            result.conditions.append(AlertCondition(
                alert_type=f"ongoing_{condition.alert_type}",
                timestamp=condition.timestamp,
                addr=condition.addr,
                sensor_number=condition.sensor_number,
                details=condition.details,
            ))

    return result


def check_missing_data(
    sensor_rows: Sequence[Sequence[Any]],
    monitored_sensors: list[MonitoredSensor],
    observation_end: datetime,
    existing_alert_rows: Sequence[Sequence[Any]] | None = None,
) -> AlertResult:
    """Detect monitored sensors silent before a completed reporting boundary.

    ``sensor_rows`` uses the sensor sheet's first three columns:
    date, addr, number. Existing alerts suppress repeats for the same last-seen
    timestamp; a later reading automatically rearms the alert.
    """
    result = AlertResult()
    if not monitored_sensors:
        return result

    if observation_end.tzinfo is None:
        observation_end = observation_end.replace(tzinfo=JST)
    observation_end = observation_end.astimezone(JST)

    monitored_keys = {(sensor.addr, sensor.sensor_number) for sensor in monitored_sensors}
    latest: dict[tuple[str, str], tuple[datetime, str]] = {}
    for row in sensor_rows:
        if len(row) < 3:
            continue
        timestamp_text = str(row[0]).strip()
        try:
            timestamp = datetime.fromisoformat(timestamp_text.replace("Z", "+00:00"))
        except ValueError:
            continue
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=JST)
        timestamp = timestamp.astimezone(JST)
        key = (str(row[1]).strip(), str(row[2]).strip())
        if key not in monitored_keys:
            continue
        if timestamp > observation_end:
            continue
        if key not in latest or timestamp > latest[key][0]:
            latest[key] = (timestamp, timestamp_text)

    already_alerted = {
        (str(row[0]).strip(), str(row[3]).strip(), str(row[4]).strip())
        for row in (existing_alert_rows or [])
        if len(row) >= 5 and str(row[2]).strip() == "data_missing"
    }

    for sensor in monitored_sensors:
        key = (sensor.addr, sensor.sensor_number)
        last_seen = latest.get(key)
        timestamp_text = last_seen[1] if last_seen else "未受信"
        if (timestamp_text, *key) in already_alerted:
            continue
        silence_hours = (
            (observation_end - last_seen[0]).total_seconds() / 3600
            if last_seen else float("inf")
        )
        if silence_hours > sensor.max_silence_hours:
            elapsed = (
                "一度も受信していません"
                if last_seen is None
                else f"同一トランスミッタで {silence_hours:.1f} 時間受信なし"
            )
            result.conditions.append(AlertCondition(
                alert_type="data_missing",
                timestamp=timestamp_text,
                addr=sensor.addr,
                sensor_number=sensor.sensor_number,
                details=f"{elapsed}（許容 {sensor.max_silence_hours:g} 時間、{sensor.message}）",
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


def _group_alerts(result: AlertResult) -> list[tuple[str, list[AlertCondition]]]:
    groups: dict[str, list[AlertCondition]] = {}
    for condition in result.conditions:
        groups.setdefault(condition.alert_type, []).append(condition)
    return sorted(groups.items(), key=lambda group: (
        2 if group[0].startswith("ongoing_") else 1 if group[0] == "recovery" else 0
    ))


def _alert_label(alert_type: str) -> str:
    labels = {
        "sensor_fault": "センサ異常",
        "low_battery": "電池残量低下",
        "data_missing": "データ受信停止",
    }
    if alert_type == "recovery":
        return "復旧"
    if alert_type.startswith("ongoing_"):
        original_type = alert_type.removeprefix("ongoing_")
        return f"継続中: {labels.get(original_type, original_type)}"
    return f"新規発生: {labels.get(alert_type, alert_type)}"


def _build_subject(result: AlertResult) -> str:
    """Build email subject line with changes before ongoing reminders."""
    parts = [f"{_alert_label(alert_type)} x{len(conditions)}" for alert_type, conditions in _group_alerts(result)]
    return f"[土壌センサ警報] {', '.join(parts)}"


def _build_body(result: AlertResult) -> str:
    """Build email body text."""
    lines: list[str] = []
    lines.append("土壌センサ監視システムからの警報です。\n")

    for alert_type, conditions in _group_alerts(result):
        lines.append("=" * 50)
        lines.append(f"■ {_alert_label(alert_type)}")
        lines.append("=" * 50)
        timestamp_label = "最終受信" if alert_type == "data_missing" else "日時"
        for condition in conditions:
            lines.append(
                f"  {timestamp_label}: {condition.timestamp}  "
                f"アドレス: {condition.addr}  センサ番号: {condition.sensor_number}"
            )
            lines.append(f"  詳細: {condition.details}")
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
