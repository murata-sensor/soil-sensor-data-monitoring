import type { NormalizedRow } from "./adapters";
import type { LayoutConfig } from "./layoutConfig";
import { parseTs } from "./settings";

export interface DeviceReplacement {
  oldDeviceId: string;
  newDeviceId: string;
  effectiveFrom: string;
}

export function applyDeviceReplacements(
  rows: NormalizedRow[], replacements: DeviceReplacement[], timeZone = "Asia/Tokyo",
): NormalizedRow[] {
  if (!replacements.length) return rows;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const ordered = replacements.map((replacement) => {
    const effectiveMs = parseTs(replacement.effectiveFrom);
    const parts = Object.fromEntries(formatter.formatToParts(effectiveMs).map((part) => [part.type, part.value]));
    const localMs = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second),
    ) + (effectiveMs % 1000);
    return { ...replacement, effectiveMs, localMs };
  }).sort((a, b) => b.effectiveMs - a.effectiveMs);
  return rows.map((row) => {
    if (!row.deviceId || !row.ts) return row;
    const normalized = row.ts.replace(" ", "T");
    const isLocalTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/.test(normalized);
    const timestamp = isLocalTime
      ? Date.parse(normalized + "Z")
      : parseTs(row.ts);
    if (!Number.isFinite(timestamp)) return row;
    let deviceId = row.deviceId;
    for (const replacement of ordered) {
      const cutoff = isLocalTime ? replacement.localMs : replacement.effectiveMs;
      if (deviceId === replacement.newDeviceId && timestamp >= cutoff) {
        deviceId = replacement.oldDeviceId;
      }
    }
    return deviceId === row.deviceId ? row : { ...row, deviceId };
  });
}

export function applyReplacementsToLayout(
  layout: LayoutConfig, replacements: DeviceReplacement[], year: number, timeZone: string,
): LayoutConfig {
  if (!replacements.length) return layout;
  const endOfYear = `${year}-12-31 23:59:59`;
  const resolve = (deviceId: string) => applyDeviceReplacements(
    [{ ts: endOfYear, deviceId }], replacements, timeZone,
  )[0].deviceId ?? deviceId;
  return {
    ...layout,
    devices: layout.devices?.map(resolve),
    panels: layout.panels.map((panel) =>
      "deviceFilter" in panel && panel.deviceFilter
        ? { ...panel, deviceFilter: panel.deviceFilter.map(resolve) }
        : panel),
  };
}
