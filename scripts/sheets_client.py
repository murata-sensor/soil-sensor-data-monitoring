"""Thin wrapper around the Google Sheets API used by the ingestion job.

Authentication is performed with a service-account JSON loaded from the
``GOOGLE_SERVICE_ACCOUNT_JSON`` environment variable (the JSON itself,
not a file path — this is how GitHub Actions Secrets are typically wired).
"""

from __future__ import annotations

import json
import os
from typing import Iterable, Sequence

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

SCOPES_RW = ["https://www.googleapis.com/auth/spreadsheets"]


def _credentials() -> Credentials:
    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not raw:
        raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON env var is required")
    info = json.loads(raw)
    return Credentials.from_service_account_info(info, scopes=SCOPES_RW)


class SheetsClient:
    def __init__(self, spreadsheet_id: str, creds: Credentials | None = None):
        self.spreadsheet_id = spreadsheet_id
        self._svc = build(
            "sheets", "v4", credentials=creds or _credentials(), cache_discovery=False
        )

    def get_values(self, range_: str) -> list[list[str]]:
        resp = self._svc.spreadsheets().values().get(
            spreadsheetId=self.spreadsheet_id, range=range_
        ).execute()
        return resp.get("values", [])

    def last_date(self, sheet: str, date_column: str = "A") -> str | None:
        """Return the last value of `date_column` (header is row 1)."""
        rng = f"{sheet}!{date_column}2:{date_column}"
        values = self.get_values(rng)
        if not values:
            return None
        return values[-1][0] if values[-1] else None

    def append_rows(self, sheet: str, rows: Sequence[Sequence[object]], batch_size: int = 5000) -> int:
        if not rows:
            return 0
        total = 0
        for i in range(0, len(rows), batch_size):
            chunk = rows[i:i + batch_size]
            body = {"values": [list(r) for r in chunk]}
            resp = self._svc.spreadsheets().values().append(
                spreadsheetId=self.spreadsheet_id,
                range=f"{sheet}!A1",
                valueInputOption="RAW",
                insertDataOption="INSERT_ROWS",
                body=body,
            ).execute()
            updates = resp.get("updates", {})
            total += int(updates.get("updatedRows", 0))
        return total

    def extend_filter(self, sheet: str) -> None:
        """Extend the BasicFilter on `sheet` to cover all current rows and columns."""
        meta = self._svc.spreadsheets().get(
            spreadsheetId=self.spreadsheet_id,
            fields="sheets(properties(sheetId,title,gridProperties))",
        ).execute()
        sheet_meta = next(
            (s for s in meta.get("sheets", []) if s["properties"]["title"] == sheet),
            None,
        )
        if sheet_meta is None:
            return
        props = sheet_meta["properties"]
        body = {
            "requests": [
                {
                    "setBasicFilter": {
                        "filter": {
                            "range": {
                                "sheetId": props["sheetId"],
                                "startRowIndex": 0,
                                "endRowIndex": props["gridProperties"]["rowCount"],
                                "startColumnIndex": 0,
                                "endColumnIndex": props["gridProperties"]["columnCount"],
                            }
                        }
                    }
                }
            ]
        }
        self._svc.spreadsheets().batchUpdate(
            spreadsheetId=self.spreadsheet_id, body=body
        ).execute()

    def read_config(self, sheet: str = "config") -> list[dict]:
        values = self.get_values(f"{sheet}!A1:Z")
        if not values:
            return []
        header, *rows = values
        return [dict(zip(header, r + [""] * (len(header) - len(r)))) for r in rows]
