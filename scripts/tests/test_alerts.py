from __future__ import annotations

import pandas as pd
import pytest

from scripts.alerts import (
    DEFAULT_RULES,
    AlertResult,
    AlertRule,
    check_alerts,
    is_smtp_configured,
    load_alert_rules,
    send_alert_email,
    write_alerts_to_sheet,
    _build_body,
    _build_subject,
)

# Convenience: extract default threshold values from DEFAULT_RULES
BULK_EC_FAULT_VALUE = 32.768
VWC_FAULT_VALUE = 3276.8
BATTERY2_LOW_THRESHOLD = 2.5


def _make_published(**overrides) -> pd.DataFrame:
    """Create a single-row published DataFrame with defaults."""
    row = {
        "date": "2026-06-15 09:00:00+09:00",
        "siteId": "site-a",
        "addr": "1a",
        "number": "1",
        "battery1": 3.2,
        "battery2": 3.0,
        "bulk_ec": 0.5,
        "vwc": 25.0,
        "soil_temp": 20.0,
        "air_temp": 22.0,
        "precip_1h": 0.0,
        "sunshine_1h": 0.5,
    }
    row.update(overrides)
    return pd.DataFrame([row])


class _MockSheetsClient:
    """Minimal mock for SheetsClient used in alert tests."""

    def __init__(self):
        self.appended_rows: list[list] = []
        self._sheet_name: str | None = None

    def append_rows(self, sheet: str, rows, batch_size: int = 5000) -> int:
        self._sheet_name = sheet
        for r in rows:
            self.appended_rows.append(list(r))
        return len(rows)


class TestCheckAlerts:
    def test_no_alerts_for_normal_data(self):
        df = _make_published()
        result = check_alerts(df)
        assert not result.has_alerts
        assert result.conditions == []

    def test_empty_dataframe(self):
        df = pd.DataFrame(columns=["date", "siteId", "addr", "number", "battery2", "bulk_ec", "vwc"])
        result = check_alerts(df)
        assert not result.has_alerts

    def test_detects_bulk_ec_fault(self):
        df = _make_published(bulk_ec=BULK_EC_FAULT_VALUE)
        result = check_alerts(df)
        assert result.has_alerts
        assert len(result.sensor_faults) == 1
        assert len(result.low_battery) == 0
        assert "bulk_ec" in result.sensor_faults[0].details

    def test_detects_vwc_fault(self):
        df = _make_published(vwc=VWC_FAULT_VALUE)
        result = check_alerts(df)
        assert result.has_alerts
        assert len(result.sensor_faults) == 1
        assert "vwc" in result.sensor_faults[0].details

    def test_detects_both_sensor_faults(self):
        df = _make_published(bulk_ec=BULK_EC_FAULT_VALUE, vwc=VWC_FAULT_VALUE)
        result = check_alerts(df)
        assert len(result.sensor_faults) == 2

    def test_detects_low_battery(self):
        df = _make_published(battery2=2.4)
        result = check_alerts(df)
        assert result.has_alerts
        assert len(result.low_battery) == 1
        assert "battery2=2.4" in result.low_battery[0].details

    def test_battery_at_threshold_no_alert(self):
        df = _make_published(battery2=2.5)
        result = check_alerts(df)
        assert len(result.low_battery) == 0

    def test_battery_just_below_threshold(self):
        df = _make_published(battery2=2.499)
        result = check_alerts(df)
        assert len(result.low_battery) == 1

    def test_combined_sensor_fault_and_low_battery(self):
        df = _make_published(bulk_ec=BULK_EC_FAULT_VALUE, battery2=2.0)
        result = check_alerts(df)
        assert len(result.sensor_faults) == 1
        assert len(result.low_battery) == 1
        assert len(result.conditions) == 2

    def test_multiple_rows(self):
        rows = [
            {"date": "2026-06-15 09:00:00+09:00", "siteId": "site-a", "addr": "1a",
             "number": "1", "battery1": 3.2, "battery2": 3.0,
             "bulk_ec": BULK_EC_FAULT_VALUE, "vwc": 25.0, "soil_temp": 20.0,
             "air_temp": None, "precip_1h": None, "sunshine_1h": None},
            {"date": "2026-06-15 09:00:00+09:00", "siteId": "site-a", "addr": "1a",
             "number": "2", "battery1": 3.2, "battery2": 2.3,
             "bulk_ec": 0.5, "vwc": 25.0, "soil_temp": 20.0,
             "air_temp": None, "precip_1h": None, "sunshine_1h": None},
            {"date": "2026-06-15 09:00:00+09:00", "siteId": "site-a", "addr": "1a",
             "number": "3", "battery1": 3.2, "battery2": 3.1,
             "bulk_ec": 0.5, "vwc": 25.0, "soil_temp": 20.0,
             "air_temp": None, "precip_1h": None, "sunshine_1h": None},
        ]
        df = pd.DataFrame(rows)
        result = check_alerts(df)
        assert len(result.sensor_faults) == 1
        assert len(result.low_battery) == 1
        assert result.sensor_faults[0].sensor_number == "1"
        assert result.low_battery[0].sensor_number == "2"

    def test_nan_values_ignored(self):
        df = _make_published(bulk_ec=float("nan"), vwc=float("nan"), battery2=float("nan"))
        result = check_alerts(df)
        assert not result.has_alerts

    def test_alert_condition_fields(self):
        df = _make_published(bulk_ec=BULK_EC_FAULT_VALUE)
        result = check_alerts(df)
        c = result.sensor_faults[0]
        assert c.timestamp == "2026-06-15 09:00:00+09:00"
        assert c.site_id == "site-a"
        assert c.addr == "1a"
        assert c.sensor_number == "1"
        assert c.alert_type == "sensor_fault"


