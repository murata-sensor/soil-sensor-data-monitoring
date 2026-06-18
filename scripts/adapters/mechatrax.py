"""Mechatrax Raspberry-Pi data-source adapter (SPEC §4.2, mechatrax).

Notes:
- Sensitive columns (`座標(latitude,longitude)`, `MCC`, `MNC`, `area code`,
  `cell id`, `loc_accuracy`, `locTemp_id`, `locPrec_id`, `locSun_id`) are
  deliberately NOT mapped to the normalized model and never surfaced.
"""

from __future__ import annotations

from .normalized import NormalizedRow, to_float

KEY = "mechatrax"

HEADER_MAP = {
    "Date": "ts",
    "SerialNumber": "device_id",
    # Battery
    "Battery残量(%)": "battery_pct",
    "Battery_percentage(%)": "battery_pct",
    "Battery_voltage(mV)": "_battery_voltage_mv",  # special: convert mV -> V
    # Soil sensor
    "Temperature(degC)": "temperature_c",
    "VWC(%)": "vwc_pct",
    "VWC_coco(%)": "vwc_coco_pct",
    "VWC_rock(%)": "vwc_rock_pct",
    "EC bulk(dS/m)": "ec_bulk_dsm",
    "EC_pore(dS/m)": "ec_pore_dsm",
    "EC_porecoco(dS/m)": "ec_pore_coco_dsm",
    # Weather (Japanese headers)
    "外気温": "air_temp_c",
    "1hの降水量": "precip_1h_mm",
    "1hの日照時間": "sunshine_1h_h",
    # Weather (English headers)
    "locTemp": "air_temp_c",
    "locPrec": "precip_1h_mm",
    "locSun": "sunshine_1h_h",
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
            if field == "_battery_voltage_mv":
                mv = to_float(cell)
                row_obj.battery_v = (mv / 1000.0) if mv is not None else None
                continue
            if field in STRING_FIELDS:
                setattr(row_obj, field, (str(cell).strip() or None))
            else:
                setattr(row_obj, field, to_float(cell))
        if row_obj.ts is None and row_obj.device_id is None:
            continue
        out.append(row_obj)
    return out
