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
from datetime import datetime, timezone, timedelta

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


def fetch_ftp_csvs(year: str) -> list[tuple[str, bytes]]:
    """Connect to FTP, list files matching the year, download as bytes."""
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

    files = fetch_ftp_csvs(year)
    log.info("Downloaded %d CSV file(s) from FTP", len(files))

    if drive_backup.is_enabled():
        try:
            ids = drive_backup.upload_many(files)
            log.info("Backed up %d files to Drive (%s)", len(ids), ids[:3])
        except Exception:  # noqa: BLE001
            log.exception("Drive backup failed (continuing)")

    df = concat_csvs(t.decode("utf-8", errors="replace") for _, t in files)
    log.info("Parsed %d total rows", len(df))

    sheets = SheetsClient(spreadsheet_id)
    published = to_published(df, cfg)

    # De-dupe against the latest timestamp already in sensor_raw.
    last = sheets.last_date("sensor_raw")
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
