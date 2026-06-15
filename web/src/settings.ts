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

export interface UserSettings {
  dateRange: DateRange;
  panelSettings: Record<string, PanelSettings>; // keyed by panel id
  layout: LayoutItem[] | null; // null = use default
  deviceColors: DeviceColorMap;
  ftpSheetName: FtpSheetName;
  showAirTemperature: boolean;
  showEventLabels: boolean;
}

const DEFAULT_SETTINGS: UserSettings = {
  dateRange: { type: "last7d" },
  panelSettings: {},
  layout: null,
  deviceColors: {},
  ftpSheetName: "sensor_raw",
  showAirTemperature: false,
  showEventLabels: true,
};

function storageKey(email: string): string {
  return `soil-sensor-settings-${email.toLowerCase()}`;
}

export function loadSettings(email: string): UserSettings {
  try {
    const raw = localStorage.getItem(storageKey(email));
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(email: string, settings: UserSettings): void {
  localStorage.setItem(storageKey(email), JSON.stringify(settings));
}

/** Compute the start timestamp (ms) for a given DateRange relative to now. */
export function dateRangeToMs(range: DateRange): { start: number; end: number } | null {
  const now = Date.now();
  switch (range.type) {
    case "last24h": return { start: now - 24 * 60 * 60 * 1000, end: now };
    case "last3d": return { start: now - 3 * 24 * 60 * 60 * 1000, end: now };
    case "last7d": return { start: now - 7 * 24 * 60 * 60 * 1000, end: now };
    case "last30d": return { start: now - 30 * 24 * 60 * 60 * 1000, end: now };
    case "all": return null;
    case "custom": {
      const s = range.start ? new Date(range.start).getTime() : now - 7 * 24 * 60 * 60 * 1000;
      const e = range.end ? new Date(range.end).getTime() : now;
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
