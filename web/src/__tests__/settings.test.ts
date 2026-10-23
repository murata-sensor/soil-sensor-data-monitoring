import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGaugeRanges, selectLayoutForYear, type LayoutConfig } from "../layoutConfig";
import { parseLayouts } from "../api/sheets";
import { dateRangeToMs, loadSettings, saveSettings, withSourceLayout, type DateRange, type UserSettings } from "../settings";

const layout = [{ i: "vwc", x: 0, y: 0, w: 12, h: 4 }];

function key(email: string): string {
  return `soil-sensor-settings-${email.toLowerCase()}`;
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("stored dashboard date ranges", () => {
  const invalidRanges = [null, [], {}, { type: "unknown" }, { type: "custom", start: "broken" },
    { type: "custom", end: "broken" }, { type: "custom", start: 42 }, { type: "custom", end: {} },
    { type: "custom", start: "2026-10-20", end: "2026-10-01" }].map(dateRange => ({ dateRange }));

  it.each(invalidRanges)("recovers an invalid stored range without losing other settings: %j", ({ dateRange }) => {
    localStorage.setItem(key("viewer@example.test"), JSON.stringify({
      dateRange, bgColor: "#123456", showAirTemperature: true,
    }));
    const settings = loadSettings("viewer@example.test");
    expect(settings.dateRange).toEqual({ type: "last7d" });
    expect(settings.bgColor).toBe("#123456");
    expect(settings.showAirTemperature).toBe(true);
  });

  it.each(invalidRanges)("calculates a safe default even when invalid input reaches the range helper: %j", ({ dateRange }) => {
    const now = Date.parse("2026-10-23T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(dateRangeToMs(dateRange as DateRange)).toEqual({ start: now - 7 * 86400000, end: now });
  });

  it("preserves valid custom ranges, empty boundaries and the all-data option", () => {
    const now = Date.parse("2026-10-23T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const custom = { type: "custom", start: "2026-10-01", end: "2026-10-20" } as const;
    const settings = { ...loadSettings("viewer@example.test"), dateRange: custom };
    saveSettings("viewer@example.test", settings);
    expect(loadSettings("viewer@example.test").dateRange).toEqual(custom);
    expect(dateRangeToMs(custom)).toEqual({ start: Date.parse(custom.start), end: Date.parse(custom.end) });
    expect(dateRangeToMs({ type: "custom", start: "", end: "" }))
      .toEqual({ start: now - 7 * 86400000, end: now });
    expect(dateRangeToMs({ type: "all" })).toBeNull();
  });
});

describe("independent default dashboard settings", () => {
  it.each(["missing", "malformed", "partial"])("isolates accounts with %s stored settings", (stored) => {
    const firstEmail = "first@example.test";
    const secondEmail = "second@example.test";
    if (stored !== "missing") {
      const value = stored === "malformed" ? "{broken" : JSON.stringify({ showAirTemperature: true });
      localStorage.setItem(key(firstEmail), value);
      localStorage.setItem(key(secondEmail), value);
    }
    const first = loadSettings(firstEmail);
    const second = loadSettings(secondEmail);
    for (const field of ["dateRange", "panelSettings", "layoutsBySource", "deviceColors",
      "substrateTypes", "savedPresets", "localEvents", "textOverrides", "userTextPanels", "userChartPanels"] as const) {
      expect(first[field], field).not.toBe(second[field]);
    }
    first.dateRange.type = "all";
    first.panelSettings.vwc = { yMin: 10 };
    first.layoutsBySource["source-a"] = layout;
    first.deviceColors["synthetic-device"] = "#123456";
    first.textOverrides!["synthetic-panel"] = "First account";
    expect(second.dateRange.type).toBe("last7d");
    expect(second.panelSettings).toEqual({});
    expect(second.layoutsBySource).toEqual({});
    expect(second.deviceColors).toEqual({});
    expect(second.textOverrides).toEqual({});
    expect(second.showAirTemperature).toBe(stored === "partial");
  });

  it("does not change later loads or another account when one account saves changes", () => {
    const first = loadSettings("first@example.test");
    first.dateRange.type = "all";
    first.panelSettings.vwc = { yMin: 10, yMax: 80 };
    first.layoutsBySource["source-a"] = layout;
    first.bgColor = "#123456";
    saveSettings("first@example.test", first);
    expect(loadSettings("first@example.test")).toEqual(first);
    expect(loadSettings("second@example.test")).toMatchObject({
      dateRange: { type: "last7d" }, panelSettings: {}, layoutsBySource: {},
    });
    expect(loadSettings("second@example.test").bgColor).toBeUndefined();
  });
});

describe("damaged stored dashboard settings", () => {
  const email = "viewer@example.test";
  const chart = { id: "user-chart-a", title: "Synthetic chart", metric: "temperature_c", x: 0, y: 0, w: 6, h: 3 };
  const text = { type: "text", id: "user-text-a", content: "Synthetic note", position: { x: 0, y: 3, w: 6, h: 2 } };
  const event = { date: "2026-10-23 09:00:00", label: "Synthetic event", color: "#123456", enabled: false };
  const preset = {
    id: "preset-a", name: "Synthetic preset", createdAt: "2026-10-23T09:00:00Z",
    sourceId: "source-a", layout, ftpSheetName: "sensor_2025", dateRange: { type: "all" },
    substrateTypes: { "source-a": "cocopeat" }, panelSettings: { vwc: { yMin: 0 } },
    deviceColors: { "synthetic-device": "#123456" },
  };

  function store(value: unknown) {
    localStorage.setItem(key(email), JSON.stringify(value));
  }

  it.each([null, [], "broken", 42])("recovers a non-object root: %j", (value) => {
    const defaults = loadSettings("unused@example.test");
    store(value);
    expect(loadSettings(email)).toEqual(defaults);
  });

  it("recovers invalid containers without discarding valid colors, dates or switches", () => {
    store({
      userChartPanels: "broken", userTextPanels: {}, localEvents: 42, savedPresets: {},
      substrateTypes: null, layoutsBySource: null, panelSettings: [], deviceColors: [], textOverrides: [],
      bgColor: "#123456", showAirTemperature: true, dateRange: { type: "all" },
    });
    const settings = loadSettings(email);
    expect(settings).toMatchObject({
      userChartPanels: [], userTextPanels: [], localEvents: [], savedPresets: [],
      substrateTypes: {}, layoutsBySource: {}, panelSettings: {}, deviceColors: {}, textOverrides: {},
      bgColor: "#123456", showAirTemperature: true, dateRange: { type: "all" },
    });
  });

  it("recovers invalid scalar fields without treating strings as enabled switches", () => {
    store({
      showAirTemperature: "false", showPrecipitation: 1, showSunshine: null, showEventLabels: "false",
      selectedSourceId: {}, ftpSheetName: [], bgColor: {}, chartBgColor: 42,
      textOverrides: { "user-text-a": "Preserved note" },
    });
    expect(loadSettings(email)).toMatchObject({
      showAirTemperature: false, showPrecipitation: false, showSunshine: false, showEventLabels: true,
      selectedSourceId: null, ftpSheetName: "sensor_raw", textOverrides: { "user-text-a": "Preserved note" },
    });
    expect(loadSettings(email).bgColor).toBeUndefined();
    expect(loadSettings(email).chartBgColor).toBeUndefined();
  });

  it("preserves valid entries and axis values when other entries in the same maps are damaged", () => {
    store({
      layoutsBySource: { "source-a": layout, "source-b": "broken", "source-c": [null] },
      substrateTypes: { "source-a": "cocopeat", "source-b": "unknown", "source-c": null },
      panelSettings: { vwc: { yMin: -10, yMax: "broken", showPoints: false, yLabel: {} }, temp: null },
      deviceColors: { first: "#123456", second: {} }, textOverrides: { first: "Kept", second: {} },
    });
    const settings = loadSettings(email);
    expect({
      layoutsBySource: settings.layoutsBySource, substrateTypes: settings.substrateTypes,
      panelSettings: settings.panelSettings, deviceColors: settings.deviceColors, textOverrides: settings.textOverrides,
    }).toEqual({
      layoutsBySource: { "source-a": layout }, substrateTypes: { "source-a": "cocopeat" },
      panelSettings: { vwc: { yMin: -10, showPoints: false } },
      deviceColors: { first: "#123456" }, textOverrides: { first: "Kept" },
    });
  });

  it("removes invalid optional panel and event values without discarding their valid contents", () => {
    store({
      userChartPanels: [{ ...chart, yMin: -10, yMax: "broken" }],
      userTextPanels: [{ ...text, fontSize: {}, align: "broken", contentRef: -1 }],
      localEvents: [{ ...event, color: {}, deviceId: [], enabled: "false" }],
    });
    const settings = loadSettings(email);
    expect(settings.userChartPanels).toEqual([{ ...chart, yMin: -10 }]);
    expect(settings.userTextPanels).toEqual([text]);
    expect(settings.localEvents).toEqual([{ date: event.date, label: event.label }]);
  });

  it("discards malformed list entries while preserving valid panels, events and layout positions", () => {
    store({
      userChartPanels: [null, chart, { ...chart, id: "bad-metric", metric: "unknown" },
        { ...chart, id: "bad-size", w: 0 }, { ...chart, id: 42 }],
      userTextPanels: [null, text, { ...text, id: "bad-position", position: null }],
      localEvents: [null, event, { date: 42, label: "broken" }, { date: "broken", label: "broken" }],
      layoutsBySource: { "source-a": [null, ...layout, { i: "bad", x: 0, y: 0, w: -1, h: 3 }] },
    });
    expect(loadSettings(email)).toMatchObject({
      userChartPanels: [chart], userTextPanels: [text], localEvents: [event], layoutsBySource: { "source-a": layout },
    });
  });

  it("rejects grid values that can stall compaction while preserving wide custom layouts", () => {
    const wideChart = { ...chart, x: 18, w: 24 };
    const wideLayout = [{ ...layout[0], x: 18, w: 24 }];
    store({
      userChartPanels: [wideChart, { ...chart, id: "huge-height", h: 1e100 },
        { ...chart, id: "huge-y", y: Number.MAX_SAFE_INTEGER }, { ...chart, id: "fractional", y: 0.5 }],
      userTextPanels: [{ ...text, position: { ...text.position, y: 1e100 } }],
      layoutsBySource: { "source-a": [...wideLayout, { ...layout[0], i: "huge", y: 10001 }] },
    });
    const settings = loadSettings(email);
    expect(settings.userChartPanels).toEqual([wideChart]);
    expect(settings.userTextPanels).toEqual([]);
    expect(settings.layoutsBySource).toEqual({ "source-a": wideLayout });
  });

  it("recovers nested preset settings before they can be applied to the dashboard", () => {
    store({ savedPresets: [null, preset, { ...preset, id: 42 }, {
      ...preset, id: "damaged-preset", layout: "broken", sourceId: {}, ftpSheetName: {},
      substrateTypes: { "source-a": "unknown" }, dateRange: null, panelSettings: null, deviceColors: null,
    }] });
    const settings = loadSettings(email);
    expect(settings.savedPresets).toEqual([preset, {
      ...preset, id: "damaged-preset", layout: null, sourceId: null, ftpSheetName: "sensor_raw",
      substrateTypes: {}, dateRange: { type: "last7d" }, panelSettings: {}, deviceColors: {},
    }]);
  });

  it.each(["broken", [null], [{ ...layout[0], w: "broken" }]])(
    "does not migrate a damaged legacy layout or lose unrelated valid settings: %j", (legacyLayout) => {
      store({ layout: legacyLayout, selectedSourceId: "source-a", bgColor: "#123456" });
      const settings = loadSettings(email);
      expect(settings.layoutsBySource).toEqual({});
      expect(settings.selectedSourceId).toBe("source-a");
      expect(settings.bgColor).toBe("#123456");
    },
  );

  it("preserves valid settings and presets without rewriting storage during recovery", () => {
    const valid: UserSettings = {
      ...loadSettings(email), dateRange: { type: "custom", start: "2026-10-01", end: "2026-10-23" },
      userChartPanels: [{ ...chart, metric: "temperature_c", yMin: -5, yMax: 35 }],
      userTextPanels: [{ ...text, type: "text", align: "center", fontSize: "1.2rem", contentRef: 0 }],
      savedPresets: [{ ...preset, dateRange: { type: "all" }, substrateTypes: { "source-a": "cocopeat" } }],
      localEvents: [event], layoutsBySource: { "source-a": layout }, substrateTypes: { "source-a": "all" },
      selectedSourceId: "source-a", bgColor: "#123456", chartBgColor: "#abcdef",
    };
    saveSettings(email, valid);
    const raw = localStorage.getItem(key(email));
    const write = vi.spyOn(Storage.prototype, "setItem");
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    expect(loadSettings(email)).toEqual(valid);
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(localStorage.getItem(key(email))).toBe(raw);
  });
});

describe("source-specific dashboard layouts", () => {
  it("uses a shared gauge range unless a panel overrides it", () => {
    const shared: LayoutConfig = { sourceId: "source-a", batteryRanges: [2, 2.6, 3.1, 3.6], panels: [] };
    expect(resolveGaugeRanges({ type: "gauge", id: "first", title: "Battery", position: { x: 0, y: 0, w: 2, h: 2 } }, shared))
      .toEqual([2, 2.6, 3.1, 3.6]);
    expect(resolveGaugeRanges({ type: "gauge", id: "second", title: "Battery", ranges: [1, 2, 3, 4], position: { x: 0, y: 0, w: 2, h: 2 } }, shared))
      .toEqual([1, 2, 3, 4]);
    expect(resolveGaugeRanges({ type: "gauge", id: "legacy", title: "Battery", position: { x: 0, y: 0, w: 2, h: 2 } }, {}))
      .toEqual([2, 2.5, 3, 3.6]);
  });

  it("selects a matching year before the legacy default, never a different year", () => {
    const values = [
      ["sourceId", "config", "year"],
      ["source-a", JSON.stringify({ sourceId: "source-a", panels: [], title: "default" }), ""],
      ["source-a", JSON.stringify({ sourceId: "source-a", panels: [], title: "2025" }), "2025"],
      ["source-a", JSON.stringify({ sourceId: "source-a", panels: [], title: "2026" }), "2026"],
      ["source-b", JSON.stringify({ sourceId: "source-b", panels: [], title: "other" }), "2026"],
    ];
    const configs: LayoutConfig[] = parseLayouts(values);
    expect(selectLayoutForYear(configs, "source-a", 2025)?.title).toBe("2025");
    expect(selectLayoutForYear(configs, "source-a", 2026)?.title).toBe("2026");
    expect(selectLayoutForYear(configs, "source-a", 2027)?.title).toBe("default");
    expect(selectLayoutForYear(configs, "source-b", 2025)).toBeUndefined();
  });

  it("keeps layouts independent between sources", () => {
    const first = withSourceLayout({}, "source-a", layout);
    const second = withSourceLayout(first, "source-b", [
      { i: "vwc", x: 0, y: 0, w: 6, h: 3 },
    ]);

    expect(second["source-a"]).toEqual(layout);
    expect(second["source-b"]).toEqual([{ i: "vwc", x: 0, y: 0, w: 6, h: 3 }]);
  });

  it("stores a source named __proto__ as an own layout entry", () => {
    const settings = withSourceLayout({}, "__proto__", layout);
    expect(Object.hasOwn(settings, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(settings)).toBe(Object.prototype);
    expect(settings["__proto__"]).toEqual(layout);
  });

  it("migrates the legacy layout only to the previously selected source", () => {
    localStorage.setItem(key("User@example.com"), JSON.stringify({
      selectedSourceId: "source-a",
      layout,
    }));

    const settings = loadSettings("USER@example.com");
    expect(settings.layoutsBySource["source-a"]).toEqual(layout);
    expect((settings as unknown as { layout?: unknown }).layout).toBeUndefined();
    expect(settings.layoutsBySource["source-b"]).toBeUndefined();
  });
});
