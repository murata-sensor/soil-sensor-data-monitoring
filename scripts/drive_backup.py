"""Upload raw CSV files to a Google Drive folder (optional backup)."""

from __future__ import annotations

import io
import os
from typing import Iterable

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

SCOPES = ["https://www.googleapis.com/auth/drive.file"]


def is_enabled() -> bool:
    return bool(os.environ.get("DRIVE_BACKUP_FOLDER_ID"))


def _service():
    import json
    raw = os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"]
    creds = Credentials.from_service_account_info(json.loads(raw), scopes=SCOPES)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def upload(name: str, data: bytes) -> str:
    """Upload bytes as a CSV file. Returns the Drive file ID."""
    svc = _service()
    folder_id = os.environ["DRIVE_BACKUP_FOLDER_ID"]
    media = MediaIoBaseUpload(io.BytesIO(data), mimetype="text/csv", resumable=False)
    file = svc.files().create(
        body={"name": name, "parents": [folder_id]},
        media_body=media,
        fields="id",
        supportsAllDrives=True,
    ).execute()
    return file["id"]


def upload_many(items: Iterable[tuple[str, bytes]]) -> list[str]:
    return [upload(name, data) for name, data in items]
