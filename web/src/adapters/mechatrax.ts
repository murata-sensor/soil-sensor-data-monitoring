import { NormalizedRow, NumericField, toFloat } from "./normalized";

export const KEY = "mechatrax" as const;

/**
 * Sensitive columns (GPS, MCC/MNC/cellId, loc_*_id) are deliberately omitted
 * so they are never surfaced to the frontend.
 */
export const HEADER_MAP: Record<string, keyof NormalizedRow | "__battery_voltage_mv"> = {
  "Date": "ts",
  "SerialNumber": "deviceId",
  // Battery
  "Battery残量(%)": "battery_pct",
  "Battery残量（%）": "battery_pct",
  "Battery_percentage(%)": "battery_pct",
  "Battery_voltage(mV)": "__battery_voltage_mv",
  "Battery_voltage（mV）": "__battery_voltage_mv",
  // Soil sensor
  "Temperature(degC)": "temperature_c",
  "Temperature（degC）": "temperature_c",
  "VWC(%)": "vwc_pct",
  "VWC（%）": "vwc_pct",
  "VWC_coco(%)": "vwc_coco_pct",
  "VWC_coco（%）": "vwc_coco_pct",
  "VWC_rock(%)": "vwc_rock_pct",
  "VWC_rock（%）": "vwc_rock_pct",
  "EC bulk(dS/m)": "ec_bulk_dsm",
  "EC bulk（dS/m）": "ec_bulk_dsm",
  "EC_pore(dS/m)": "ec_pore_dsm",
  "EC_pore（dS/m）": "ec_pore_dsm",
  "EC_porecoco(dS/m)": "ec_pore_coco_dsm",
  "EC_porecoco（dS/m）": "ec_pore_coco_dsm",
  // Weather (Japanese headers)
  "外気温": "air_temp_c",
  "1hの降水量": "precip_1h_mm",
  "1hの日照時間": "sunshine_1h_h",
  // Weather (English headers)
  "locTemp": "air_temp_c",
  "locPrec": "precip_1h_mm",
  "locSun": "sunshine_1h_h",
};

const STRING_FIELDS = new Set<keyof NormalizedRow>(["ts", "deviceId"]);

export function toNormalized(values: string[][]): NormalizedRow[] {
  if (!values.length) return [];
  const header = values[0];
  const idx: { col: number; field: keyof NormalizedRow | "__battery_voltage_mv" }[] = [];
  header.forEach((name, col) => {
    const trimmed = (name ?? "").trim();
    const field = HEADER_MAP[trimmed];
    if (field) idx.push({ col, field });
  });
  const out: NormalizedRow[] = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (!row || row.length === 0) continue;
    const obj: NormalizedRow = {};
    for (const { col, field } of idx) {
      const cell = col < row.length ? row[col] : "";
      if (field === "__battery_voltage_mv") {
        const mv = toFloat(cell);
        if (mv !== undefined) obj.battery_v = mv / 1000;
        continue;
      }
      if (STRING_FIELDS.has(field)) {
        const s = String(cell ?? "").trim();
        if (s) (obj as Record<string, unknown>)[field] = s;
      } else {
        const n = toFloat(cell);
        if (n !== undefined) (obj as Record<string, unknown>)[field as NumericField] = n;
      }
    }
    if (obj.ts === undefined && obj.deviceId === undefined) continue;
    out.push(obj);
  }
  return out;
}
