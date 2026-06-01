/**
 * Normalized data row shared across all data-source schema adapters
 * (matches Python `scripts/adapters/normalized.py`).
 *
 * All numeric fields are optional. Adapters set only what the underlying
 * sheet contains; missing or non-numeric cells become `undefined`.
 */
export interface NormalizedRow {
  ts?: string;                    // ISO-8601 with offset (Asia/Tokyo)
  deviceId?: string;
  temperature_c?: number;
  vwc_pct?: number;
  vwc_coco_pct?: number;
  vwc_rock_pct?: number;
  ec_bulk_dsm?: number;
  ec_pore_dsm?: number;
  ec_pore_coco_dsm?: number;
  battery_v?: number;
  battery_pct?: number;
  error_flag?: number;
  rssi_dbm?: number;
  air_temp_c?: number;
  precip_1h_mm?: number;
  sunshine_1h_h?: number;
}

export type NormalizedField = keyof NormalizedRow;
export type NumericField = Exclude<NormalizedField, "ts" | "deviceId">;

export const NUMERIC_FIELDS: readonly NumericField[] = [
  "temperature_c", "vwc_pct", "vwc_coco_pct", "vwc_rock_pct",
  "ec_bulk_dsm", "ec_pore_dsm", "ec_pore_coco_dsm",
  "battery_v", "battery_pct", "error_flag", "rssi_dbm",
  "air_temp_c", "precip_1h_mm", "sunshine_1h_h",
];

export function toFloat(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  return n;
}
