import { NormalizedRow, NumericField, toFloat } from "./normalized";

export const KEY = "m5stack" as const;

/** Raw header name -> NormalizedRow key. */
export const HEADER_MAP: Record<string, keyof NormalizedRow> = {
  "Date": "ts",
  "SerialNumber": "deviceId",
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
};

const STRING_FIELDS = new Set<keyof NormalizedRow>(["ts", "deviceId"]);

export function toNormalized(values: string[][]): NormalizedRow[] {
  if (!values.length) return [];
  const header = values[0];
  const idx: { col: number; field: keyof NormalizedRow }[] = [];
  header.forEach((name, col) => {
    const field = HEADER_MAP[name];
    if (field) idx.push({ col, field });
  });
  const out: NormalizedRow[] = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (!row || row.length === 0) continue;
    const obj: NormalizedRow = {};
    for (const { col, field } of idx) {
      const cell = col < row.length ? row[col] : "";
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
