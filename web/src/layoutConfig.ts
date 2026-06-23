/**
 * Per-source dashboard layout configuration.
 *
 * Stored in the Registry spreadsheet `layouts` sheet as JSON.
 * Allows each source (customer) to have a completely different dashboard
 * layout including arbitrary panels, gauges, text, images, and charts
 * with per-device/per-sensor filtering.
 */

import type { Metric } from "./types";

// ─── Panel Types ────────────────────────────────────────────────────────────

export type PanelType = "chart" | "gauge" | "text" | "image";

/** How to group lines within a chart panel. */
export type ChartGroupBy = "deviceId" | "sensorNumber";

/** Base layout position/size for all panel types. */
export interface PanelPosition {
  x: number;  // grid column (0-based, 12-col grid)
  y: number;  // grid row
  w: number;  // grid width
  h: number;  // grid height
}

/** Line chart panel configuration. */
export interface ChartPanelConfig {
  type: "chart";
  id: string;
  title: string;
  metric: Metric;
  /** Index into LayoutConfig.devices[]. Resolves to deviceFilter at render time. */
  deviceRef?: number;
  /** Filter to specific deviceId(s). undefined = show all devices. */
  deviceFilter?: string[];
  /** Filter to specific sensorNumber(s). undefined = show all. */
  sensorFilter?: string[];
  /**
   * How lines are grouped and colored:
   * - "deviceId": each device gets a unique color (default, existing behavior)
   * - "sensorNumber": each sensor number gets a unique color (Kashimadai style)
   */
  groupBy?: ChartGroupBy;
  /** Custom labels for each group value (e.g. { "1": "depth 0cm", "2": "depth 5cm" }). */
  groupLabels?: Record<string, string>;
  /** Custom line colors per group value. */
  groupColors?: Record<string, string>;
  yMin?: number;
  yMax?: number;
  yLabel?: string;
  showPoints?: boolean;
  /** Show events (annotations) on this chart. Default: true. */
  showEvents?: boolean;
  position: PanelPosition;
}

/** Battery gauge panel configuration. */
export interface GaugePanelConfig {
  type: "gauge";
  id: string;
  title: string;
  /** Index into LayoutConfig.devices[]. Resolves to deviceFilter at render time. */
  deviceRef?: number;
  /** Filter to a specific device. Required for gauge. */
  deviceFilter?: string[];
  /** Which metric to show on gauge. Default: "battery_v". */
  metric?: Metric;
  /** Gauge ranges: [red_start, yellow_start, green_start, max] */
  ranges?: [number, number, number, number];
  position: PanelPosition;
}

/** Text panel (arbitrary text/markdown). */
export interface TextPanelConfig {
  type: "text";
  id: string;
  /** Index into LayoutConfig.deviceLabels[]. Resolves to content at render time. */
  contentRef?: number;
  /** Text content (plain or markdown). */
  content?: string;
  /** CSS font-size. */
  fontSize?: string;
  /** CSS text alignment. */
  align?: "left" | "center" | "right";
  position: PanelPosition;
}

/** Image panel (displays an image URL). */
export interface ImagePanelConfig {
  type: "image";
  id: string;
  /** Image URL. */
  src: string;
  alt?: string;
  /** Object-fit mode. */
  fit?: "contain" | "cover" | "fill";
  position: PanelPosition;
}

export type LayoutPanel =
  | ChartPanelConfig
  | GaugePanelConfig
  | TextPanelConfig
  | ImagePanelConfig;

/**
 * Full layout configuration for a data source.
 * Stored as JSON in Registry `layouts` sheet.
 */
export interface LayoutConfig {
  /** Source ID this layout applies to. */
  sourceId: string;
  /** Display title shown at top of dashboard. */
  title?: string;
  /** Number of grid columns (default: 12). */
  cols?: number;
  /** Row height in pixels (default: 80). */
  rowHeight?: number;
  /** Background color. */
  bg?: string;
  /** Surface color for panels. */
  surface?: string;
  /** Text color. */
  textColor?: string;
  /**
   * Device address list. Panels reference devices by index via `deviceRef`
   * so each address appears only once.
   */
  devices?: string[];
  /**
   * Display labels for each device (same order as `devices`).
   * Text panels reference labels by index via `contentRef`.
   * Defaults to `devices` values if omitted.
   */
  deviceLabels?: string[];
  /** Panels in this layout. */
  panels: LayoutPanel[];
}

/**
 * Resolve `deviceRef` → `deviceFilter` using the top-level `devices` array.
 * Returns the effective deviceFilter for a panel.
 */
