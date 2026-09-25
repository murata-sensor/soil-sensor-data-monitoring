import { describe, expect, it } from "vitest";
import { toNormalized } from "../adapters";
import { HEADER_MAP as M5_HEADERS } from "../adapters/m5stack";
import { HEADER_MAP as MX_HEADERS } from "../adapters/mechatrax";
import { HEADER_MAP as PC_HEADERS } from "../adapters/pcSerial";
import { parseSourceEvents, resolveAllowedSources } from "../api/sheets";
import { applyDeviceReplacements, applyReplacementsToLayout } from "../deviceReplacements";
import type { LayoutConfig } from "../layoutConfig";
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

const PC_HEADER = [
  "Date", "SerialNumber", "Battery(V)", "Temperature(degC)",
  "VWC(%)", "VWC Coconut Peat(%)", "VWC Rock Wool(%)",
  "EC bulk(dS/m)", "EC pore(dS/m)", "EC pore Coco(dS/m)",
];
const PC_ROW = [
  "2026-07-31 14:30:00", "24107928", "3.311", "21.5",
  "45.2", "44.1", "43.8",
  "0.51", "1.82", "",
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

describe("pc-serial adapter", () => {
  it("maps the header row to normalized fields", () => {
    const rows = toNormalized("pc-serial", [PC_HEADER, PC_ROW]);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.ts).toBe("2026-07-31 14:30:00");
    expect(r.deviceId).toBe("24107928");
    expect(r.battery_v).toBeCloseTo(3.311);
    expect(r.temperature_c).toBeCloseTo(21.5);
    expect(r.vwc_pct).toBeCloseTo(45.2);
    expect(r.ec_bulk_dsm).toBeCloseTo(0.51);
    expect(r.ec_pore_coco_dsm).toBeUndefined();
  });
  it("has no wireless-only columns", () => {
    expect("WiFi RSI(dBm)" in PC_HEADERS).toBe(false);
    expect("Error flag" in PC_HEADERS).toBe(false);
  });
  it("keeps sensors on one bus apart by serial number", () => {
    const second = [...PC_ROW];
    second[1] = "24107929";
    const rows = toNormalized("pc-serial", [PC_HEADER, PC_ROW, [], second]);
    expect(rows.map((r) => r.deviceId)).toEqual(["24107928", "24107929"]);
  });
});

describe("remote-ftp adapter", () => {  it("reads published columns", () => {
    const rows = toNormalized("remote-ftp", [
      ["date", "siteId", "addr", "number", "battery1", "battery2", "bulk_ec", "vwc"],
      ["2026-06-15 09:05:00+09:00", "site-a", "fac", "1", "3.45", "2.812", "0.860", "57.5"],
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].deviceId).toBe("fac");
    expect(rows[0].battery_v).toBeCloseTo(2.812);
    expect(rows[0].ec_bulk_dsm).toBeCloseTo(0.86);
    expect(rows[0].vwc_pct).toBeCloseTo(57.5);
  });

  it("reads columns with unit suffixes in headers", () => {
    const rows = toNormalized("remote-ftp", [
      ["date", "site", "addr", "number", "battery1[V]", "battery2[V]", "bulk_ec[dS/m]", "vwc[%]", "soil_temp[℃]", "air_tmp[℃]"],
      ["2026-06-11 08:59:41+09:00", "site-a", "1ca7", "1", "3.5175", "3.438", "0.474", "55.4", "22.3", "25.1"],
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].deviceId).toBe("1ca7");
    expect(rows[0].battery_v).toBeCloseTo(3.438);
    expect(rows[0].ec_bulk_dsm).toBeCloseTo(0.474);
    expect(rows[0].vwc_pct).toBeCloseTo(55.4);
    expect(rows[0].temperature_c).toBeCloseTo(22.3);
    expect(rows[0].air_temp_c).toBeCloseTo(25.1);
  });
});

