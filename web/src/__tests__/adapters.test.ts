import { describe, expect, it } from "vitest";
import { toNormalized } from "../adapters";
import { HEADER_MAP as M5_HEADERS } from "../adapters/m5stack";
import { HEADER_MAP as MX_HEADERS } from "../adapters/mechatrax";
import { resolveAllowedSources } from "../api/sheets";
import type { AclRow, SourceRow, UserRow } from "../types";

const M5_HEADER = [
  "Date", "SerialNumber", "Date from M5Stack", "Battery(V)",
  "Temperature(degC)", "VWC(%)", "VWC Coconut Peat(%)", "VWC Rock Wool(%)",
  "EC bulk(dS/m)", "EC pore(dS/m)", "EC pore Coco(dS/m)",
  "Error flag", "WiFi RSI(dBm)",
];
const M5_ROW = [
  "2026-01-08 10:08:27", "24026902", "2026-01-08 10:08",
  "4.831999779", "21.3125", "0", "0.100000001", "0.100000001",
  "0.008", "0", "65.53500366", "0", "-79",
];

const MX_HEADER = [
  "Date", "MCC", "MNC", "area code", "cell id",
  "座標(latitude,longitude)", "loc_accuracy",
  "locTemp", "locTemp_id", "locPrec", "locPrec_id", "locSun", "locSun_id",
  "SerialNumber", "Date from logger",
  "Battery capacity(mV)", "Battery残量(%)",
  "Battery_current(mA)", "Battery_voltage(mV)", "Battery_temperature(°C)",
  "addr", "Temperature(degC)",
  "VWC(%)", "VWC_coco(%)", "VWC_rock(%)",
  "EC bulk(dS/m)", "EC_pore(dS/m)", "EC_porecoco(dS/m)",
  "外気温", "1hの降水量", "1hの日照時間",
];
const MX_ROW = [
  "2026-07-18 17:00:43", "440", "10", "25213", "128176148",
  "REDACTED", "4114",
  "66421", "REDACTED", "66421", "REDACTED", "66421", "REDACTED",
  "25037029", "2026-07-18 17:00:26",
  "916", "36", "-456", "6400", "31",
  "0", "34.375",
  "62.6", "100", "91",
  "0.243", "0.745", "",
  "29.3", "0", "0.6",
];

describe("m5stack adapter", () => {
  it("maps the header row to normalized fields", () => {
    const rows = toNormalized("m5stack", [M5_HEADER, M5_ROW]);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.deviceId).toBe("24026902");
    expect(r.battery_v).toBeCloseTo(4.831999779);
    expect(r.temperature_c).toBeCloseTo(21.3125);
    expect(r.vwc_coco_pct).toBeCloseTo(0.100000001);
    expect(r.rssi_dbm).toBe(-79);
    expect(r.error_flag).toBe(0);
  });
  it("does not expose Date from M5Stack", () => {
    expect("Date from M5Stack" in M5_HEADERS).toBe(false);
  });
  it("skips blank and short rows safely", () => {
    const rows = toNormalized("m5stack", [M5_HEADER, [], M5_ROW, M5_ROW.slice(0, 3)]);
    expect(rows.length).toBe(2);
    expect(rows[1].vwc_pct).toBeUndefined();
  });
});

describe("mechatrax adapter", () => {
  it("converts mV to V for battery_voltage and reads AMeDAS columns", () => {
    const rows = toNormalized("mechatrax", [MX_HEADER, MX_ROW]);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.deviceId).toBe("25037029");
    expect(r.battery_pct).toBe(36);
    expect(r.battery_v).toBeCloseTo(6.4);
    expect(r.temperature_c).toBeCloseTo(34.375);
    expect(r.vwc_pct).toBeCloseTo(62.6);
    expect(r.ec_pore_coco_dsm).toBeUndefined();
    expect(r.air_temp_c).toBe(29.3);
    expect(r.sunshine_1h_h).toBeCloseTo(0.6);
  });
  it("never maps sensitive columns", () => {
    for (const k of [
      "MCC", "MNC", "area code", "cell id",
      "座標(latitude,longitude)", "loc_accuracy",
      "locTemp_id", "locPrec_id", "locSun_id",
    ]) {
      expect(k in MX_HEADERS).toBe(false);
    }
  });
});

describe("remote-ftp adapter", () => {
  it("reads published columns", () => {
    const rows = toNormalized("remote-ftp", [
      ["date", "siteId", "addr", "number", "battery1", "battery2", "bulk_ec", "vwc"],
      ["2026-06-15 09:05:00+09:00", "site-a", "fac", "1", "3.45", "2.812", "0.860", "57.5"],
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].deviceId).toBe("fac");
    expect(rows[0].battery_v).toBeCloseTo(3.45);
    expect(rows[0].ec_bulk_dsm).toBeCloseTo(0.86);
    expect(rows[0].vwc_pct).toBeCloseTo(57.5);
  });
});

describe("resolveAllowedSources", () => {
  const sources: SourceRow[] = [
    { sourceId: "s1", displayName: "S1", schemaType: "m5stack",
      spreadsheetId: "x", sheetName: "Sheet1", headerRow: 1,
      siteId: "a", tz: "Asia/Tokyo", accessMode: "direct", enabled: true },
    { sourceId: "s2", displayName: "S2", schemaType: "mechatrax",
      spreadsheetId: "y", sheetName: "Sheet1", headerRow: 1,
      siteId: "b", tz: "Asia/Tokyo", accessMode: "direct", enabled: true },
    { sourceId: "s3", displayName: "S3", schemaType: "remote-ftp",
      spreadsheetId: "z", sheetName: "sensor_raw", headerRow: 1,
      siteId: "c", tz: "Asia/Tokyo", accessMode: "direct", enabled: false },
  ];
  const users: UserRow[] = [
    { email: "admin@example.com", role: "admin", enabled: true },
    { email: "v@example.com", role: "viewer", enabled: true },
    { email: "disabled@example.com", role: "viewer", enabled: false },
  ];
  const acl: AclRow[] = [
    { email: "v@example.com", sourceId: "s1", permission: "read" },
  ];

  it("admin sees all enabled sources, ignoring acl rows", () => {
    expect(resolveAllowedSources("admin@example.com", sources, users, acl)
      .map((s) => s.sourceId)).toEqual(["s1", "s2"]);
  });
  it("viewer sees only acl-listed sources", () => {
    expect(resolveAllowedSources("v@example.com", sources, users, acl)
      .map((s) => s.sourceId)).toEqual(["s1"]);
  });
  it("unknown / disabled email gets nothing", () => {
    expect(resolveAllowedSources("nope@example.com", sources, users, acl)).toEqual([]);
    expect(resolveAllowedSources("disabled@example.com", sources, users, acl)).toEqual([]);
  });
  it("wildcard acl returns all enabled sources", () => {
    const acl2: AclRow[] = [{ email: "v@example.com", sourceId: "*", permission: "read" }];
    expect(resolveAllowedSources("v@example.com", sources, users, acl2)
      .map((s) => s.sourceId)).toEqual(["s1", "s2"]);
  });
  it("matches acl rows even when email and sourceId casing differ", () => {
    const users2: UserRow[] = [
      { email: " Viewer@Example.com ", role: "viewer", enabled: true },
    ];
    const acl2: AclRow[] = [
      { email: "viewer@example.com", sourceId: " S1 ", permission: "read" },
    ];
    expect(resolveAllowedSources("viewer@example.com", sources, users2, acl2)
      .map((s) => s.sourceId)).toEqual(["s1"]);
  });
});
