import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import Dashboard from "../components/Dashboard";
import { CustomLayoutDashboard } from "../components/CustomLayoutDashboard";
import * as api from "../api/sheets";
import { useApp } from "../store";
import { DEFAULT_THEME, type SourceRow, type ThemePanel } from "../types";
import type { ChartPanelConfig, LayoutConfig } from "../layoutConfig";

interface ChartProps {
  data: { datasets: { label: string; borderColor: string; backgroundColor: string }[] };
}
const { chart } = vi.hoisted(() => ({ chart: vi.fn((_props: ChartProps) => null) }));
vi.mock("react-chartjs-2", () => ({ Line: chart }));
vi.mock("react-grid-layout", () => ({
  ResponsiveGridLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useContainerWidth: () => ({ width: 1200, containerRef: null }),
}));

const reservedIds = ["toString", "constructor", "__proto__"];
const source: SourceRow = {
  sourceId: "synthetic-source", displayName: "Synthetic measurements", schemaType: "pc-serial",
  spreadsheetId: "synthetic-book", sheetName: "measurements", headerRow: 1,
  siteId: "synthetic-site", tz: "Asia/Tokyo", accessMode: "proxy", enabled: true,
};
const email = "viewer@example.test";
const settingsKey = `soil-sensor-settings-${email}`;
const position = { x: 0, y: 0, w: 6, h: 3 };
const basePanel: ThemePanel = { id: "synthetic-chart", title: "Synthetic chart", metric: "vwc_pct", ...position };

function customChart(panel: Partial<ChartPanelConfig> = {}): LayoutConfig {
  return {
    sourceId: source.sourceId,
    panels: [{ type: "chart", ...basePanel, position, ...panel }],
  };
}

async function dashboard(stored: Record<string, unknown> = {}, panels = [basePanel], deviceId = "synthetic-device") {
  localStorage.setItem(settingsKey, JSON.stringify({
    ...stored, dateRange: { type: "all" }, selectedSourceId: source.sourceId,
  }));
  vi.spyOn(api, "loadAllRegistry").mockResolvedValue({
    sources: [source], users: [{ email, role: "viewer", enabled: true }],
    acl: [{ email, sourceId: source.sourceId, permission: "read" }],
    theme: { ...DEFAULT_THEME, panels }, layouts: [],
  });
  vi.spyOn(api, "canAccessSource").mockResolvedValue(true);
  vi.spyOn(api, "loadDataSource").mockResolvedValue({
    source, rows: [{ ts: "2026-01-01T00:00:00Z", deviceId, vwc_pct: 25, ec_bulk_dsm: 2 }],
  });
  vi.spyOn(api, "loadSourceEvents").mockResolvedValue({ events: [], replacements: [] });
  useApp.getState().setUser({ email, idToken: "synthetic-token" });
  const view = render(<Dashboard />);
  await waitFor(() => expect(view.getByRole("heading", { level: 3, name: `⠿ ${panels[0].title}` })).toBeInTheDocument());
  return view;
}

afterEach(() => {
  cleanup();
  useApp.getState().setUser(null);
  localStorage.clear();
  vi.restoreAllMocks();
  chart.mockClear();
});

