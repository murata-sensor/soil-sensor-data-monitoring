"""FTP → Sheets (+ optional Drive backup) ingestion.

Run from GitHub Actions:
    python -m scripts.ingest_ftp

Required env vars (Secrets):
    FTP_HOST, FTP_USER, FTP_PASS, FTP_DIR
    FTP_SPREADSHEET_ID (preferred) or SPREADSHEET_ID (legacy)
    GOOGLE_SERVICE_ACCOUNT_JSON
    INGEST_FILTER_START      (ISO-8601 with offset, e.g. 2026-06-12T10:30+09:00)
Optional:
    DRIVE_BACKUP_FOLDER_ID
    INGEST_YEAR              (default: current JST year)
    SITE_ID                  (default: site-a)
    FTP_SITE_LATITUDE        (site latitude for weather data; required for weather)
    FTP_SITE_LONGITUDE       (site longitude for weather data; required for weather)
"""

from __future__ import annotations

import ftplib
import io
import json
import logging
import os
import re
from datetime import datetime, date, timezone, timedelta
from typing import Callable

import pandas as pd
import urllib.request

from .sensor_parser import IngestionConfig, concat_csvs, select_nine_am, to_published

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ingest")

JST = timezone(timedelta(hours=9))


def _env(name: str, default: str | None = None) -> str:
    v = os.environ.get(name, default)
    if v is None:
        raise RuntimeError(f"Required env var missing: {name}")
    return v


def _date_from_filename(name: str) -> date | None:
    """Extract the first YYYYMMDD found in a filename, or None."""
    m = re.search(r"(\d{4})(\d{2})(\d{2})", name)
    if not m:
        return None
    try:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def _filter_rows_newer_than_last(published: pd.DataFrame, last: str | None) -> pd.DataFrame:
    """Return only rows whose `date` is newer than `last`.

    This normalizes both sides to tz-aware UTC timestamps so comparisons are
    stable even when one side is tz-naive (including empty datetime series).
    """
    if not last or published.empty:
        return published

    last_ts = pd.Timestamp(last)
    if last_ts.tzinfo is None:
        last_ts = last_ts.tz_localize(JST)
    last_ts = last_ts.tz_convert("UTC")

    published_dates = pd.to_datetime(published["date"], errors="coerce", utc=True)
    mask = published_dates.notna() & (published_dates > last_ts)
    if published_dates.isna().any():
        log.warning("Skipping rows with unparseable date values in published data")
    return published[mask]


def _parse_ts_as_jst(value: str | None) -> pd.Timestamp | None:
    if not value:
        return None
    ts = pd.Timestamp(value)
    if ts.tzinfo is None:
        ts = ts.tz_localize(JST)
    return ts.tz_convert("Asia/Tokyo")


def _filter_rows_not_existing(
    published: pd.DataFrame,
    existing_rows: list[list[str]],
) -> pd.DataFrame:
    """Return only rows not already present in the sheet.

    Uses (date, siteId, addr, number) as a stable row identity.
    """
    if published.empty:
        return published

    existing_keys: set[tuple[str, str, str, str]] = set()
    for row in existing_rows:
        if len(row) < 4:
            continue
        existing_keys.add((str(row[0]), str(row[1]), str(row[2]), str(row[3])))

    keys = published[["date", "siteId", "addr", "number"]].astype(str)
    mask = ~keys.apply(tuple, axis=1).isin(existing_keys)
    return published[mask]


def fetch_ftp_csvs(
    year: str,
    skip_before: date | None = None,
) -> list[tuple[str, bytes]]:
    """Connect to FTP, list files matching the year, download as bytes.

    Files whose embedded YYYYMMDD date is strictly before *skip_before* are
    skipped entirely so that already-ingested files are not re-downloaded.
    """
    host = _env("FTP_HOST")
    user = _env("FTP_USER")
    password = _env("FTP_PASS")
    directory = _env("FTP_DIR")
    out: list[tuple[str, bytes]] = []
    with ftplib.FTP(host, user, password, timeout=60) as ftp:
        ftp.cwd(directory)
        names = ftp.nlst("")
        for name in names:
            if year not in name:
                continue
            if skip_before is not None:
                file_date = _date_from_filename(name)
                if file_date is not None and file_date < skip_before:
                    log.info("skipped file dated %s (before %s)", file_date, skip_before)
                    continue
            buf = io.BytesIO()
            ftp.retrbinary(f"RETR {name}", buf.write)
            out.append((f"{name}.csv", buf.getvalue()))
            log.info("fetched file dated %s (%d bytes)", _date_from_filename(name) or "unknown", buf.tell())
    return out


def fetch_weather_data(
    latitude: float,
    longitude: float,
    start_date: date,
    end_date: date,
) -> pd.DataFrame:
    """Fetch daily weather data from Open-Meteo API.

    Returns a DataFrame indexed by date (YYYY-MM-DD) with columns:
    air_temp (°C), precip_1h (mm), sunshine_1h (h)
    """
    try:
        # Open-Meteo API endpoint for historical weather data
        url = (
            "https://archive-api.open-meteo.com/v1/archive"
            f"?latitude={latitude}"
            f"&longitude={longitude}"
            "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum"
            "&timezone=Asia%2FTokyo"
            f"&start_date={start_date.isoformat()}"
            f"&end_date={end_date.isoformat()}"
        )
        log.info("Fetching weather data from Open-Meteo: lat=%.4f lon=%.4f", latitude, longitude)

        with urllib.request.urlopen(url, timeout=30) as response:
            data = json.loads(response.read().decode("utf-8"))

        if "daily" not in data or "time" not in data["daily"]:
            log.warning("Weather API returned unexpected structure: %s", data)
            return pd.DataFrame()

        daily = data["daily"]
        df = pd.DataFrame({
            "date": daily["time"],
            "air_temp": daily.get("temperature_2m_max", [None] * len(daily["time"])),
            "precip_1h": daily.get("precipitation_sum", [None] * len(daily["time"])),
            "sunshine_1h": [None] * len(daily["time"]),  # API doesn't return this in archive
        })

        df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
        df = df.set_index("date")

        log.info("Fetched weather data for %d days", len(df))
        return df
    except Exception as e:
        log.error("Failed to fetch weather data: %s", e)
        return pd.DataFrame()


