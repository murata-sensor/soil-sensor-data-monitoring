"""Schema adapters that normalize per-source spreadsheet rows.

Each adapter exposes:
    KEY: str                           — schema identifier (matches sources.schemaType)
    HEADER_MAP: dict[str, str]         — raw header -> NormalizedRow attribute
    to_normalized(values: list[list[str]]) -> list[NormalizedRow]

`values` is the raw 2D array returned by Sheets API `values.get`:
the first row is the header row; subsequent rows are data.
"""

from __future__ import annotations

from . import m5stack, mechatrax, remote_ftp
from .normalized import NormalizedRow

ADAPTERS = {
    m5stack.KEY: m5stack,
    mechatrax.KEY: mechatrax,
    remote_ftp.KEY: remote_ftp,
}


def to_normalized(schema_type: str, values: list[list[str]]) -> list[NormalizedRow]:
    if schema_type not in ADAPTERS:
        raise ValueError(f"unknown schemaType: {schema_type}")
    return ADAPTERS[schema_type].to_normalized(values)


__all__ = ["ADAPTERS", "NormalizedRow", "to_normalized"]