export function resolveDeviceFilter(
  panel: { deviceRef?: number; deviceFilter?: string[] },
  devices?: string[],
): string[] | undefined {
  if (panel.deviceRef !== undefined && devices?.[panel.deviceRef]) {
    return [devices[panel.deviceRef]];
  }
  return panel.deviceFilter;
}

/**
 * Generate a Kashimadai-style layout for the given device list.
 * Creates a column per device with gauge + charts.
 */
export function generateDeviceColumnLayout(
  sourceId: string,
  devices: string[],
  options?: {
    title?: string;
    sensorLabels?: Record<string, string>;
    sensorColors?: Record<string, string>;
    metrics?: { metric: Metric; title: string; yMin?: number; yMax?: number }[];
    batteryRanges?: [number, number, number, number];
  },
): LayoutConfig {
  const title = options?.title ?? sourceId;
  const metrics = options?.metrics ?? [
    { metric: "battery_v", title: "Battery voltage[V]", yMin: 3.0, yMax: 3.6 },
    { metric: "temperature_c", title: "Temperature[℃]", yMin: 10, yMax: 45 },
    { metric: "ec_bulk_dsm", title: "BulkEC[dS/m]" },
    { metric: "vwc_pct", title: "VWC[%]", yMin: 10, yMax: 70 },
    { metric: "air_temp_c", title: "Air Temperature[℃]", yMin: 10, yMax: 45 },
    { metric: "precip_1h_mm", title: "Precipitation[mm]" },
    { metric: "sunshine_1h_h", title: "Sunshine[h]" },
  ];
  const sensorLabels = options?.sensorLabels ?? { "1": "1", "2": "2", "3": "3" };
  const sensorColors = options?.sensorColors ?? { "1": "#0000ff", "2": "#00cc00", "3": "#cccc00" };
  const batteryRanges = options?.batteryRanges ?? [2.0, 2.5, 3.0, 3.6];

  const colW = 2;
  // Adjust cols if devices don't fit evenly
  const effectiveCols = colW * devices.length;
  const panels: LayoutPanel[] = [];

  // Title text
  panels.push({
    type: "text",
    id: "title",
    content: title,
    fontSize: "1.2rem",
    align: "left",
    position: { x: 0, y: 0, w: effectiveCols, h: 1 },
  });

  devices.forEach((_device, col) => {
    const x = col * colW;
    let y = 1;

    // Device header text — uses contentRef to reference deviceLabels
    panels.push({
      type: "text",
      id: `hdr-${col}`,
      contentRef: col,
      fontSize: "0.75rem",
      align: "center",
      position: { x, y, w: colW, h: 1 },
    });
    y += 1;

    // Battery gauge
    panels.push({
      type: "gauge",
      id: `gauge-${col}`,
      title: "Battery voltage[V]",
      deviceRef: col,
      metric: "battery_v",
      ranges: batteryRanges,
      position: { x, y, w: colW, h: 2 },
    });
    y += 2;

    // Battery voltage line chart (small)
    panels.push({
      type: "chart",
      id: `battery_v-${col}`,
      title: "Battery voltage[V]",
      metric: "battery_v",
      deviceRef: col,
      groupBy: "deviceId",
      groupColors: { battery: "#00cc00" },
      yMin: 3.0,
      yMax: 3.6,
      showEvents: false,
      position: { x, y, w: colW, h: 2 },
    });
    y += 2;

    // Metric charts (skip battery_v since we have gauge + line above)
    for (const m of metrics) {
      if (m.metric === "battery_v") continue;
      panels.push({
        type: "chart",
        id: `${m.metric}-${col}`,
        title: m.title,
        metric: m.metric,
        deviceRef: col,
        groupBy: (m.metric === "air_temp_c" || m.metric === "precip_1h_mm" || m.metric === "sunshine_1h_h") ? "deviceId" : "sensorNumber",
        groupLabels: (m.metric === "air_temp_c" || m.metric === "precip_1h_mm" || m.metric === "sunshine_1h_h") ? undefined : sensorLabels,
        groupColors: (m.metric === "air_temp_c" || m.metric === "precip_1h_mm" || m.metric === "sunshine_1h_h") ? undefined : sensorColors,
        yMin: m.yMin,
        yMax: m.yMax,
        showEvents: true,
        position: { x, y, w: colW, h: 3 },
      });
      y += 3;
    }
  });

  return {
    sourceId,
    title,
    cols: effectiveCols,
    rowHeight: 60,
    bg: "#1a1a1a",
    surface: "#2a2a2a",
    textColor: "#ffffff",
    devices,
    deviceLabels: devices,
    panels,
  };
}