def main() -> int:
    from .sheets_client import SheetsClient

    # Optional dependency: Drive backup requires Google API packages.
    drive_backup_enabled = False
    drive_backup_upload_many: Callable[[list[tuple[str, bytes]]], list[str]] | None = None
    try:
        from . import drive_backup as drive_backup_module
    except ModuleNotFoundError:
        pass
    else:
        drive_backup_enabled = drive_backup_module.is_enabled()
        drive_backup_upload_many = drive_backup_module.upload_many

    spreadsheet_id = os.environ.get("FTP_SPREADSHEET_ID") or os.environ.get("SPREADSHEET_ID")
    if not spreadsheet_id:
        raise RuntimeError(
            "Required env var missing: FTP_SPREADSHEET_ID (or legacy SPREADSHEET_ID)"
        )
    site_id = os.environ.get("SITE_ID", "site-a")
    year = os.environ.get("INGEST_YEAR") or str(datetime.now(JST).year)
    start_after = pd.Timestamp(_env("INGEST_FILTER_START"))
    if start_after.tzinfo is None:
        start_after = start_after.tz_localize(JST)
    cfg = IngestionConfig(site_id=site_id, start_after=start_after)

    sheets = SheetsClient(spreadsheet_id)

    # Determine the earliest date we still need: max(INGEST_FILTER_START, last ingested).
    # FTP file names use GMT dates, but sensor timestamps are stored as JST (UTC+9).
    # A GMT file dated D can contain JST records up to D+1 (e.g. GMT 2025-06-16 covers
    # JST up to 2025-06-17T08:59). To avoid missing those records, subtract 1 day from
    # the last-ingested boundary before comparing against GMT file dates.
    last = sheets.last_date("sensor_raw")
    skip_before: date | None = start_after.date()
    if last:
        last_date = pd.Timestamp(last).date()
        last_date_gmt_safe = last_date - timedelta(days=1)
        if last_date_gmt_safe > skip_before:
            skip_before = last_date_gmt_safe
    log.info("Skipping FTP files with date before %s", skip_before)

    files = fetch_ftp_csvs(year, skip_before=skip_before)
    log.info("Downloaded %d CSV file(s) from FTP", len(files))

    if drive_backup_enabled and drive_backup_upload_many is not None:
        try:
            ids = drive_backup_upload_many(files)
            log.info("Backed up %d files to Drive (%s)", len(ids), ids[:3])
        except Exception:  # noqa: BLE001
            log.exception("Drive backup failed (continuing)")

    df = concat_csvs(t.decode("utf-8", errors="replace") for _, t in files)
    log.info("Parsed %d total rows", len(df))

    # Fetch weather data if coordinates are provided
    weather_df = None
    lat_str = os.environ.get("FTP_SITE_LATITUDE")
    lon_str = os.environ.get("FTP_SITE_LONGITUDE")
    if lat_str and lon_str:
        try:
            lat = float(lat_str)
            lon = float(lon_str)
            # Determine date range for weather data
            if not df.empty:
                min_date = df.index.min().date()
                max_date = df.index.max().date()
            else:
                min_date = start_after.date()
                max_date = datetime.now(JST).date()

            # Add 1 day buffer for timezone safety
            min_date = min_date - timedelta(days=1)
            max_date = max_date + timedelta(days=1)

            weather_df = fetch_weather_data(lat, lon, min_date, max_date)
            if weather_df.empty:
                log.warning("No weather data fetched")
                weather_df = None
        except ValueError as e:
            log.warning("Invalid weather coordinates: %s", e)
    else:
        log.info("Weather coordinates not provided (FTP_SITE_LATITUDE/FTP_SITE_LONGITUDE)")

    published = to_published(df, cfg, weather_df=weather_df)

    # Fast path: append only strictly newer rows.
    # Backfill path: when INGEST_FILTER_START is older than current last row,
    # switch to key-based de-duplication so historical gaps can be filled.
    last_ts = _parse_ts_as_jst(last)
    if last_ts is not None and cfg.start_after < last_ts:
        existing = sheets.get_values("sensor_raw!A2:D")
        before = len(published)
        published = _filter_rows_not_existing(published, existing)
        log.info(
            "Backfill mode enabled (start_after=%s, last=%s): kept %d/%d rows after key de-duplication",
            cfg.start_after,
            last_ts,
            len(published),
            before,
        )
    else:
        published = _filter_rows_newer_than_last(published, last)
    n1 = sheets.append_rows(
        "sensor_raw",
        published.values.tolist(),
    )
    log.info("Appended %d rows to sensor_raw", n1)

    nine = select_nine_am(published)
    last9 = sheets.last_date("sensor_9am")
    nine = _filter_rows_newer_than_last(nine, last9)
    n2 = sheets.append_rows("sensor_9am", nine.values.tolist())
    log.info("Appended %d rows to sensor_9am", n2)

    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
