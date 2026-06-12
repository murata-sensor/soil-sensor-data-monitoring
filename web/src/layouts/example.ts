/**
 * Example layout configuration for a remote-ftp site with column-per-device style.
 *
 * This demonstrates how to use `generateDeviceColumnLayout()` to create
 * a layout matching the column-per-device dashboard style with:
 * - Title text
 * - Battery gauges per device
 * - Temperature, BulkEC, VWC charts grouped by sensor number (depth)
 *
 * In production, the JSON is stored in the Registry spreadsheet `layouts` sheet.
 * This file serves as documentation and a template for creating new layouts.
 *
 * Usage:
 *   import { createSiteLayout, EXAMPLE_LAYOUT_JSON } from "./example";
 */
import { generateDeviceColumnLayout, type LayoutConfig } from "../layoutConfig";

/**
 * Generate a column-per-device layout for a given set of devices.
 * Call this after loading data to auto-detect devices,
 * or use a pre-configured version.
 */
export function createSiteLayout(
  sourceId: string,
  displayName: string,
  devices: string[],
): LayoutConfig {
  return generateDeviceColumnLayout(sourceId, devices, {
    title: displayName,
    sensorLabels: {
      "1": "1",
      "2": "2",
      "3": "3",
    },
    sensorColors: {
      "1": "#0044ff",
      "2": "#00cc00",
      "3": "#cccc00",
    },
    metrics: [
      { metric: "battery_v", title: "Battery voltage[V]", yMin: 3.0, yMax: 3.6 },
      { metric: "temperature_c", title: "Temperature[℃]", yMin: 10, yMax: 45 },
      { metric: "ec_bulk_dsm", title: "BulkEC[dS/m]" },
      { metric: "vwc_pct", title: "VWC[%]", yMin: 10, yMax: 70 },
      { metric: "air_temp_c", title: "Air Temperature[℃]", yMin: 10, yMax: 45 },
    ],
    batteryRanges: [2.0, 2.5, 3.0, 3.6],
  });
}

/**
 * Example: Pre-configured layout JSON for 7 devices.
 * This is what would be stored in the Registry `layouts` sheet.
 */
export const EXAMPLE_LAYOUT_JSON: LayoutConfig = generateDeviceColumnLayout(
  "src-remote-example",
  ["dev1", "dev2", "dev3", "dev4", "dev5", "dev6", "dev7"],
  {
    title: "Example Site",
    sensorLabels: {
      "1": "Sensor 1",
      "2": "Sensor 2",
      "3": "Sensor 3",
    },
    sensorColors: {
      "1": "#0044ff",
      "2": "#00cc00",
      "3": "#cccc00",
    },
    metrics: [
      { metric: "battery_v", title: "Battery voltage[V]", yMin: 3.0, yMax: 3.6 },
      { metric: "temperature_c", title: "Temperature[℃]", yMin: 10, yMax: 45 },
      { metric: "ec_bulk_dsm", title: "BulkEC[dS/m]" },
      { metric: "vwc_pct", title: "VWC[%]", yMin: 10, yMax: 70 },
      { metric: "air_temp_c", title: "Air Temperature[℃]", yMin: 10, yMax: 45 },
    ],
    batteryRanges: [2.0, 2.5, 3.0, 3.6],
  },
);
