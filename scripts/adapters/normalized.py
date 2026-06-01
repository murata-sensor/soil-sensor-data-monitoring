"""Normalized row shared by all data-source adapters (SPEC.md §4.1)."""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass
class NormalizedRow:
    ts: str | None = None              # ISO-8601 with offset (Asia/Tokyo)
    device_id: str | None = None
    temperature_c: float | None = None
    vwc_pct: float | None = None
    vwc_coco_pct: float | None = None
    vwc_rock_pct: float | None = None
    ec_bulk_dsm: float | None = None
    ec_pore_dsm: float | None = None
    ec_pore_coco_dsm: float | None = None
    battery_v: float | None = None
    battery_pct: float | None = None
    error_flag: float | None = None
    rssi_dbm: float | None = None
    air_temp_c: float | None = None
    precip_1h_mm: float | None = None
    sunshine_1h_h: float | None = None

    def as_dict(self) -> dict:
        return asdict(self)


def to_float(v) -> float | None:
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    if f != f:  # NaN
        return None
    return f
