"""Parsing and transformation for soil-sensor FTP CSVs.

The raw CSV format has no header and 35 columns. See SPEC.md §4.1.

This module is deliberately free of any I/O so it can be unit-tested
without network or filesystem dependencies.
"""

from __future__ import annotations

from dataclasses import dataclass
from io import StringIO
from typing import Iterable

import pandas as pd

# 35 raw column names matching the FTP CSV layout.
RAW_COLUMNS = [
    "Time", "Addr", "dummy1", "dummy2", "#", "err", "Cal", "ndx", "S/N",
    "dds", "ec", "rT", "bat", "Perm", "CT", "bec", "vwcM", "vwcO", "vbat",
    "vwcC", "ecM", "ecO", "ecC",
    "ec1", "ec2", "ec3", "ec4", "ec5", "ec6", "ec7", "ec8", "ec9", "ec10",
    "ec11", "ec12",
]

# Columns published to Spreadsheet `sensor_raw` / `sensor_9am`.
PUBLISHED_COLUMNS = [
    "date", "siteId", "addr", "number", "battery1", "battery2",
    "bulk_ec", "vwc", "soil_temp",
]


@dataclass(frozen=True)
class IngestionConfig:
    site_id: str
    start_after: pd.Timestamp  # tz-aware
    nine_am_window: tuple[str, str] = ("09:00", "09:30")


def _hex_to_int(value):
    try:
        return int(value, base=16)
    except Exception:
        return value


def _ct_to_celsius(raw):
    """Convert CT raw value (12-bit 2's complement) to °C (* 0.0625)."""
    v = int(raw)
    if v >= 2048:  # MSB of 12-bit is set → negative
        v -= 4096
    return v * 0.0625


def parse_csv_text(text: str) -> pd.DataFrame:
    """Parse a single FTP CSV file text into a typed DataFrame.

    Strings that look like hex (e.g. ``S/N`` column) are converted to int.
    Time is converted to Asia/Tokyo tz-aware DatetimeIndex.
    """
    df = pd.read_csv(StringIO(text), header=None, skipinitialspace=True)
    if df.shape[1] != len(RAW_COLUMNS):
        raise ValueError(
            f"Unexpected column count: got {df.shape[1]}, expected {len(RAW_COLUMNS)}"
        )
    df.columns = RAW_COLUMNS
    df["Time"] = pd.to_datetime(df["Time"], utc=True).dt.tz_convert("Asia/Tokyo")
    df = df.set_index("Time")
    # Scale conversions per SPEC §4.1
    df["bat"] = df["bat"].astype(float) / 2048.0 * 3.3
    df["vbat"] = df["vbat"].astype(float) / 1000.0
    df["bec"] = df["bec"].astype(float) / 1000.0
    df["vwcO"] = df["vwcO"].astype(float) / 10.0
    df = df.map(_hex_to_int)
    return df


def concat_csvs(texts: Iterable[str]) -> pd.DataFrame:
    frames = [parse_csv_text(t) for t in texts if t.strip()]
    if not frames:
        return pd.DataFrame(columns=RAW_COLUMNS).set_index("Time")
    return pd.concat(frames).sort_index()


def to_published(df: pd.DataFrame, cfg: IngestionConfig) -> pd.DataFrame:
    """Reduce a raw DataFrame to the published columns (SPEC §4.1)."""
    if df.empty:
        return pd.DataFrame(columns=PUBLISHED_COLUMNS)
    filtered = df[df.index > cfg.start_after]
    out = pd.DataFrame({
        "date": filtered.index.strftime("%Y-%m-%d %H:%M:%S+09:00"),
        "siteId": cfg.site_id,
        "addr": filtered["Addr"].apply(
            lambda x: hex(x)[2:] if isinstance(x, int) else str(x)
        ),
        "number": filtered["#"].astype(int).tolist(),
        "battery1": filtered["bat"].astype(float).round(4).tolist(),
        "battery2": filtered["vbat"].astype(float).round(4).tolist(),
        "bulk_ec": filtered["bec"].astype(float).round(4).tolist(),
        "vwc": filtered["vwcO"].astype(float).round(2).tolist(),
        "soil_temp": filtered["CT"].apply(_ct_to_celsius).round(4).tolist(),
    })
    return out.reset_index(drop=True)


def select_nine_am(published: pd.DataFrame, window=("09:00", "09:30")) -> pd.DataFrame:
    """Keep the first reading per (date, siteId, addr, number) within the window."""
    if published.empty:
        return published
    df = published.copy()
    df["_ts"] = pd.to_datetime(df["date"])
    df["_t"] = df["_ts"].dt.strftime("%H:%M")
    mask = (df["_t"] >= window[0]) & (df["_t"] <= window[1])
    df = df[mask].sort_values("_ts")
    df["_date"] = df["_ts"].dt.strftime("%Y-%m-%d")
    df = df.drop_duplicates(subset=["_date", "siteId", "addr", "number"], keep="first")
    return df.drop(columns=["_t", "_ts", "_date"]).reset_index(drop=True)
