import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME, type Theme } from "../types";
import type { LayoutConfig } from "../layoutConfig";

vi.mock("../auth/google", () => ({
  getAccessToken: vi.fn(async () => "synthetic-access"),
  getValidIdToken: vi.fn(async (token: string) => token),
}));

const position = { x: 0, y: 0, w: 6, h: 3 };
const validLayout: LayoutConfig = {
  sourceId: "synthetic-source", title: "Synthetic layout", cols: 24, rowHeight: 60,
  bg: "#123456", surface: "white", textColor: "black", batteryRanges: [1, 2, 3, 4],
  devices: ["synthetic-device-a", "synthetic-device-b"], deviceLabels: ["Device A", "Device B"],
  panels: [
    { type: "chart", id: "chart-a", title: "Synthetic chart", metric: "vwc_pct", deviceRef: 1,
      deviceFilter: ["synthetic-device-b"], sensorFilter: ["1"], groupBy: "sensorNumber",
      groupLabels: { "1": "Depth A" }, groupColors: { "1": "#123456" }, yMin: -5, yMax: 80,
      yLabel: "Synthetic axis", showPoints: false, showEvents: false, position },
    { type: "gauge", id: "gauge-a", title: "Synthetic gauge", metric: "battery_v", deviceRef: 0,
      deviceFilter: ["synthetic-device-a"], ranges: [1, 2, 3, 4], position: { ...position, x: 6 } },
    { type: "text", id: "text-a", content: "Synthetic note", contentRef: 0, align: "center",
      fontSize: "1.2rem", position: { ...position, x: 12 } },
    { type: "image", id: "image-a", src: "https://example.test/diagram.png", alt: "Synthetic diagram",
      fit: "cover", position: { ...position, x: 18 } },
  ],
};

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function api() {
  vi.stubEnv("VITE_REGISTRY_SPREADSHEET_ID", "synthetic-registry");
  return import("../api/sheets");
}

function layoutRows(value: unknown): string[][] {
  return [["sourceId", "config", "year"], ["synthetic-source", JSON.stringify(value), "2026"]];
}

async function loadTheme(value: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ values: [["themeId", "json"], ["synthetic-theme", JSON.stringify(value)]] }),
  }));
  return (await api()).loadTheme();
}

describe("Registry display configuration validation", () => {
  it.each([null, [], { sourceId: "synthetic-source" }, { ...validLayout, panels: null },
    { ...validLayout, panels: "broken" }, { ...validLayout, sourceId: 42 }])(
    "skips a layout that cannot be rendered: %j", async (value) => {
      expect((await api()).parseLayouts(layoutRows(value))).toEqual([]);
    },
  );

  it("keeps every supported panel type, references and layouts wider than twelve columns", async () => {
    expect((await api()).parseLayouts(layoutRows(validLayout))).toEqual([{ ...validLayout, year: 2026 }]);
  });

  it("removes invalid panels without losing valid panels in the same layout", async () => {
    const result = (await api()).parseLayouts(layoutRows({ ...validLayout, panels: [
      null, ...validLayout.panels,
      { ...validLayout.panels[0], id: "bad-position", position: null },
      { ...validLayout.panels[0], id: "huge", position: { ...position, y: 1e100 } },
      { ...validLayout.panels[0], id: "bad-metric", metric: "unknown" },
    ] }));
    expect(result[0].panels).toEqual(validLayout.panels);
  });

  it("skips an all-invalid row so a later valid layout can be used", async () => {
    const rows = layoutRows({ ...validLayout, panels: [{ ...validLayout.panels[0], position: null }] });
    rows.push(["synthetic-source", JSON.stringify(validLayout), "2026"]);
    expect((await api()).parseLayouts(rows)).toEqual([{ ...validLayout, year: 2026 }]);
  });

  it("keeps an intentionally empty panel list", async () => {
    expect((await api()).parseLayouts(layoutRows({ sourceId: "synthetic-source", panels: [] })))
      .toEqual([{ sourceId: "synthetic-source", panels: [], year: 2026 }]);
  });

  it("preserves numeric pixel font sizes used by older layouts and local text panels", async () => {
    const config = { ...validLayout, panels: [{ ...validLayout.panels[2], fontSize: 24 }] };
    expect((await api()).parseLayouts(layoutRows(config))[0].panels[0]).toMatchObject({ fontSize: "24px" });
    localStorage.setItem("soil-sensor-settings-viewer@example.test", JSON.stringify({ userTextPanels: config.panels }));
    const { loadSettings } = await import("../settings");
    expect(loadSettings("viewer@example.test").userTextPanels?.[0].fontSize).toBe("24px");
  });

  it("falls back from gauge thresholds whose difference overflows", async () => {
    const ranges = [-1e308, -5e307, 5e307, 1e308];
    const config = { ...validLayout, batteryRanges: ranges, panels: [{ ...validLayout.panels[1], ranges }] };
    const parsed = (await api()).parseLayouts(layoutRows(config))[0];
    expect(parsed.batteryRanges).toBeUndefined();
    expect(parsed.panels[0]).toMatchObject({ type: "gauge", ranges: undefined });
  });

  it("does not shift device references around a damaged device list", async () => {
    expect((await api()).parseLayouts(layoutRows({ ...validLayout, devices: [{}, "synthetic-device-b"] }))).toEqual([]);
  });

  it("does not widen a chart's filter when its saved filter is malformed", async () => {
    const result = (await api()).parseLayouts(layoutRows({ ...validLayout, panels: [
      { ...validLayout.panels[0], deviceFilter: "synthetic-device-b" }, validLayout.panels[2],
    ] }));
    expect(result[0].panels).toEqual([validLayout.panels[2]]);
  });

  it.each([null, [], { ...DEFAULT_THEME, panels: null }, { ...DEFAULT_THEME, chartColors: "broken" }])(
    "rejects a malformed theme so callers can use the default: %j", async (value) => {
      expect(await loadTheme(value)).toBeNull();
    },
  );

  it("preserves multi-metric themes, negative axes and valid CSS color strings", async () => {
    const theme: Theme = { ...DEFAULT_THEME, bg: "rgb(1, 2, 3)", chartColors: ["red", "#123456"],
      panels: [{ ...DEFAULT_THEME.panels[0], metrics: ["vwc_pct", "vwc_rock_pct"], yMin: -10, yMax: 80 }] };
    expect(await loadTheme(theme)).toEqual(theme);
  });

  it("preserves an intentionally empty color list and panel list", async () => {
    const theme = { ...DEFAULT_THEME, chartColors: [], panels: [] };
    expect(await loadTheme(theme)).toEqual(theme);
  });

  it("removes invalid theme panels while retaining the valid panel and colors", async () => {
    const theme = { ...DEFAULT_THEME, panels: [null, DEFAULT_THEME.panels[0],
      { ...DEFAULT_THEME.panels[0], id: "huge", y: 1e100 }] };
    expect(await loadTheme(theme)).toEqual({ ...DEFAULT_THEME, panels: [DEFAULT_THEME.panels[0]] });
  });

  it("does not return duplicate panel IDs to the grid", async () => {
    const result = (await api()).parseLayouts(layoutRows({ ...validLayout,
      panels: [validLayout.panels[0], { ...validLayout.panels[0], title: "Duplicate" }] }));
    expect(result[0].panels).toEqual([validLayout.panels[0]]);
  });
});
