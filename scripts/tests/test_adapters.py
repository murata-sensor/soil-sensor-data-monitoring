"""Tests for data-source adapters."""

from __future__ import annotations

from scripts.adapters import to_normalized
from scripts.adapters.m5stack import HEADER_MAP as M5_HEADERS
from scripts.adapters.mechatrax import HEADER_MAP as MX_HEADERS


M5_HEADER_ROW = [
    "Date", "SerialNumber", "Date from M5Stack", "Battery(V)",
    "Temperature(degC)", "VWC(%)", "VWC Coconut Peat(%)", "VWC Rock Wool(%)",
    "EC bulk(dS/m)", "EC pore(dS/m)", "EC pore Coco(dS/m)",
    "Error flag", "WiFi RSI(dBm)",
]
M5_DATA_ROW = [
    "2026-01-08 10:08:27", "24026902", "2026-01-08 10:08",
    "4.831999779", "21.3125", "0", "0.100000001", "0.100000001",
    "0.008", "0", "65.53500366", "0", "-79",
]


MX_HEADER_ROW = [
    "Date", "MCC", "MNC", "area code", "cell id",
    "座標(latitude,longitude)", "loc_accuracy",
    "locTemp", "locTemp_id", "locPrec", "locPrec_id", "locSun", "locSun_id",
    "SerialNumber", "Date from logger",
    "Battery capacity(mV)", "Battery残量(%)",
    "Battery_current(mA)", "Battery_voltage(mV)", "Battery_temperature(°C)",
    "addr", "Temperature(degC)",
    "VWC(%)", "VWC_coco(%)", "VWC_rock(%)",
    "EC bulk(dS/m)", "EC_pore(dS/m)", "EC_porecoco(dS/m)",
    "外気温", "1hの降水量", "1hの日照時間",
]
MX_DATA_ROW = [
    "2026-07-18 17:00:43", "440", "10", "25213", "128176148",
    "REDACTED", "4114",
    "66421", "REDACTED", "66421", "REDACTED", "66421", "REDACTED",
    "25037029", "2026-07-18 17:00:26",
    "916", "36",
    "-456", "6400", "31",
    "0", "34.375",
    "62.6", "100", "91",
    "0.243", "0.745", "",
    "29.3", "0", "0.6",
]


def test_m5stack_headers_and_basic_mapping():
    rows = to_normalized("m5stack", [M5_HEADER_ROW, M5_DATA_ROW])
    assert len(rows) == 1
    r = rows[0]
    assert r.device_id == "24026902"
    assert r.battery_v == 4.831999779
    assert r.temperature_c == 21.3125
    assert r.vwc_pct == 0.0
    assert r.vwc_coco_pct == 0.100000001
    assert r.ec_bulk_dsm == 0.008
    assert r.rssi_dbm == -79.0
    assert r.error_flag == 0.0
    # Headers we deliberately drop are not in HEADER_MAP
    assert "Date from M5Stack" not in M5_HEADERS


def test_m5stack_skips_blank_rows_and_handles_missing_cells():
    short_row = M5_DATA_ROW[:5]
    rows = to_normalized(
        "m5stack",
        [M5_HEADER_ROW, [], M5_DATA_ROW, short_row],
    )
    assert len(rows) == 2
    # Short row has only timestamp + serial + 3 floats; remaining fields stay None
    assert rows[1].vwc_pct is None
    assert rows[1].rssi_dbm is None


def test_mechatrax_normalization_and_pii_drop():
    rows = to_normalized("mechatrax", [MX_HEADER_ROW, MX_DATA_ROW])
    assert len(rows) == 1
    r = rows[0]
    assert r.device_id == "25037029"
    assert r.battery_pct == 36.0
    # mV -> V conversion
    assert r.battery_v == 6.4
    assert r.temperature_c == 34.375
    assert r.vwc_pct == 62.6
    assert r.vwc_coco_pct == 100.0
    assert r.vwc_rock_pct == 91.0
    assert r.ec_bulk_dsm == 0.243
    assert r.ec_pore_dsm == 0.745
    assert r.ec_pore_coco_dsm is None  # blank cell
    assert r.air_temp_c == 29.3
    assert r.precip_1h_mm == 0.0
    assert r.sunshine_1h_h == 0.6
    # Sensitive columns must not appear in HEADER_MAP at all
    forbidden = {
        "MCC", "MNC", "area code", "cell id",
        "座標(latitude,longitude)", "loc_accuracy",
        "locTemp_id", "locPrec_id", "locSun_id",
    }
    assert not (forbidden & set(MX_HEADERS.keys()))


def test_remote_ftp_adapter_reads_published_columns():
    header = ["date", "siteId", "addr", "number",
            "battery1", "battery2", "bulk_ec", "vwc", "soil_temp",
            "air_temp", "precip_1h", "sunshine_1h"]
    row = ["2026-06-15 09:05:00+09:00", "site-a", "fac", "1",
            "3.45", "2.812", "0.860", "57.5", "18.5",
            "25.3", "5.2", "0.0"]
    out = to_normalized("remote-ftp", [header, row])
    assert len(out) == 1
    r = out[0]
    assert r.ts == "2026-06-15 09:05:00+09:00"
    assert r.device_id == "fac"
    assert r.battery_v == 3.45
    assert r.ec_bulk_dsm == 0.860
    assert r.vwc_pct == 57.5
    assert r.air_temp_c == 25.3
    assert r.precip_1h_mm == 5.2


def test_unknown_schema_raises():
    import pytest
    with pytest.raises(ValueError):
        to_normalized("nope", [["a"], ["1"]])
