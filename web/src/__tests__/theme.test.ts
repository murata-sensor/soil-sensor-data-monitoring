import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, SCHEMA_EXTRA_PANELS } from "../types";

describe("DEFAULT_THEME", () => {
  it("uses normalized metric keys", () => {
    const metrics = DEFAULT_THEME.panels.map((p) => p.metric);
    expect(metrics).toContain("vwc_pct");
    expect(metrics).toContain("ec_bulk_dsm");
    expect(metrics).toContain("battery_v");
  });
  it("fits on a 12-column grid", () => {
    for (const p of DEFAULT_THEME.panels) {
      expect(p.x + p.w).toBeLessThanOrEqual(12);
    }
  });
});

describe("SCHEMA_EXTRA_PANELS", () => {
  it("has entries for all schema types", () => {
    expect(SCHEMA_EXTRA_PANELS.m5stack.length).toBeGreaterThan(0);
    expect(SCHEMA_EXTRA_PANELS.mechatrax.length).toBeGreaterThan(0);
    expect(SCHEMA_EXTRA_PANELS["remote-ftp"]).toEqual([]);
  });
  it("extra panels also fit the 12-column grid", () => {
    for (const list of Object.values(SCHEMA_EXTRA_PANELS)) {
      for (const p of list) {
        expect(p.x + p.w).toBeLessThanOrEqual(12);
      }
    }
  });
});