class TestBuildEmail:
    def test_subject_sensor_fault_only(self):
        result = AlertResult()
        result.conditions = [check_alerts(_make_published(bulk_ec=BULK_EC_FAULT_VALUE)).conditions[0]]
        subject = _build_subject(result)
        assert "センサ異常" in subject
        assert "電池残量" not in subject

    def test_subject_low_battery_only(self):
        result = AlertResult()
        result.conditions = [check_alerts(_make_published(battery2=2.0)).conditions[0]]
        subject = _build_subject(result)
        assert "電池残量低下" in subject
        assert "センサ異常" not in subject

    def test_subject_combined(self):
        result = check_alerts(_make_published(bulk_ec=BULK_EC_FAULT_VALUE, battery2=2.0))
        subject = _build_subject(result)
        assert "センサ異常" in subject
        assert "電池残量低下" in subject

    def test_body_contains_details(self):
        result = check_alerts(_make_published(bulk_ec=BULK_EC_FAULT_VALUE, battery2=2.0))
        body = _build_body(result)
        assert "1a" in body
        assert "site-a" in body
        assert "bulk_ec" in body
        assert "battery2=2.0" in body


class TestIsSmtpConfigured:
    def test_returns_false_when_no_env(self, monkeypatch):
        monkeypatch.delenv("ALERT_SMTP_HOST", raising=False)
        monkeypatch.delenv("ALERT_FROM", raising=False)
        monkeypatch.delenv("ALERT_TO", raising=False)
        assert not is_smtp_configured()

    def test_returns_true_when_configured(self, monkeypatch):
        monkeypatch.setenv("ALERT_SMTP_HOST", "smtp.example.com")
        monkeypatch.setenv("ALERT_FROM", "sensor@example.com")
        monkeypatch.setenv("ALERT_TO", "admin@example.com")
        assert is_smtp_configured()

    def test_returns_false_when_partial(self, monkeypatch):
        monkeypatch.setenv("ALERT_SMTP_HOST", "smtp.example.com")
        monkeypatch.delenv("ALERT_FROM", raising=False)
        monkeypatch.delenv("ALERT_TO", raising=False)
        assert not is_smtp_configured()


class TestWriteAlertsToSheet:
    def test_no_write_when_no_alerts(self):
        result = AlertResult()
        mock_sheets = _MockSheetsClient()
        assert write_alerts_to_sheet(result, mock_sheets) == 0
        assert mock_sheets.appended_rows == []

    def test_writes_sensor_fault_rows(self):
        result = check_alerts(_make_published(bulk_ec=BULK_EC_FAULT_VALUE))
        mock_sheets = _MockSheetsClient()
        n = write_alerts_to_sheet(result, mock_sheets)
        assert n == 1
        assert len(mock_sheets.appended_rows) == 1
        row = mock_sheets.appended_rows[0]
        assert row[2] == "sensor_fault"  # alert_type
        assert row[3] == "site-a"        # site_id
        assert row[4] == "1a"            # addr
        assert row[7] == "new"           # status

    def test_writes_low_battery_rows(self):
        result = check_alerts(_make_published(battery2=2.0))
        mock_sheets = _MockSheetsClient()
        n = write_alerts_to_sheet(result, mock_sheets)
        assert n == 1
        row = mock_sheets.appended_rows[0]
        assert row[2] == "low_battery"
        assert row[7] == "new"

    def test_writes_multiple_alerts(self):
        result = check_alerts(_make_published(bulk_ec=BULK_EC_FAULT_VALUE, battery2=2.0))
        mock_sheets = _MockSheetsClient()
        n = write_alerts_to_sheet(result, mock_sheets)
        assert n == 2
        assert len(mock_sheets.appended_rows) == 2


