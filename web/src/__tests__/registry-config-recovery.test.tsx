import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { DEFAULT_THEME } from "../types";

vi.mock("react-chartjs-2", () => ({ Line: () => null }));
vi.mock("react-grid-layout", () => ({
  ResponsiveGridLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useContainerWidth: () => ({ width: 1200, containerRef: null }),
}));

const email = "viewer@example.test";
const sourceId = "synthetic-pc-source";
const proxyUrl = "https://example.test/proxy";
const position = { x: 0, y: 0, w: 6, h: 3 };
let resetStore = () => {};

class RenderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <p role="alert">Dashboard failed to render</p> : this.props.children;
  }
}

async function dashboard(theme: unknown, layouts: unknown[] = []) {
  vi.stubEnv("VITE_GAS_PROXY_URL", proxyUrl);
  const idToken = `synthetic.${btoa(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;
  localStorage.setItem("soil_user", JSON.stringify({ email, idToken }));
  localStorage.setItem("soil_login_at", String(Date.now()));
  localStorage.setItem(`soil-sensor-settings-${email}`, JSON.stringify({
    selectedSourceId: sourceId, dateRange: { type: "all" }, bgColor: "#123456",
  }));

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== proxyUrl) throw new Error("Unexpected network request");
    const request = JSON.parse(String(init?.body));
    expect(request.idToken).toBe(idToken);
    if (request.action === "registry") {
      return { ok: true, json: async () => ({
        ok: true,
        sources: [
          ["sourceId", "displayName", "schemaType", "spreadsheetId", "sheetName", "headerRow", "accessMode", "enabled"],
          [sourceId, "Synthetic measurements", "pc-serial", "synthetic-book", "measurements", "1", "proxy", "TRUE"],
        ],
        users: [["email", "role", "enabled"], [email, "viewer", "TRUE"]],
        acl: [["email", "sourceId", "permission"], [email, sourceId, "read"]],
        theme: [["key", "json"], ["default", JSON.stringify(theme)]],
        layouts: [["sourceId", "json", "year"], ...layouts.map((layout) => [sourceId, JSON.stringify(layout), ""])],
      }) };
    }
    expect(request.sourceId).toBe(sourceId);
    return { ok: true, json: async () => ({
      ok: true,
      values: request.sheetName === "events"
        ? [["date", "label"]]
        : [["Date", "SerialNumber", "VWC(%)"], ["2026-01-01T00:00:00Z", "synthetic-device", "25"]],
    }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  // React reports errors caught by the boundary to console.error as well.
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { useApp } = await import("../store");
  const { default: Dashboard } = await import("../components/Dashboard");
  resetStore = () => useApp.getState().setUser(null);
  useApp.getState().setUser({ email, idToken });
  const view = render(<RenderBoundary><Dashboard /></RenderBoundary>);
  return { view, fetchMock, useApp };
}

async function expectUsableDashboard(view: Awaited<ReturnType<typeof dashboard>>["view"]) {
  await waitFor(() => expect(view.getByRole("option", { name: "Synthetic measurements [pc-serial]" })).toBeInTheDocument());
  expect(view.queryByRole("alert")).not.toBeInTheDocument();
  expect(view.getByRole("option", { name: "全期間" })).toHaveProperty("selected", true);
  expect(view.container.querySelector(".min-h-screen")).toHaveStyle({ background: "#123456" });
  fireEvent.click(view.getByRole("button", { name: "設定" }));
  expect(view.getByRole("heading", { name: "ダッシュボード設定" })).toBeInTheDocument();
}

afterEach(() => {
  cleanup();
  resetStore();
  resetStore = () => {};
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("dashboard recovery from damaged Registry JSON", () => {
  it("falls back to the default theme when the Registry theme panels are null", async () => {
    const { view, useApp } = await dashboard({ ...DEFAULT_THEME, panels: null });
    await waitFor(() => expect(view.getByRole("heading", { level: 3, name: "⠿ VWC (体積含水率 %)" })).toBeInTheDocument());
    expect(useApp.getState().theme).toEqual(DEFAULT_THEME);
    await expectUsableDashboard(view);
  });

  it("ignores a Registry layout missing panels while preserving the valid Registry theme", async () => {
    const theme = {
      ...DEFAULT_THEME,
      panels: [{ id: "synthetic-chart", title: "Valid Registry chart", metric: "vwc_pct", ...position }],
    };
    const { view, useApp } = await dashboard(theme, [{ sourceId }]);
    await waitFor(() => expect(view.getByRole("heading", { level: 3, name: "⠿ Valid Registry chart" })).toBeInTheDocument());
    expect(useApp.getState().theme).toEqual(theme);
    await expectUsableDashboard(view);
  });

  it("skips a Registry layout with a null position and retains a later valid layout", async () => {
    const { view } = await dashboard(DEFAULT_THEME, [
      { sourceId, panels: [{ type: "text", id: "invalid", content: "Invalid layout", position: null }] },
      { sourceId, panels: [{ type: "text", id: "valid", content: "Valid Registry text", position }] },
    ]);
    await waitFor(() => expect(view.getByText("Valid Registry text")).toBeInTheDocument());
    expect(view.queryByText("Invalid layout")).not.toBeInTheDocument();
    await expectUsableDashboard(view);
  });
});
