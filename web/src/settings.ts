import type { EventRow, SubstrateType } from "./types";
import type { TextPanelConfig } from "./layoutConfig";
import { isFiniteNumber, isMetric, isNonEmptyString, isPosition, isRecord, isString, readFontSize } from "./configValidation";

/**
 * Per-user dashboard settings persisted in localStorage.
 */

export type DateRangeType = "last24h" | "last3d" | "last7d" | "last30d" | "all" | "custom";

export interface DateRange {
  type: DateRangeType;
  start?: string; // ISO date for "custom"
  end?: string;
}

export interface PanelSettings {
  yMin?: number;
  yMax?: number;
  yLabel?: string;
  showPoints?: boolean;
}

export interface LayoutItem {
  i: string; // panel id
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DeviceColorMap {
  [deviceId: string]: string;
}

export type FtpSheetName = string;

export interface LayoutPreset {
  id: string;
  name: string;
  createdAt: string; // ISO string
  layout: LayoutItem[] | null;
  sourceId: string | null;
  ftpSheetName: FtpSheetName;
  substrateTypes: Record<string, SubstrateType>;
  dateRange: DateRange;
  panelSettings: Record<string, PanelSettings>;
  deviceColors: DeviceColorMap;
}

export interface UserSettings {
  dateRange: DateRange;
  panelSettings: Record<string, PanelSettings>; // keyed by panel id
  /** Grid layout per source id. A missing entry means "use the schema default". */
  layoutsBySource: Record<string, LayoutItem[]>;
  deviceColors: DeviceColorMap;
  ftpSheetName: FtpSheetName;
  showAirTemperature: boolean;
  showPrecipitation: boolean;
  showSunshine: boolean;
  showEventLabels: boolean;
  /** Substrate type per source (keyed by sourceId). */
  substrateTypes: Record<string, SubstrateType>;
  /** Last selected data source. */
  selectedSourceId: string | null;
  /** Saved layout presets. */
  savedPresets: LayoutPreset[];
  /** Custom overall background color. */
  bgColor?: string;
  /** Custom chart/panel background color. */
  chartBgColor?: string;
  /** User-added events (shown alongside spreadsheet events). */
  localEvents?: EventRow[];
  /** Content overrides for existing text panels (keyed by panel id). */
  textOverrides?: Record<string, string>;
  /** User-created text panels added to the layout. */
  userTextPanels?: import("./layoutConfig").TextPanelConfig[];
  /** User-created chart panels added to the layout. */
  userChartPanels?: UserChartPanel[];
}

/** A user-created chart panel stored in settings. Works for both normal and custom layouts. */
export interface UserChartPanel {
  id: string;
  title: string;
  metric: import("./types").Metric;
  x: number;
  y: number;
  w: number;
  h: number;
  yMin?: number;
  yMax?: number;
}

function createDefaultSettings(): UserSettings {
  return {
    dateRange: { type: "last7d" },
    panelSettings: {},
    layoutsBySource: {},
    deviceColors: {},
    ftpSheetName: "sensor_raw",
    showAirTemperature: false,
    showPrecipitation: false,
    showSunshine: false,
    showEventLabels: true,
    substrateTypes: {},
    selectedSourceId: null,
    savedPresets: [],
    localEvents: [],
    textOverrides: {},
    userTextPanels: [],
    userChartPanels: [],
  };
}

function storageKey(email: string): string {
  return `soil-sensor-settings-${email.toLowerCase()}`;
}

function readMap<T>(value: unknown, read: (entry: unknown) => T | undefined): Record<string, T> {
  const entries = isRecord(value) ? Object.entries(value) : [];
  return Object.fromEntries(entries.flatMap(([key, entry]) => {
    const parsed = read(entry);
    return parsed === undefined ? [] : [[key, parsed]];
  }));
}

function readList<T>(value: unknown, read: (entry: unknown) => T | undefined): T[] {
  return Array.isArray(value) ? value.flatMap((entry) => {
    const parsed = read(entry);
    return parsed === undefined ? [] : [parsed];
  }) : [];
}

function readString(value: unknown): string | undefined {
  return isString(value) ? value : undefined;
}

function readSubstrate(value: unknown): SubstrateType | undefined {
  return value === "soil" || value === "rockwool" || value === "cocopeat" || value === "all" ? value : undefined;
}

function readLayout(value: unknown): LayoutItem[] | undefined {
  const items = readList(value, (entry): LayoutItem | undefined =>
    isRecord(entry) && isNonEmptyString(entry.i) && isPosition(entry)
      ? { i: entry.i, x: entry.x, y: entry.y, w: entry.w, h: entry.h } : undefined);
  return items.length ? items : undefined;
}

function readPanelSettings(value: unknown): PanelSettings | undefined {
  if (!isRecord(value)) return undefined;
  return {
    yMin: isFiniteNumber(value.yMin) ? value.yMin : undefined,
    yMax: isFiniteNumber(value.yMax) ? value.yMax : undefined,
    yLabel: readString(value.yLabel),
    showPoints: typeof value.showPoints === "boolean" ? value.showPoints : undefined,
  };
}

function readChartPanel(value: unknown): UserChartPanel | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isString(value.title)
    || !isMetric(value.metric) || !isPosition(value)) return undefined;
  return {
    id: value.id, title: value.title, metric: value.metric,
    x: value.x, y: value.y, w: value.w, h: value.h,
    yMin: isFiniteNumber(value.yMin) ? value.yMin : undefined,
    yMax: isFiniteNumber(value.yMax) ? value.yMax : undefined,
  };
}

