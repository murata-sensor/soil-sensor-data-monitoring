import { NormalizedRow, NumericField, toFloat } from "./normalized";

export const KEY = "remote-ftp" as const;

/** Maps the published `sensor_raw` / `sensor_9am` columns to the normalized model. */
export const HEADER_MAP: Record<string, keyof NormalizedRow> = {
  "date": "ts",
  "addr": "deviceId",
  "battery1": "battery_v",
  "bulk_ec": "ec_bulk_dsm",
  "vwc": "vwc_pct",
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
