import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME, type Theme } from "../types";

vi.mock("../auth/google", () => ({ getValidIdToken: vi.fn(async (token: string) => token) }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("admin theme validation before publishing", () => {
  it.each([
    { ...DEFAULT_THEME, panels: null },
    { ...DEFAULT_THEME, panels: [{ ...DEFAULT_THEME.panels[0], metrics: { length: 2 } }] },
    { ...DEFAULT_THEME, panels: [DEFAULT_THEME.panels[0], { ...DEFAULT_THEME.panels[0], title: "Duplicate" }] },
    { ...DEFAULT_THEME, panels: [{ ...DEFAULT_THEME.panels[0], yMin: {} }] },
  ])("keeps malformed theme edits out of the saved registry", async (theme) => {
    vi.stubEnv("VITE_GAS_ADMIN_URL", "https://example.test/admin");
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, written: 2, revision: "next" }) });
    vi.stubGlobal("fetch", fetch);
    const { adminSaveTheme } = await import("../api/admin");
    await expect(adminSaveTheme("synthetic-token", theme as unknown as Theme, "initial"))
      .rejects.toThrow("テーマの形式");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("publishes a valid theme with its loaded revision", async () => {
    vi.stubEnv("VITE_GAS_ADMIN_URL", "https://example.test/admin");
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, written: 2, revision: "next" }) });
    vi.stubGlobal("fetch", fetch);
    const { adminSaveTheme } = await import("../api/admin");
    expect(await adminSaveTheme("synthetic-token", DEFAULT_THEME, "initial")).toBe("next");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ expectedRevision: "initial", rows: [
      ["themeId", "json"], [DEFAULT_THEME.themeId, JSON.stringify(DEFAULT_THEME)],
    ] });
  });
});
