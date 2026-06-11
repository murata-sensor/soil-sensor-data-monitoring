"""Tests for sensor_parser. No network, no Sheets, no FTP."""

from __future__ import annotations

import pandas as pd
import pytest

from scripts.sensor_parser import (
    IngestionConfig,
    concat_csvs,
    parse_csv_text,
    select_nine_am,
    to_published,
)

SAMPLE = (
    "2026-06-15T00:08:35.000Z, 0x000fac, \"Soil\", 0, 1, 0, 17, 132, 0141232e, "
    "3286, 883, 0, 2146, 961, 341, 860, 3088, 575, 2812, 625, 0, 2668, 0, 852, "
    "889, 884, 873, 897, 894, 824, 896, 863, 854, 912, 902\n"
    "2026-06-15T00:08:36.000Z, 0x000fac, \"Soil\", 0, 2, 0, 17, 132, 0140fbe3, "
    "3300, 688, 0, 2153, 916, 325, 1079, 4918, 498, 2812, 548, 0, 4155, 0, 758, "
    "809, 631, 668, 731, 647, 709, 752, 646, 657, 701, 662\n"
)

NINE_AM_SAMPLE = (
    # 09:05 JST = 00:05 UTC
    "2026-06-15T00:05:00.000Z, 0x000fac, \"Soil\", 0, 1, 0, 17, 132, 0141232e, "
    "3286, 883, 0, 2146, 961, 341, 860, 3088, 575, 2812, 625, 0, 2668, 0, 852, "
    "889, 884, 873, 897, 894, 824, 896, 863, 854, 912, 902\n"
    # 09:20 JST same key
    "2026-06-15T00:20:00.000Z, 0x000fac, \"Soil\", 0, 1, 0, 17, 132, 0141232e, "
    "3286, 900, 0, 2146, 961, 341, 860, 3088, 575, 2812, 625, 0, 2668, 0, 852, "
    "889, 884, 873, 897, 894, 824, 896, 863, 854, 912, 902\n"
    # 10:00 JST — outside window
    "2026-06-15T01:00:00.000Z, 0x000fac, \"Soil\", 0, 1, 0, 17, 132, 0141232e, "
    "3286, 999, 0, 2146, 961, 341, 860, 3088, 575, 2812, 625, 0, 2668, 0, 852, "
    "889, 884, 873, 897, 894, 824, 896, 863, 854, 912, 902\n"
)


def _cfg() -> IngestionConfig:
    return IngestionConfig(
        site_id="site-a",
        start_after=pd.Timestamp("2026-01-01T00:00+09:00"),
    )


def test_parse_csv_text_columns_and_tz():
    df = parse_csv_text(SAMPLE)
    assert len(df) == 2
    assert str(df.index.tz) == "Asia/Tokyo"
    # bat raw = 2146 -> 2146/2048 * 3.3
    assert df["bat"].iloc[0] == pytest.approx(2146 / 2048 * 3.3, rel=1e-6)
    # vbat raw = 2812 -> 2.812
    assert df["vbat"].iloc[0] == pytest.approx(2.812)
    # bec raw = 860 -> 0.860
    assert df["bec"].iloc[0] == pytest.approx(0.860)
    # vwcO raw = 575 -> 57.5
    assert df["vwcO"].iloc[0] == pytest.approx(57.5)


def test_parse_csv_text_rejects_bad_shape():
    with pytest.raises(ValueError):
        parse_csv_text("2026-06-15T00:00:00.000Z, 0x1, 1, 2, 3\n")


def test_concat_csvs_handles_empty_lines():
    df = concat_csvs([SAMPLE, "", SAMPLE])
    assert len(df) == 4
    assert df.index.is_monotonic_increasing


def test_to_published_filters_and_shapes():
    df = parse_csv_text(SAMPLE)
    pub = to_published(df, _cfg())
    assert list(pub.columns) == [
        "date", "siteId", "addr", "number", "battery1", "battery2",
        "bulk_ec", "vwc", "soil_temp",
    ]
    assert (pub["siteId"] == "site-a").all()
    assert pub["addr"].iloc[0] == "fac"


def test_to_published_respects_start_after():
    df = parse_csv_text(SAMPLE)
    cfg = IngestionConfig(
        site_id="site-a",
        start_after=pd.Timestamp("2099-01-01T00:00+09:00"),
    )
    pub = to_published(df, cfg)
    assert pub.empty


def test_select_nine_am_keeps_first_in_window():
    df = parse_csv_text(NINE_AM_SAMPLE)
    pub = to_published(df, _cfg())
    nine = select_nine_am(pub)
    assert len(nine) == 1
    # First reading is at 09:05 JST
    assert nine["date"].iloc[0].startswith("2026-06-15 09:05")


def test_select_nine_am_empty_input():
    empty = pd.DataFrame(columns=["date", "siteId", "addr", "number"])
    assert select_nine_am(empty).empty
