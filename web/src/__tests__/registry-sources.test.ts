import { afterEach, describe, expect, it, vi } from "vitest";
import { isSchemaType } from "../adapters";

vi.mock("../auth/google", () => ({
  getAccessToken: vi.fn(async () => "synthetic-access"),
  getValidIdToken: vi.fn(async (token: string) => token),
}));

const header = ["sourceId", "displayName", "schemaType", "spreadsheetId", "sheetName", "headerRow", "accessMode", "enabled", "tz"];
const valid = ["synthetic-source", "Synthetic measurements", "pc-serial", "synthetic-book", "measurements", "2", "proxy", "TRUE", "Asia/Tokyo"];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function load(rows: string[][], proxy = false) {
  vi.stubEnv("VITE_REGISTRY_SPREADSHEET_ID", "synthetic-registry");
  vi.stubEnv("VITE_GAS_PROXY_URL", proxy ? "https://example.test/proxy" : "");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => proxy
    ? { ok: true, sources: [header, ...rows], users: [], acl: [], theme: [], layouts: [] }
    : { values: [header, ...rows] } }));
  const api = await import("../api/sheets");
  return proxy ? (await api.loadAllRegistry("synthetic-token")).sources : api.loadSources();
}

function withField(field: string, value: string) {
  const row = [...valid];
  row[header.indexOf(field)] = value;
  return row;
}

describe("Registry data-source validation", () => {
  it.each(["toString", "constructor", "__proto__", "unknown"])("rejects unsupported schema %s before choosing an adapter", async (schema) => {
    expect(isSchemaType(schema)).toBe(false);
    expect(await load([withField("schemaType", schema)])).toEqual([]);
  });

  it.each(["prox_y", "direct-ish"])("does not treat unknown access mode %s as direct Sheets access", async (mode) => {
    expect(await load([withField("accessMode", mode)])).toEqual([]);
  });

  it("excludes invalid reading positions while retaining valid sources", async () => {
    const rows = [valid, ...["0", "-1", "1.5", "Infinity", "NaN", "broken", "1e100"]
      .map((value) => withField("headerRow", value))];
    const sources = await load(rows);
    expect(sources.map((source) => source.headerRow)).toEqual([2]);
  });

  it("excludes a bad time zone before replacement/layout date calculations", async () => {
    const sources = await load([valid, withField("tz", "synthetic/not-a-time-zone")]);
    expect(sources.map((source) => source.tz)).toEqual(["Asia/Tokyo"]);
  });

  it.each([false, true])("retains valid source settings and existing defaults (proxy=%s)", async (proxy) => {
    const legacy = [...valid];
    for (const field of ["headerRow", "accessMode", "tz"]) legacy[header.indexOf(field)] = "";
    const sources = await load([valid, legacy], proxy);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ sourceId: "synthetic-source", schemaType: "pc-serial", headerRow: 2,
      accessMode: "proxy", tz: "Asia/Tokyo" });
    expect(sources[1]).toMatchObject({ headerRow: 1, accessMode: "direct", tz: "Asia/Tokyo" });
  });
});
