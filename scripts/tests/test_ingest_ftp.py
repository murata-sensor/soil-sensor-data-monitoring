from __future__ import annotations

import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pandas as pd
import pytest

from scripts import ingest_ftp
from scripts.alerts import MonitoredSensor

from scripts.ingest_ftp import (
    _clamp_weather_date_range,
    _completed_ftp_period_end,
    _filter_rows_newer_than_last,
    _filter_rows_not_existing,
    _parse_ts_as_jst,
    fetch_weather_data,
)


@pytest.mark.parametrize("start_after", [
    "2026-06-14T09:00:00+09:00",
    "2026-06-15T09:00:00+09:00",
])
@pytest.mark.parametrize("monitor_missing", [False, True])
def test_main_alerts_only_for_new_readings_on_repeated_ingestion(monkeypatch, start_after, monitor_missing):
    old_date = "2026-06-15 09:00:00+09:00"
    new_date = "2026-06-16 08:30:00+09:00"
    published = pd.DataFrame({
        "date": [old_date, new_date],
        "addr": ["fac", "fac"],
        "number": ["1", "1"],
        "battery2": [2.0, 2.0],
    })
    stored = {
        "sensor_raw": [published.iloc[0].tolist()],
        "sensor_9am": [[old_date, "fac", "1"]],
        "alerts": [],
    }

    def append_rows(sheet, rows):
        stored[sheet].extend(rows)
        return len(rows)

    sheets = Mock()
    sheets.last_date.side_effect = lambda sheet: stored[sheet][-1][0]
    sheets.get_values.side_effect = lambda range_: stored[range_.split("!")[0]]
    sheets.append_rows.side_effect = append_rows
    monkeypatch.setenv("FTP_SPREADSHEET_ID", "test-spreadsheet")
    monkeypatch.setenv("INGEST_FILTER_START", start_after)
    monkeypatch.delenv("FTP_SITE_LATITUDE", raising=False)
    monkeypatch.delenv("FTP_SITE_LONGITUDE", raising=False)
    monkeypatch.setitem(sys.modules, "scripts.sheets_client", SimpleNamespace(SheetsClient=lambda _: sheets))
    monkeypatch.setitem(sys.modules, "scripts.drive_backup", SimpleNamespace(is_enabled=lambda: False, upload_many=Mock()))
    monkeypatch.setattr(ingest_ftp, "fetch_ftp_csvs", lambda *args, **kwargs: [("sensor-20260616.csv", b"")])
    monkeypatch.setattr(ingest_ftp, "concat_csvs", lambda _: pd.DataFrame())
    monkeypatch.setattr(ingest_ftp, "to_published", lambda *args, **kwargs: published.copy())
    monkeypatch.setattr(ingest_ftp, "select_nine_am", lambda frame: frame.iloc[:0])
    monkeypatch.setattr(ingest_ftp, "load_alert_rules", lambda _: None)
    monitored = [MonitoredSensor("fac", "1", 3, "missing")] if monitor_missing else []
    monkeypatch.setattr(ingest_ftp, "load_monitored_sensors", lambda _: monitored)
    monkeypatch.setattr(ingest_ftp, "is_smtp_configured", lambda: True)
    send_email = Mock()
    monkeypatch.setattr(ingest_ftp, "send_alert_email", send_email)

    assert ingest_ftp.main() == 0
    assert len(stored["alerts"]) == 1
    assert stored["alerts"][0][0] == new_date
    assert stored["alerts"][0][6] == "new"
    assert len(send_email.call_args.args[0].conditions) == 1

    assert ingest_ftp.main() == 0
    assert len(stored["alerts"]) == 1
    assert send_email.call_count == 1


def test_completed_ftp_period_end_uses_newest_file_date():
    files = [
        ("sensor-20260614.csv", b""),
        ("sensor-20260615.csv", b""),
    ]

    result = _completed_ftp_period_end(files)

    assert result == pd.Timestamp("2026-06-15T09:00:00+09:00").to_pydatetime()


def test_filter_rows_newer_than_last_handles_empty_published_with_tz_aware_last():
    published = pd.DataFrame(columns=["date"])
    out = _filter_rows_newer_than_last(published, "2026-06-11 08:59:41+09:00")
    assert out.empty


