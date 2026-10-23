import type { LayoutConfig, LayoutPanel, PanelPosition } from "./layoutConfig";
import type { Metric, Theme, ThemePanel } from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNonEmptyString(value: unknown): value is string {
  return isString(value) && !!value.trim();
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// Grid compaction walks rows one at a time; bound work as well as number size.
const MAX_GRID_VALUE = 10000;

export function isGridValue(value: unknown, minimum: number): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= minimum && value <= MAX_GRID_VALUE;
}

export function isPosition(value: unknown): value is PanelPosition {
  return isRecord(value) && isGridValue(value.x, 0) && isGridValue(value.y, 0)
    && isGridValue(value.w, 1) && isGridValue(value.h, 1);
}

const METRICS: Record<Metric, true> = {
  vwc_pct: true, vwc_coco_pct: true, vwc_rock_pct: true,
  ec_bulk_dsm: true, ec_pore_dsm: true, ec_pore_coco_dsm: true,
  temperature_c: true, battery_v: true, battery_pct: true, rssi_dbm: true, error_flag: true,
  air_temp_c: true, precip_1h_mm: true, sunshine_1h_h: true,
};

export function isMetric(value: unknown): value is Metric {
  return isString(value) && Object.hasOwn(METRICS, value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isReference(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function readString(value: unknown): string | undefined {
  return isString(value) ? value : undefined;
}

/** Older layouts use numeric pixel sizes; normalize without changing their appearance. */
export function readFontSize(value: unknown): string | undefined {
  return isString(value) ? value : isFiniteNumber(value) && value >= 0 ? `${value}px` : undefined;
}

function readNumber(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries: [string, string][] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (isString(entry)) entries.push([key, entry]);
  }
  return Object.fromEntries(entries);
}

function readRanges(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(isFiniteNumber)
    || value[0] > value[1] || value[1] > value[2] || value[2] > value[3] || value[0] >= value[3]
    || !Number.isFinite(value[3] - value[0])) return undefined;
  return [value[0], value[1], value[2], value[3]];
}

/** Keep the first valid occurrence of each panel ID. */
function readPanels<T extends { id: string }>(values: unknown[], read: (value: unknown) => T | null): T[] | null {
  const seen = new Set<string>();
  const panels: T[] = [];
  for (const value of values) {
    const panel = read(value);
    if (!panel || seen.has(panel.id)) continue;
    seen.add(panel.id);
    panels.push(panel);
  }
  return values.length && !panels.length ? null : panels;
}

function readThemePanel(value: unknown, strict = false): ThemePanel | null {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isString(value.title)
    || !isMetric(value.metric) || !isPosition(value)) return null;
  if (value.metrics !== undefined && (!Array.isArray(value.metrics) || !value.metrics.every(isMetric))) return null;
  if (strict && ((value.yMin !== undefined && !isFiniteNumber(value.yMin))
    || (value.yMax !== undefined && !isFiniteNumber(value.yMax))
    || (value.showPoints !== undefined && typeof value.showPoints !== "boolean"))) return null;
  return {
    id: value.id, title: value.title, metric: value.metric,
    metrics: value.metrics as Metric[] | undefined,
    x: value.x, y: value.y, w: value.w, h: value.h,
    yMin: readNumber(value.yMin), yMax: readNumber(value.yMax), showPoints: readBoolean(value.showPoints),
  };
}

export function parseThemeConfig(value: unknown, strict = false): Theme | null {
  if (!isRecord(value) || !isNonEmptyString(value.themeId) || !isString(value.bg)
    || !isString(value.surface) || !isString(value.text) || !isString(value.accent)
    || !isStringArray(value.chartColors) || !Array.isArray(value.panels)) return null;
  const panels = readPanels(value.panels, (panel) => readThemePanel(panel, strict));
  if (!panels || (strict && panels.length !== value.panels.length)) return null;
  return {
    themeId: value.themeId, bg: value.bg, surface: value.surface, text: value.text, accent: value.accent,
    chartColors: [...value.chartColors], panels,
  };
}

/** Saving edits must reject invalid entries instead of silently dropping the user's input. */
export function isThemeConfig(value: unknown): value is Theme {
  return parseThemeConfig(value, true) !== null;
}

function readLayoutPanel(value: unknown): LayoutPanel | null {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isPosition(value.position)) return null;
  const { x, y, w, h } = value.position;
  const base = { id: value.id, position: { x, y, w, h } };
  if (value.type === "chart" || value.type === "gauge") {
    // Reject malformed filters instead of silently broadening the displayed data.
    if (!isString(value.title) || (value.deviceRef !== undefined && !isReference(value.deviceRef))
      || (value.deviceFilter !== undefined && !isStringArray(value.deviceFilter))) return null;
    const deviceRef = isReference(value.deviceRef) ? value.deviceRef : undefined;
    const deviceFilter = isStringArray(value.deviceFilter) ? [...value.deviceFilter] : undefined;
    if (value.type === "gauge") {
      if (value.metric !== undefined && !isMetric(value.metric)) return null;
      return { ...base, type: "gauge", title: value.title, deviceRef, deviceFilter,
        metric: value.metric as Metric | undefined, ranges: readRanges(value.ranges) };
    }
    if (!isMetric(value.metric) || (value.sensorFilter !== undefined && !isStringArray(value.sensorFilter))) return null;
    return {
      ...base, type: "chart", title: value.title, metric: value.metric, deviceRef, deviceFilter,
      sensorFilter: isStringArray(value.sensorFilter) ? [...value.sensorFilter] : undefined,
      groupBy: value.groupBy === "deviceId" || value.groupBy === "sensorNumber" ? value.groupBy : undefined,
      groupLabels: readStringMap(value.groupLabels), groupColors: readStringMap(value.groupColors),
      yMin: readNumber(value.yMin), yMax: readNumber(value.yMax), yLabel: readString(value.yLabel),
      showPoints: readBoolean(value.showPoints), showEvents: readBoolean(value.showEvents),
    };
  }
  if (value.type === "text") {
    return { ...base, type: "text", content: readString(value.content), fontSize: readFontSize(value.fontSize),
      contentRef: isReference(value.contentRef) ? value.contentRef : undefined,
      align: value.align === "left" || value.align === "center" || value.align === "right" ? value.align : undefined };
  }
  if (value.type === "image" && isString(value.src)) {
    return { ...base, type: "image", src: value.src, alt: readString(value.alt),
      fit: value.fit === "contain" || value.fit === "cover" || value.fit === "fill" ? value.fit : undefined };
  }
  return null;
}

export function parseLayoutConfig(value: unknown): LayoutConfig | null {
  if (!isRecord(value) || !isNonEmptyString(value.sourceId) || !Array.isArray(value.panels)) return null;
  // Removing entries from these arrays would change every later reference index.
  if ((value.devices !== undefined && !isStringArray(value.devices))
    || (value.deviceLabels !== undefined && !isStringArray(value.deviceLabels))) return null;
  const panels = readPanels(value.panels, readLayoutPanel);
  if (!panels) return null;
  return {
    sourceId: value.sourceId, panels, title: readString(value.title),
    cols: isGridValue(value.cols, 1) ? value.cols : undefined,
    rowHeight: isFiniteNumber(value.rowHeight) && value.rowHeight > 0 && value.rowHeight <= MAX_GRID_VALUE ? value.rowHeight : undefined,
    bg: readString(value.bg), surface: readString(value.surface), textColor: readString(value.textColor),
    batteryRanges: readRanges(value.batteryRanges),
    devices: value.devices as string[] | undefined, deviceLabels: value.deviceLabels as string[] | undefined,
  };
}
