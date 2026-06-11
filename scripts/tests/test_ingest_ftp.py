from __future__ import annotations

import pandas as pd

from scripts.ingest_ftp import _filter_rows_newer_than_last


def test_filter_rows_newer_than_last_handles_empty_published_with_tz_aware_last():
    published = pd.DataFrame(columns=["date", "siteId"])
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
            "siteId": ["site-a", "site-a", "site-a"],
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
            "siteId": ["site-a", "site-a"],
        }
    )

    out = _filter_rows_newer_than_last(published, "2026-06-11 08:59:41")

    assert len(out) == 1
    assert out.iloc[0]["date"] == "2026-06-11 09:00:00+09:00"