function readTextPanel(value: unknown): TextPanelConfig | undefined {
  if (!isRecord(value) || value.type !== "text" || !isNonEmptyString(value.id) || !isPosition(value.position)) return undefined;
  const { x, y, w, h } = value.position;
  return {
    type: "text", id: value.id, position: { x, y, w, h },
    content: readString(value.content), fontSize: readFontSize(value.fontSize),
    align: value.align === "left" || value.align === "center" || value.align === "right" ? value.align : undefined,
    contentRef: isFiniteNumber(value.contentRef) && Number.isInteger(value.contentRef) && value.contentRef >= 0
      ? value.contentRef : undefined,
  };
}

function readEvent(value: unknown): EventRow | undefined {
  if (!isRecord(value) || !isString(value.date) || !Number.isFinite(parseTs(value.date)) || !isString(value.label)) return undefined;
  return {
    date: value.date, label: value.label, color: readString(value.color), deviceId: readString(value.deviceId),
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
  };
}

/** Fields shared by the dashboard and saved presets use the same validation. */
function readDisplaySettings(value: Record<string, unknown>) {
  return {
    dateRange: isDateRange(value.dateRange) ? value.dateRange : { type: "last7d" as const },
    panelSettings: readMap(value.panelSettings, readPanelSettings),
    deviceColors: readMap(value.deviceColors, readString),
    substrateTypes: readMap(value.substrateTypes, readSubstrate),
    ftpSheetName: isNonEmptyString(value.ftpSheetName) ? value.ftpSheetName : "sensor_raw",
  };
}

function readPreset(value: unknown): LayoutPreset | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isString(value.name)
    || !isString(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt))) return undefined;
  return {
    id: value.id, name: value.name, createdAt: value.createdAt,
    sourceId: isNonEmptyString(value.sourceId) ? value.sourceId : null,
    layout: readLayout(value.layout) ?? null,
    ...readDisplaySettings(value),
  };
}

/**
 * Moves the single shared layout of the old format under the source it was
 * last used with, so it no longer leaks into every other source.
 */
function migrate(settings: UserSettings, legacyLayout: unknown): UserSettings {
  const layout = readLayout(legacyLayout);
  const sourceId = settings.selectedSourceId;
  if (!layout || !sourceId || Object.hasOwn(settings.layoutsBySource, sourceId)) {
    return settings;
  }
  return {
    ...settings,
    layoutsBySource: { ...settings.layoutsBySource, [sourceId]: layout },
  };
}

/** Dictionary lookups must not return inherited properties such as toString. */
export function getOwnValue<T>(values: Record<string, T> | undefined, key: string): T | undefined {
  return values && Object.hasOwn(values, key) ? values[key] : undefined;
}

