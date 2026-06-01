"""M5Stack data-source adapter (SPEC §4.2, m5stack)."""

from __future__ import annotations

from .normalized import NormalizedRow, to_float

KEY = "m5stack"

# raw header -> NormalizedRow field
HEADER_MAP = {
    "Date": "ts",
    "SerialNumber": "device_id",
    "Battery(V)": "battery_v",
    "Temperature(degC)": "temperature_c",
    "VWC(%)": "vwc_pct",
    "VWC Coconut Peat(%)": "vwc_coco_pct",
    "VWC Rock Wool(%)": "vwc_rock_pct",
    "EC bulk(dS/m)": "ec_bulk_dsm",
    "EC pore(dS/m)": "ec_pore_dsm",
    "EC pore Coco(dS/m)": "ec_pore_coco_dsm",
    "Error flag": "error_flag",
    "WiFi RSI(dBm)": "rssi_dbm",
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
            value: object
            if field in STRING_FIELDS:
                value = (str(cell).strip() or None)
            else:
                value = to_float(cell)
            setattr(row_obj, field, value)
        if row_obj.ts is None and row_obj.device_id is None:
            continue
        out.append(row_obj)
    return out
