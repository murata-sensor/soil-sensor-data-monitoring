from __future__ import annotations

import pandas as pd

from scripts.ingest_ftp import (
    _clamp_weather_date_range,
    _filter_rows_newer_than_last,
    _filter_rows_not_existing,
    _parse_ts_as_jst,
    fetch_weather_data,
)


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