class TestSendAlertEmail:
    def test_returns_false_for_empty_result(self):
        result = AlertResult()
        assert send_alert_email(result) is False

    def test_returns_false_when_not_configured(self, monkeypatch):
        monkeypatch.delenv("ALERT_SMTP_HOST", raising=False)
        monkeypatch.delenv("ALERT_FROM", raising=False)
        monkeypatch.delenv("ALERT_TO", raising=False)
        result = check_alerts(_make_published(bulk_ec=BULK_EC_FAULT_VALUE))
        assert send_alert_email(result) is False


class TestLoadAlertRules:
    def test_returns_defaults_when_sheet_missing(self):
        class _FailingSheets:
            def get_values(self, range_):
                raise Exception("Sheet not found")

        rules = load_alert_rules(_FailingSheets())
        assert rules == DEFAULT_RULES

    def test_returns_defaults_when_sheet_empty(self):
        class _EmptySheets:
            def get_values(self, range_):
                return []

        rules = load_alert_rules(_EmptySheets())
        assert rules == DEFAULT_RULES

    def test_returns_defaults_when_header_only(self):
        class _HeaderOnlySheets:
            def get_values(self, range_):
                return [["enabled", "field", "operator", "value", "alert_type", "message"]]

        rules = load_alert_rules(_HeaderOnlySheets())
        assert rules == DEFAULT_RULES

    def test_loads_custom_rules(self):
        class _CustomSheets:
            def get_values(self, range_):
                return [
                    ["enabled", "field", "operator", "value", "alert_type", "message"],
                    ["TRUE", "soil_temp", ">", "50", "overtemp", "土壌温度異常"],
                    ["TRUE", "battery1", "<", "3.0", "low_battery", "電池1低下"],
                ]

        rules = load_alert_rules(_CustomSheets())
        assert len(rules) == 2
        assert rules[0].field == "soil_temp"
        assert rules[0].operator == ">"
        assert rules[0].value == 50.0
        assert rules[0].alert_type == "overtemp"
        assert rules[1].field == "battery1"

    def test_skips_disabled_rules(self):
        class _MixedSheets:
            def get_values(self, range_):
                return [
                    ["enabled", "field", "operator", "value", "alert_type", "message"],
                    ["TRUE", "bulk_ec", "==", "32.768", "sensor_fault", "故障"],
                    ["FALSE", "vwc", "==", "3276.8", "sensor_fault", "故障"],
                ]

        rules = load_alert_rules(_MixedSheets())
        assert len(rules) == 1
        assert rules[0].field == "bulk_ec"

    def test_skips_invalid_operator(self):
        class _BadOpSheets:
            def get_values(self, range_):
                return [
                    ["enabled", "field", "operator", "value", "alert_type", "message"],
                    ["TRUE", "bulk_ec", "LIKE", "32.768", "sensor_fault", "故障"],
                ]

        rules = load_alert_rules(_BadOpSheets())
        # Falls back to defaults since no valid rules
        assert rules == DEFAULT_RULES


class TestCustomRules:
    def test_custom_greater_than_rule(self):
        rules = [AlertRule(field="soil_temp", operator=">", value=50.0, alert_type="overtemp", message="過熱")]
        df = _make_published(soil_temp=55.0)
        result = check_alerts(df, rules=rules)
        assert result.has_alerts
        assert result.conditions[0].alert_type == "overtemp"
        assert "soil_temp=55.0" in result.conditions[0].details

    def test_custom_rule_no_match(self):
        rules = [AlertRule(field="soil_temp", operator=">", value=50.0, alert_type="overtemp", message="過熱")]
        df = _make_published(soil_temp=25.0)
        result = check_alerts(df, rules=rules)
        assert not result.has_alerts

    def test_custom_not_equal_rule(self):
        rules = [AlertRule(field="bulk_ec", operator="!=", value=0.0, alert_type="custom", message="非ゼロ")]
        df = _make_published(bulk_ec=0.5)
        result = check_alerts(df, rules=rules)
        assert result.has_alerts

    def test_empty_rules_no_alerts(self):
        df = _make_published(bulk_ec=32.768, battery2=2.0)
        result = check_alerts(df, rules=[])
        assert not result.has_alerts
