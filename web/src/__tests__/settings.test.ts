import { describe, expect, it } from "vitest";
import { resolveGaugeRanges, selectLayoutForYear, type LayoutConfig } from "../layoutConfig";
import { parseLayouts } from "../api/sheets";
import { loadSettings, withSourceLayout } from "../settings";

const layout = [{ i: "vwc", x: 0, y: 0, w: 12, h: 4 }];

function key(email: string): string {
  return `soil-sensor-settings-${email.toLowerCase()}`;
}

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
