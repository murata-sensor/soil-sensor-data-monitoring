import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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

const defaultSource: SourceRow = {
  sourceId: "synthetic-source", displayName: "Synthetic measurements", schemaType: "mechatrax",
  spreadsheetId: "synthetic-book", sheetName: "measurements", headerRow: 1,
  siteId: "synthetic-site", tz: "Asia/Tokyo", accessMode: "proxy", enabled: true,
};

function fixture(stored: Record<string, unknown>, sourceId = defaultSource.sourceId) {
  const source = { ...defaultSource, sourceId };
  const email = "viewer@example.test";
  localStorage.setItem(`soil-sensor-settings-${email}`, JSON.stringify({
    ...stored,
    dateRange: { type: "last24h" },
    bgColor: "#123456",
    selectedSourceId: source.sourceId,
  }));
  vi.spyOn(api, "loadAllRegistry").mockResolvedValue({
    sources: [source], users: [{ email, role: "viewer", enabled: true }],
    acl: [{ email, sourceId: source.sourceId, permission: "read" }],
    theme: DEFAULT_THEME, layouts: [],
  });
  vi.spyOn(api, "canAccessSource").mockResolvedValue(true);
  vi.spyOn(api, "loadDataSource").mockResolvedValue({ source, rows: [] });
  vi.spyOn(api, "loadSourceEvents").mockResolvedValue({ events: [], replacements: [] });
  useApp.getState().setUser({ email, idToken: "synthetic-token" });
  return render(<Dashboard />);
}

async function expectUsableDashboard(view: ReturnType<typeof fixture>) {
  await waitFor(() => expect(view.getByRole("option", { name: "Synthetic measurements [mechatrax]" })).toBeInTheDocument());
  expect(view.getByText("Soil Sensor Monitor")).toBeInTheDocument();
  expect(view.getByRole("option", { name: "24時間" })).toHaveProperty("selected", true);
  expect(view.container.firstElementChild).toHaveStyle({ background: "#123456" });
  fireEvent.click(view.getByRole("button", { name: "設定" }));
  expect(view.getByRole("heading", { name: "ダッシュボード設定" })).toBeInTheDocument();
}

afterEach(() => {
  cleanup();
  useApp.getState().setUser(null);
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("dashboard recovery from damaged stored settings", () => {
  it.each([
    { field: "userChartPanels", value: "broken" },
    { field: "substrateTypes", value: null },
  ])("displays usable controls while retaining valid settings when $field is invalid", async ({ field, value }) => {
    const view = fixture({ [field]: value });
    await expectUsableDashboard(view);
  });

  it("uses the default substrate and layout for a source named after an inherited property", async () => {
    const view = fixture({ substrateTypes: {}, layoutsBySource: {} }, "toString");
    await expectUsableDashboard(view);
    expect(view.getByRole("option", { name: "一般土壌" })).toHaveProperty("selected", true);
  });
});