describe("dashboard dictionaries with identifiers matching inherited object keys", () => {
  it.each(reservedIds)("keeps the original custom text for %s when no override is saved", (id) => {
    const view = render(<CustomLayoutDashboard
      layout={{ sourceId: source.sourceId, panels: [{ type: "text", id, content: "Original text", position }] }}
      rows={[]} events={[]} textOverrides={{}}
    />);
    expect(view.getByText("Original text")).toBeInTheDocument();
  });

  it.each(reservedIds)("keeps the original normal-layout text for %s when no override is saved", async (id) => {
    const view = await dashboard({ userTextPanels: [{ type: "text", id, content: "Original text", position }] });
    expect(view.getByText("Original text")).toBeInTheDocument();
  });

  it.each(reservedIds)("uses a fallback color and the device label for custom-layout device %s", (deviceId) => {
    render(<CustomLayoutDashboard layout={customChart({ groupColors: {}, groupLabels: {} })}
      rows={[{ ts: "2026-01-01T00:00:00Z", deviceId, vwc_pct: 25 }]} events={[]} deviceColors={{}} />);
    expect(chart.mock.calls.at(-1)?.[0].data.datasets).toEqual([
      expect.objectContaining({ label: deviceId, borderColor: "#0000ff", backgroundColor: "#0000ff20" }),
    ]);
  });

  it.each(reservedIds)("uses a fallback line color and color control for normal-layout device %s", async (deviceId) => {
    const view = await dashboard({}, [basePanel], deviceId);
    expect(chart.mock.calls.at(-1)?.[0].data.datasets[0]).toMatchObject({
      label: deviceId, borderColor: DEFAULT_THEME.chartColors[0],
    });
    fireEvent.click(view.getByRole("button", { name: "設定" }));
    const colorSection = view.getByRole("heading", { name: "デバイス線色" }).closest("section")!;
    expect(colorSection.querySelector('input[type="color"]')).toHaveValue("#0ea5e9");
    expect(within(colorSection).queryByRole("button")).not.toBeInTheDocument();
  });

  it("uses fallback colors for a multi-metric chart with an inherited device key", async () => {
    await dashboard({}, [{ ...basePanel, metrics: ["vwc_pct", "ec_bulk_dsm"] }], "constructor");
    expect(chart.mock.calls.at(-1)?.[0].data.datasets.map((dataset) => dataset.borderColor))
      .toEqual(DEFAULT_THEME.chartColors.slice(0, 2));
  });

  it("copies an actually saved axis setting when an earlier panel has an inherited key", async () => {
    const panels = [{ ...basePanel, id: "toString" }, { ...basePanel, id: "synthetic-second", title: "Second chart" }];
    const view = await dashboard({ panelSettings: { "synthetic-second": { yMin: 12 } } }, panels);
    fireEvent.click(view.getByRole("button", { name: "設定" }));
    fireEvent.click(view.getByRole("button", { name: "一括適用" }));
    fireEvent.click(view.getByRole("button", { name: "保存" }));
    expect(JSON.parse(localStorage.getItem(settingsKey)!).panelSettings.toString).toEqual({ yMin: 12 });
  });

  it("persists batch axis settings for a panel named __proto__", async () => {
    const view = await dashboard({}, [{ ...basePanel, id: "__proto__" }]);
    fireEvent.click(view.getByRole("button", { name: "設定" }));
    const batch = view.getByRole("heading", { name: "一括Y軸設定（メトリック別）" }).closest("section")!;
    fireEvent.change(within(batch).getAllByRole("spinbutton")[0], { target: { value: "12" } });
    fireEvent.click(view.getByRole("button", { name: "保存" }));
    const saved = JSON.parse(localStorage.getItem(settingsKey)!).panelSettings;
    expect(Object.hasOwn(saved, "__proto__")).toBe(true);
    expect(saved.__proto__).toEqual({ yMin: 12 });
  });

  it("retains explicitly configured values with inherited-key names", () => {
    const layout = customChart({
      groupColors: { ["__proto__"]: "#123456" }, groupLabels: { ["__proto__"]: "Custom label" },
    });
    layout.panels.push({ type: "text", id: "constructor", content: "Original text", position });
    const view = render(<CustomLayoutDashboard
      layout={layout}
      rows={[{ ts: "2026-01-01T00:00:00Z", deviceId: "__proto__", vwc_pct: 25 }]} events={[]}
      textOverrides={{ constructor: "Saved override" }}
    />);
    expect(view.getByText("Saved override")).toBeInTheDocument();
    expect(chart.mock.calls.at(-1)?.[0].data.datasets[0]).toMatchObject({ label: "Custom label", borderColor: "#123456" });
  });
});