/** Replaces one source's layout, or drops it when `layout` is null/empty. */
export function withSourceLayout(
  layoutsBySource: Record<string, LayoutItem[]>,
  sourceId: string | null,
  layout: LayoutItem[] | null,
): Record<string, LayoutItem[]> {
  if (!sourceId) return layoutsBySource;
  if (layout?.length) return { ...layoutsBySource, [sourceId]: layout };
  const next = { ...layoutsBySource };
  delete next[sourceId];
  return next;
}

export function loadSettings(email: string): UserSettings {
  const defaults = createDefaultSettings();
  try {
    const raw = localStorage.getItem(storageKey(email));
    if (!raw) return defaults;
    const stored: unknown = JSON.parse(raw);
    if (!isRecord(stored)) return defaults;
    const settings: UserSettings = {
      ...defaults, ...readDisplaySettings(stored),
      layoutsBySource: readMap(stored.layoutsBySource, readLayout),
      selectedSourceId: isNonEmptyString(stored.selectedSourceId) ? stored.selectedSourceId : null,
      showAirTemperature: typeof stored.showAirTemperature === "boolean" ? stored.showAirTemperature : defaults.showAirTemperature,
      showPrecipitation: typeof stored.showPrecipitation === "boolean" ? stored.showPrecipitation : defaults.showPrecipitation,
      showSunshine: typeof stored.showSunshine === "boolean" ? stored.showSunshine : defaults.showSunshine,
      showEventLabels: typeof stored.showEventLabels === "boolean" ? stored.showEventLabels : defaults.showEventLabels,
      bgColor: readString(stored.bgColor), chartBgColor: readString(stored.chartBgColor),
      localEvents: readList(stored.localEvents, readEvent), textOverrides: readMap(stored.textOverrides, readString),
      userTextPanels: readList(stored.userTextPanels, readTextPanel),
      userChartPanels: readList(stored.userChartPanels, readChartPanel), savedPresets: readList(stored.savedPresets, readPreset),
    };
    return migrate(settings, stored.layout);
  } catch {
    return defaults;
  }
}

export function saveSettings(email: string, settings: UserSettings): void {
  localStorage.setItem(storageKey(email), JSON.stringify(settings));
}

function isDateRange(value: unknown, now = Date.now()): value is DateRange {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const range = value as Record<string, unknown>;
  if (typeof range.type !== "string"
      || !["last24h", "last3d", "last7d", "last30d", "all", "custom"].includes(range.type)) return false;
  if (range.type !== "custom") return true;
  const { start, end } = range;
  if ((start !== undefined && typeof start !== "string")
      || (end !== undefined && typeof end !== "string")) return false;
  const startMs = start ? new Date(start).getTime() : now - 7 * 24 * 60 * 60 * 1000;
  const endMs = end ? new Date(end).getTime() : now;
  return Number.isFinite(startMs) && Number.isFinite(endMs) && startMs <= endMs;
}

/** Compute the start timestamp (ms) for a given DateRange relative to now. */
export function dateRangeToMs(range: DateRange): { start: number; end: number } | null {
  const now = Date.now();
  const safeRange: DateRange = isDateRange(range, now) ? range : { type: "last7d" };
  switch (safeRange.type) {
    case "last24h": return { start: now - 24 * 60 * 60 * 1000, end: now };
    case "last3d": return { start: now - 3 * 24 * 60 * 60 * 1000, end: now };
    case "last7d": return { start: now - 7 * 24 * 60 * 60 * 1000, end: now };
    case "last30d": return { start: now - 30 * 24 * 60 * 60 * 1000, end: now };
    case "all": return null;
    case "custom": {
      const s = safeRange.start ? new Date(safeRange.start).getTime() : now - 7 * 24 * 60 * 60 * 1000;
      const e = safeRange.end ? new Date(safeRange.end).getTime() : now;
      return { start: s, end: e };
    }
    default: return null;
  }
}

/** Parse a timestamp string (possibly with space instead of T) to epoch ms. */
export function parseTs(ts: string): number {
  // Replace first space with T if it looks like "YYYY-MM-DD HH:..."
  const normalized = ts.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:)/, "$1T$2");
  const ms = new Date(normalized).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}
