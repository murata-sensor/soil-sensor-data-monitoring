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

export type SubstrateType = "soil" | "rockwool" | "cocopeat" | "all";

export const SUBSTRATE_OPTIONS: { value: SubstrateType; label: string }[] = [
  { value: "soil", label: "一般土壌" },
  { value: "rockwool", label: "ロックウール" },
  { value: "cocopeat", label: "ココピート" },
  { value: "all", label: "全て表示" },
];

export interface ThemePanel {
  id: string;
  title: string;
  metric: Metric;
  /** When set, plot multiple metrics on the same chart (overrides single `metric` for dataset building). */
  metrics?: Metric[];
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
    { id: "airt",  title: "外気温 (AMeDAS)",     metric: "air_temp_c",    x: 0, y: 11, w: 12, h: 3 },
    { id: "prec",  title: "1h 降水量 (AMeDAS)",  metric: "precip_1h_mm",  x: 0, y: 14, w: 12, h: 3 },
    { id: "sun",   title: "1h 日照 (AMeDAS)",    metric: "sunshine_1h_h", x: 0, y: 17, w: 12, h: 3 },
    { id: "batp",  title: "バッテリー残量 (%)",  metric: "battery_pct",   x: 0, y: 20, w: 12, h: 3 },
  ],
  "remote-ftp": [],
};

/**
 * Generate panels for M5Stack/Mechatrax based on substrate type.
 */
export function getPanelsForSubstrate(schemaType: SchemaType, substrate: SubstrateType): ThemePanel[] {
  if (schemaType === "remote-ftp") return [];

  const soilPanels: ThemePanel[] = (() => {
    switch (substrate) {
      case "soil":
        return [
          { id: "vwc",  title: "VWC (体積含水率 %)", metric: "vwc_pct",       x: 0, y: 0, w: 12, h: 4 },
          { id: "bec",  title: "Bulk EC (dS/m)",     metric: "ec_bulk_dsm",   x: 0, y: 4, w: 12, h: 4 },
          { id: "pec",  title: "Pore EC (dS/m)",     metric: "ec_pore_dsm",   x: 0, y: 8, w: 12, h: 4 },
          { id: "temp", title: "土壌温度 (℃)",       metric: "temperature_c", x: 0, y: 12, w: 12, h: 4 },
        ];
      case "rockwool":
        return [
          { id: "vwc_rock", title: "VWC ロックウール (%)", metric: "vwc_rock_pct",   x: 0, y: 0, w: 12, h: 4 },
          { id: "bec",      title: "Bulk EC (dS/m)",       metric: "ec_bulk_dsm",    x: 0, y: 4, w: 12, h: 4 },
          { id: "temp",     title: "土壌温度 (℃)",         metric: "temperature_c",  x: 0, y: 8, w: 12, h: 4 },
        ];
      case "cocopeat":
        return [
          { id: "vwc_coco", title: "VWC ココピート (%)",    metric: "vwc_coco_pct",      x: 0, y: 0, w: 12, h: 4 },
          { id: "pec_coco", title: "Pore EC ココピート (dS/m)", metric: "ec_pore_coco_dsm", x: 0, y: 4, w: 12, h: 4 },
          { id: "temp",     title: "土壌温度 (℃)",          metric: "temperature_c",     x: 0, y: 8, w: 12, h: 4 },
        ];
      case "all":
        return [
          { id: "vwc_all", title: "VWC 全種 (%)", metric: "vwc_pct", metrics: ["vwc_pct", "vwc_rock_pct", "vwc_coco_pct"], x: 0, y: 0, w: 12, h: 4 },
          { id: "ec_all",  title: "EC 全種 (dS/m)", metric: "ec_bulk_dsm", metrics: ["ec_bulk_dsm", "ec_pore_dsm", "ec_pore_coco_dsm"], x: 0, y: 4, w: 12, h: 4 },
          { id: "temp",    title: "土壌温度 (℃)", metric: "temperature_c", x: 0, y: 8, w: 12, h: 4 },
        ];
    }
  })();

  // Additional panels by schema type
  const extraPanels: ThemePanel[] = (() => {
    const baseY = soilPanels.reduce((max, p) => Math.max(max, p.y + p.h), 0);
    if (schemaType === "m5stack") {
      return [
        { id: "bat",  title: "バッテリー電圧 (V)", metric: "battery_v",  x: 0, y: baseY, w: 12, h: 4 },
      ];
    }
    if (schemaType === "mechatrax") {
      return [
        { id: "batp", title: "バッテリー残量 (%)",  metric: "battery_pct",   x: 0, y: baseY,      w: 12, h: 4 },
        { id: "airt", title: "外気温 (AMeDAS)",     metric: "air_temp_c",    x: 0, y: baseY + 4,  w: 12, h: 4 },
        { id: "prec", title: "1h 降水量 (AMeDAS)",  metric: "precip_1h_mm",  x: 0, y: baseY + 8,  w: 12, h: 4 },
        { id: "sun",  title: "1h 日照 (AMeDAS)",    metric: "sunshine_1h_h", x: 0, y: baseY + 12, w: 12, h: 4 },
      ];
    }
    return [];
  })();

  return [...soilPanels, ...extraPanels];
}
