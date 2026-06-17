import type { SchemaType } from "./adapters";

export type Role = "admin" | "viewer";

export interface UserRow {
  email: string;
  role: Role;
  enabled: boolean;
}

export interface AclRow {
  email: string;
  sourceId: string;            // "*" allows all sources
  permission: "read";
}

export type AccessMode = "direct" | "proxy";

export interface SourceRow {
  sourceId: string;
  displayName: string;
  schemaType: SchemaType;
  spreadsheetId: string;
  sheetName: string;
  headerRow: number;
  siteId: string;
  tz: string;
  accessMode: AccessMode;
  enabled: boolean;
  notes?: string;
}

export interface EventRow {
  date: string;
  label: string;
  color?: string;
  /** If set, show only on panels for this specific deviceId. Omit for global (all devices). */
  deviceId?: string;
}

export type Metric =
  | "vwc_pct"
  | "vwc_coco_pct"
  | "vwc_rock_pct"
  | "ec_bulk_dsm"
  | "ec_pore_dsm"
  | "ec_pore_coco_dsm"
  | "temperature_c"
  | "battery_v"
  | "battery_pct"
  | "rssi_dbm"
  | "error_flag"
  | "air_temp_c"
  | "precip_1h_mm"
  | "sunshine_1h_h";

export interface ThemePanel {
  id: string;
  title: string;
  metric: Metric;
  x: number; y: number; w: number; h: number;
  yMin?: number; yMax?: number;
  showPoints?: boolean;
}

export interface Theme {
  themeId: string;
  bg: string;
  surface: string;
  text: string;
  accent: string;
  chartColors: string[];
  panels: ThemePanel[];
}

export const DEFAULT_THEME: Theme = {
  themeId: "default",
  bg: "#f8fafc",
  surface: "#ffffff",
  text: "#0f172a",
  accent: "#0ea5e9",
  chartColors: ["#0ea5e9", "#22c55e", "#eab308", "#ef4444", "#a855f7", "#14b8a6"],
  panels: [
    { id: "vwc",   title: "VWC (体積含水率 %)", metric: "vwc_pct",       x: 0, y: 0,  w: 12, h: 4 },
    { id: "bec",   title: "Bulk EC",            metric: "ec_bulk_dsm",   x: 0, y: 4,  w: 12, h: 4 },
    { id: "temp",  title: "土壌温度",           metric: "temperature_c", x: 0, y: 8,  w: 6,  h: 3 },
    { id: "bat",   title: "バッテリー電圧",     metric: "battery_v",     x: 6, y: 8,  w: 6,  h: 3 },
  ],
};

export const SCHEMA_EXTRA_PANELS: Record<SchemaType, ThemePanel[]> = {
  "m5stack": [
    { id: "rssi",  title: "WiFi RSSI (dBm)", metric: "rssi_dbm",   x: 0, y: 11, w: 6, h: 3 },
    { id: "err",   title: "Error flag",      metric: "error_flag", x: 6, y: 11, w: 6, h: 3 },
  ],
  "mechatrax": [
    { id: "airt",  title: "外気温 (AMeDAS)",     metric: "air_temp_c",    x: 0, y: 11, w: 4, h: 3 },
    { id: "prec",  title: "1h 降水量 (AMeDAS)",  metric: "precip_1h_mm",  x: 4, y: 11, w: 4, h: 3 },
    { id: "sun",   title: "1h 日照 (AMeDAS)",    metric: "sunshine_1h_h", x: 8, y: 11, w: 4, h: 3 },
    { id: "batp",  title: "バッテリー残量 (%)",  metric: "battery_pct",   x: 0, y: 14, w: 12, h: 3 },
  ],
  "remote-ftp": [],
};
