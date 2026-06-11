"""Remote FTP data-source adapter (SPEC §4.2, remote-ftp).

Reads the published `sensor_raw` / `sensor_9am` schema produced by
`scripts.sensor_parser.to_published`:
    date, siteId, addr, number, battery1, battery2, bulk_ec, vwc, soil_temp
"""

from __future__ import annotations

from .normalized import NormalizedRow, to_float

KEY = "remote-ftp"

HEADER_MAP = {
    "date": "ts",
    "addr": "device_id",
    "battery1": "battery_v",
    "battery1[V]": "battery_v",
    "bulk_ec": "ec_bulk_dsm",
    "bulk_ec[dS/m]": "ec_bulk_dsm",
    "vwc": "vwc_pct",
    "vwc[%]": "vwc_pct",
    "soil_temp": "temperature_c",
}

STRING_FIELDS = {"ts", "device_id"}


def to_normalized(values: list[list[str]]) -> list[NormalizedRow]:
    if not values:
        return []
    header = values[0]
    idx = {name: i for i, name in enumerate(header) if name in HEADER_MAP}
    out: list[NormalizedRow] = []
    for row in values[1:]:
        if not row:
            continue
        row_obj = NormalizedRow()
        for raw_name, col in idx.items():
            field = HEADER_MAP[raw_name]
            cell = row[col] if col < len(row) else ""
            if field in STRING_FIELDS:
                setattr(row_obj, field, (str(cell).strip() or None))
            else:
                setattr(row_obj, field, to_float(cell))
        if row_obj.ts is None and row_obj.device_id is None:
            continue
        out.append(row_obj)
    return out
