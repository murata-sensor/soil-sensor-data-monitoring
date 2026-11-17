import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import Dashboard from "../components/Dashboard";
import * as api from "../api/sheets";
import { useApp } from "../store";
import { DEFAULT_THEME, type SourceRow } from "../types";

vi.mock("react-chartjs-2", () => ({ Line: () => null }));
vi.mock("react-grid-layout", () => ({
  ResponsiveGridLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useContainerWidth: () => ({ width: 1200, containerRef: null }),
}));

const email = "viewer@example.test";
const sources: SourceRow[] = ["first", "second", "denied"].map((id) => ({
  sourceId: `synthetic-${id}`, displayName: `Synthetic ${id}`, schemaType: "pc-serial",
  spreadsheetId: `synthetic-${id}-book`, sheetName: "measurements", headerRow: 1,
  siteId: "synthetic-site", tz: "Asia/Tokyo", accessMode: "direct", enabled: true,
}));

function fixture(proxy = true, ftp = false) {
  vi.stubEnv("VITE_GAS_PROXY_URL", proxy ? "https://example.test/proxy" : "");
  localStorage.setItem(`soil-sensor-settings-${email}`, JSON.stringify({ dateRange: { type: "all" } }));
  const list = sources.map((source, index) => ftp && index === 0
    ? { ...source, schemaType: "remote-ftp" as const, sheetName: "sensor_raw" } : source);
  const registry: api.RegistryData = {
    sources: list, users: [{ email, role: "viewer", enabled: true }],
    acl: list.slice(0, 2).map((source) => ({ email, sourceId: source.sourceId, permission: "read" })),
    theme: DEFAULT_THEME, layouts: [],
  };
  const loadRegistry = vi.spyOn(api, "loadAllRegistry").mockResolvedValue(registry);
  const preflight = vi.spyOn(api, "canAccessSource").mockResolvedValue(true);
  const data = vi.spyOn(api, "loadDataSource").mockImplementation(async (source) => ({ source, rows: [] }));
  const events = vi.spyOn(api, "loadSourceEvents").mockResolvedValue({ events: [], replacements: [] });
  vi.spyOn(api, "getSheetNames").mockResolvedValue(["sensor_raw", "sensor_2025"]);
  useApp.getState().setUser({ email, idToken: "synthetic-token" });
  return { registry, loadRegistry, preflight, data, events, view: () => render(<Dashboard />) };
}

async function settled() {
  await waitFor(() => expect(api.loadDataSource).toHaveBeenCalled());
  await act(async () => {});
}

afterEach(() => {
  cleanup();
  useApp.getState().setUser(null);
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("dashboard loading without redundant source reads", () => {
  it("loads only the selected source after the proxy has authorized the registry", async () => {
    const { view, loadRegistry, preflight, data, events } = fixture();
    const screen = view();
    await settled();
    expect({ registry: loadRegistry.mock.calls.length, preflight: preflight.mock.calls.length,
      data: data.mock.calls.length, events: events.mock.calls.length })
      .toEqual({ registry: 1, preflight: 0, data: 1, events: 1 });
    expect(data.mock.calls[0][0].sourceId).toBe(sources[0].sourceId);
    expect(screen.queryByRole("option", { name: "Synthetic denied [pc-serial]" })).not.toBeInTheDocument();
  });

  it("switches sources without reloading the registry or probing all sources", async () => {
    const { view, loadRegistry, preflight, data, events } = fixture();
    const screen = view();
    await settled();
    vi.clearAllMocks();
    fireEvent.change(screen.getByRole("option", { name: "Synthetic first [pc-serial]" }).closest("select")!,
      { target: { value: sources[1].sourceId } });
    await settled();
    expect({ registry: loadRegistry.mock.calls.length, preflight: preflight.mock.calls.length,
      data: data.mock.calls.length, events: events.mock.calls.length })
      .toEqual({ registry: 0, preflight: 0, data: 1, events: 1 });
    expect(data.mock.calls[0][0].sourceId).toBe(sources[1].sourceId);
  });

  it("switches an allowed history tab without reloading the registry or other sources", async () => {
    const { view, loadRegistry, preflight, data } = fixture(true, true);
    const screen = view();
    await settled();
    await waitFor(() => expect(screen.getByRole("option", { name: "sensor_2025" })).toBeInTheDocument());
    vi.clearAllMocks();
    fireEvent.change(screen.getByRole("option", { name: "sensor_raw" }).closest("select")!,
      { target: { value: "sensor_2025" } });
    await settled();
    expect(loadRegistry).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
    expect(data).toHaveBeenCalledTimes(1);
    expect(data.mock.calls[0][2]).toEqual({ sheetNameOverride: "sensor_2025" });
  });

  it("retains individual Drive access checks when no proxy is configured", async () => {
    const { view, loadRegistry, preflight, data } = fixture(false);
    preflight.mockImplementation(async (source) => source.sourceId === sources[0].sourceId);
    const screen = view();
    await settled();
    expect(loadRegistry).toHaveBeenCalled();
    expect(preflight).toHaveBeenCalledWith(sources[0], "synthetic-token");
    expect(preflight).toHaveBeenCalledWith(sources[1], "synthetic-token");
    expect(data.mock.calls.every(([source]) => source.sourceId === sources[0].sourceId)).toBe(true);
    expect(screen.queryByRole("option", { name: "Synthetic second [pc-serial]" })).not.toBeInTheDocument();
  });

  it("keeps registry permissions refreshed when switching sources in direct mode", async () => {
    const { view, loadRegistry, preflight } = fixture(false);
    const screen = view();
    await settled();
    vi.clearAllMocks();
    fireEvent.change(screen.getByRole("option", { name: "Synthetic first [pc-serial]" }).closest("select")!,
      { target: { value: sources[1].sourceId } });
    await settled();
    expect(loadRegistry).toHaveBeenCalledTimes(1);
    expect(preflight).toHaveBeenCalledTimes(2);
  });

  it("preserves the latest source selection while the registry request is pending", async () => {
    const { view, loadRegistry, registry, data } = fixture();
    let complete: (value: api.RegistryData) => void = () => {};
    loadRegistry.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    view();
    act(() => { useApp.getState().setSelectedSource(sources[1].sourceId); });
    await act(async () => { complete(registry); });
    await settled();
    expect(loadRegistry).toHaveBeenCalledTimes(1);
    expect(useApp.getState().selectedSourceId).toBe(sources[1].sourceId);
    expect(data.mock.calls[0][0].sourceId).toBe(sources[1].sourceId);
  });
});