describe("device replacements", () => {
  it("joins readings at the replacement time without changing sensor numbers or raw rows", () => {
    const rows = toNormalized("remote-ftp", [
      ["date", "addr", "number", "vwc"],
      ["2026-09-24 08:59:00+09:00", "fac", "1", "52"],
      ["2026-09-24 09:00:00+09:00", "1c98", "1", "53"],
      ["2026-09-24 08:59:00+09:00", "1c98", "2", "54"],
      ["2026-09-24 09:00:00+09:00", "other", "1", "55"],
    ]);
    const displayRows = applyDeviceReplacements(rows, [
      { oldDeviceId: "fac", newDeviceId: "1c98", effectiveFrom: "2026-09-24T09:00:00+09:00" },
    ]);
    expect(displayRows.map((row) => row.deviceId)).toEqual(["fac", "fac", "1c98", "other"]);
    expect(displayRows.map((row) => row.sensorNumber)).toEqual(["1", "1", "2", "1"]);
    expect(rows[1].deviceId).toBe("1c98");
  });

  it("reads replacement columns even when the chart event is hidden", () => {
    const result = parseSourceEvents([
      ["date", "label", "color", "deviceId", "enabled", "oldDeviceId", "newDeviceId"],
      ["2026-09-24 09:00:00+09:00", "送信機交換", "", "fac", "FALSE", "fac", "1c98"],
      ["2026-09-25 09:00:00+09:00", "水やり", "#ef4444", "*", "TRUE"],
      ["2026-09-26 09:00:00+09:00", "無効", "", "", "FALSE", "", "other"],
    ]);
    expect(result.replacements).toEqual([{
      oldDeviceId: "fac", newDeviceId: "1c98", effectiveFrom: "2026-09-24 09:00:00+09:00",
    }]);
    expect(result.events.map((event) => event.label)).toEqual(["水やり"]);
  });

  it("keeps a series under its original ID across multiple replacements", () => {
    const rows = [
      { ts: "2026-09-24T09:00:00+09:00", deviceId: "1c98" },
      { ts: "2026-10-01T09:00:00+09:00", deviceId: "next" },
    ];
    expect(applyDeviceReplacements(rows, [
      { oldDeviceId: "fac", newDeviceId: "1c98", effectiveFrom: "2026-09-24T09:00:00+09:00" },
      { oldDeviceId: "1c98", newDeviceId: "next", effectiveFrom: "2026-10-01T09:00:00+09:00" },
    ]).map((row) => row.deviceId)).toEqual(["fac", "fac"]);
  });

  it("resolves the new address in annual layout filters without changing labels", () => {
    const layout: LayoutConfig = {
      sourceId: "tohoku-ftp", year: 2026, devices: ["1c98"], deviceLabels: ["2026 transmitter 1c98"],
      panels: [
        { type: "chart", id: "vwc", title: "VWC", metric: "vwc_pct", deviceRef: 0,
          position: { x: 0, y: 0, w: 6, h: 3 } },
        { type: "gauge", id: "battery", title: "Battery", deviceFilter: ["1c98"],
          position: { x: 0, y: 3, w: 6, h: 2 } },
      ],
    };
    const mapped = applyReplacementsToLayout(layout, [
      { oldDeviceId: "fac", newDeviceId: "1c98", effectiveFrom: "2026-09-24 09:00:00+09:00" },
    ], 2026, "Asia/Tokyo");
    expect(mapped.devices).toEqual(["fac"]);
    expect(mapped.deviceLabels).toEqual(["2026 transmitter 1c98"]);
    expect(mapped.panels[1]).toMatchObject({ deviceFilter: ["fac"] });
    expect(layout.devices).toEqual(["1c98"]);
  });

  it.each([
    ["m5stack" as const, [M5_HEADER, M5_ROW], "24026902"],
    ["mechatrax" as const, [MX_HEADER, MX_ROW], "25037029"],
  ])("joins %s readings using the source timezone", (schema, values, oldId) => {
    const before = [...values[1]];
    const after = [...values[1]];
    const serialIndex = values[0].indexOf("SerialNumber");
    before[0] = "2026-09-24 08:59:00";
    after[0] = "2026-09-24 09:00:00";
    after[serialIndex] = "replacement";
    const rows = toNormalized(schema, [values[0], before, after]);
    expect(applyDeviceReplacements(rows, [
      { oldDeviceId: oldId, newDeviceId: "replacement", effectiveFrom: "2026-09-24T09:00:00+09:00" },
    ], "Asia/Tokyo").map((row) => row.deviceId)).toEqual([oldId, oldId]);
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
