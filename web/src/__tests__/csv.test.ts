import { describe, expect, it } from "vitest";
import { toCsv } from "../csv";

describe("CSV row boundaries", () => {
  it("leaves missing special-name columns empty", () => {
    const row = JSON.parse('{"toString":"sensor-value","constructor":"own-constructor","__proto__":"own-proto"}');

    expect(toCsv([row, {}])).toBe(
      "toString,constructor,__proto__\r\nsensor-value,own-constructor,own-proto\r\n,,",
    );
  });

  it("does not export an inherited value for a missing column", () => {
    const inherited = Object.create({ deviceId: "inherited-device" });
    inherited.ts = "2026-10-23T00:00:00Z";

    expect(toCsv([{ deviceId: "own-device", ts: "2026-10-22T00:00:00Z" }, inherited]))
      .toBe("deviceId,ts\r\nown-device,2026-10-22T00:00:00Z\r\n,2026-10-23T00:00:00Z");
  });
});