def test_filter_rows_newer_than_last_with_mixed_offsets():
    published = pd.DataFrame(
        {
            "date": [
                "2026-06-11 08:59:40+09:00",
                "2026-06-11 08:59:41+09:00",
                "2026-06-11 09:00:00+09:00",
            ],
        }
    )

    out = _filter_rows_newer_than_last(published, "2026-06-11 08:59:41+09:00")

    assert len(out) == 1
    assert out.iloc[0]["date"] == "2026-06-11 09:00:00+09:00"


def test_filter_rows_newer_than_last_with_naive_last_treats_last_as_jst():
    published = pd.DataFrame(
        {
            "date": [
                "2026-06-11 08:59:40+09:00",
                "2026-06-11 09:00:00+09:00",
            ],
        }
    )

    out = _filter_rows_newer_than_last(published, "2026-06-11 08:59:41")

    assert len(out) == 1
    assert out.iloc[0]["date"] == "2026-06-11 09:00:00+09:00"


def test_parse_ts_as_jst_handles_naive_and_aware():
    naive = _parse_ts_as_jst("2026-06-11 09:00:00")
    aware = _parse_ts_as_jst("2026-06-11 09:00:00+09:00")

    assert naive is not None
    assert aware is not None
    assert str(naive.tz) == "Asia/Tokyo"
    assert str(aware.tz) == "Asia/Tokyo"
    assert naive == aware


def test_filter_rows_not_existing_by_identity_key():
    published = pd.DataFrame(
        {
            "date": [
                "2026-06-10 08:00:00+09:00",
                "2026-06-11 08:00:00+09:00",
            ],
            "addr": ["fac", "fac"],
            "number": ["1", "1"],
            "battery1": [3.1, 3.2],
        }
    )
    existing_rows = [
        ["2026-06-11 08:00:00+09:00", "fac", "1"],
    ]

    out = _filter_rows_not_existing(published, existing_rows)

    assert len(out) == 1
    assert out.iloc[0]["date"] == "2026-06-10 08:00:00+09:00"


def test_filter_rows_not_existing_keeps_same_day_rows_for_other_keys():
    published = pd.DataFrame(
        {
            "date": [
                "2026-06-11 09:05:00+09:00",
                "2026-06-11 09:20:00+09:00",
            ],
            "addr": ["fb0", "fac"],
            "number": ["1", "1"],
            "battery1": [3.1, 3.2],
        }
    )
    existing_rows = [
        ["2026-06-11 09:20:00+09:00", "fac", "1"],
    ]

    out = _filter_rows_not_existing(published, existing_rows)

    assert len(out) == 1
    assert out.iloc[0]["addr"] == "fb0"
    assert out.iloc[0]["date"] == "2026-06-11 09:05:00+09:00"


def test_clamp_weather_date_range_avoids_future_end_date(monkeypatch):
    class FixedDateTime:
        @staticmethod
        def now(tz):
            return pd.Timestamp("2026-06-11T09:38:00+09:00").to_pydatetime()

    monkeypatch.setattr("scripts.ingest_ftp.datetime", FixedDateTime)

    start_date, end_date = _clamp_weather_date_range(
        pd.Timestamp("2026-06-10").date(),
        pd.Timestamp("2026-06-12").date(),
    )

    assert start_date == pd.Timestamp("2026-06-10").date()
    assert end_date == pd.Timestamp("2026-06-11").date()


def test_fetch_weather_data_reads_hourly_archive_payload(monkeypatch):
    class DummyResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return b'{"hourly":{"time":["2026-06-12T00:00","2026-06-12T01:00"],"temperature_2m":[21.2,21.4],"precipitation":[1.9,0.0],"sunshine_duration":[1800,0]}}'

    monkeypatch.setattr("scripts.ingest_ftp.urllib.request.urlopen", lambda *args, **kwargs: DummyResponse())

    out = fetch_weather_data(
        38.2682,
        140.8694,
        pd.Timestamp("2026-06-12").date(),
        pd.Timestamp("2026-06-12").date(),
    )

    assert list(out.columns) == ["air_temp", "precip_1h", "sunshine_1h"]
    assert str(out.index.tz) == "Asia/Tokyo"
    assert out.iloc[0]["air_temp"] == 21.2
    assert out.iloc[0]["precip_1h"] == 1.9
    assert out.iloc[0]["sunshine_1h"] == 0.5
