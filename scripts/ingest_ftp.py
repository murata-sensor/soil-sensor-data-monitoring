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
"""

from __future__ import annotations

import ftplib
import io
import logging
import os
import re
from datetime import datetime, date, timezone, timedelta

import pandas as pd

from . import drive_backup
from .sensor_parser import IngestionConfig, concat_csvs, select_nine_am, to_published
from .sheets_client import SheetsClient

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
                    log.info("skipped %s (before %s)", name, skip_before)
                    continue
            buf = io.BytesIO()
            ftp.retrbinary(f"RETR {name}", buf.write)
            out.append((f"{name}.csv", buf.getvalue()))
            log.info("fetched %s (%d bytes)", name, buf.tell())
    return out


def main() -> int:
    spreadsheet_id = (
        os.environ.get("FTP_SPREADSHEET_ID")
        or os.environ.get("SPREADSHEET_ID")
    )
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

    if drive_backup.is_enabled():
        try:
            ids = drive_backup.upload_many(files)
            log.info("Backed up %d files to Drive (%s)", len(ids), ids[:3])
        except Exception:  # noqa: BLE001
            log.exception("Drive backup failed (continuing)")

    df = concat_csvs(t.decode("utf-8", errors="replace") for _, t in files)
    log.info("Parsed %d total rows", len(df))

    published = to_published(df, cfg)

    # De-dupe against the latest timestamp already in sensor_raw.
    if last:
        last_ts = pd.Timestamp(last)
        published = published[pd.to_datetime(published["date"]) > last_ts]
    n1 = sheets.append_rows(
        "sensor_raw",
        published.values.tolist(),
    )
    log.info("Appended %d rows to sensor_raw", n1)

    nine = select_nine_am(published)
    last9 = sheets.last_date("sensor_9am")
    if last9:
        nine = nine[pd.to_datetime(nine["date"]) > pd.Timestamp(last9)]
    n2 = sheets.append_rows("sensor_9am", nine.values.tolist())
    log.info("Appended %d rows to sensor_9am", n2)

    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
