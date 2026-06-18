/**
 * Sheets API access layer.
 *
 * - `readRegistry()` reads the registry spreadsheet (sources/users/acl/theme/layouts).
 * - `loadDataSource(source)` reads one data-source spreadsheet via direct or proxy
 *   mode and runs the matching schema adapter.
 * - `loadSourceEvents(source)` reads events from the data-source spreadsheet's `events` tab.
 */

import { getAccessToken } from "../auth/google";
import { toNormalized, type NormalizedRow } from "../adapters";
import type {
  AclRow, EventRow, SourceRow, Theme, UserRow,
} from "../types";
import type { LayoutConfig } from "../layoutConfig";

const REGISTRY_ID = import.meta.env.VITE_REGISTRY_SPREADSHEET_ID;
const PROXY_URL = import.meta.env.VITE_GAS_PROXY_URL;

export class RegistryAccessDeniedError extends Error {
  constructor(range: string) {
    super(`スプレッドシートへのアクセス権がありません (${range})`);
    this.name = "RegistryAccessDeniedError";
  }
}

async function sheetsGet(spreadsheetId: string, range: string): Promise<string[][]> {
  const MAX_RETRIES = 3;
  let delay = 1000; // initial backoff 1s
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const token = await getAccessToken();
    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}` +
      `/values/${encodeURIComponent(range)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
      continue;
    }
    if (!res.ok) {
      if (res.status === 403) throw new RegistryAccessDeniedError(range);
      throw new Error(`Sheets API ${res.status} on ${range}`);
    }
    const json = (await res.json()) as { values?: string[][] };
    return json.values ?? [];
  }
  throw new Error(`Sheets API 429 on ${range} (retries exhausted)`);
}

function toObjects<T>(values: string[][]): T[] {
  if (!values.length) return [];
  const [header, ...rows] = values;
  return rows.map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => { obj[h] = (r[i] ?? "").toString(); });
    return obj as unknown as T;
  });
}

function parseBool(v: string | boolean | undefined): boolean {
  if (typeof v === "boolean") return v;
  if (!v) return false;
  return /^(true|1|yes|y)$/i.test(v.trim());
}

function normalizeEmail(value: string | undefined): string {
  return (value || "").trim().toLowerCase();
}

function normalizeSourceId(value: string | undefined): string {
  return (value || "").trim().toLowerCase();
}

// ─── registry reads ─────────────────────────────────────────────────────────

export async function readRegistry(range: string): Promise<string[][]> {
  if (!REGISTRY_ID) throw new Error("VITE_REGISTRY_SPREADSHEET_ID is not set");
  return sheetsGet(REGISTRY_ID, range);
}

/** Result of loading all registry sheets at once. */
export interface RegistryData {
  sources: SourceRow[];
  users: UserRow[];
  acl: AclRow[];
  theme: Theme | null;
  layouts: LayoutConfig[];
}

/**
 * Load all registry data. Tries direct Sheets API first; on 403 falls back
 * to the GAS proxy (action=registry) so users without direct spreadsheet
 * access can still use the app.
 */
export async function loadAllRegistry(idToken: string): Promise<RegistryData> {
  try {
    const [src, users, acl, t, lays] = await Promise.all([
      loadSources(), loadUsers(), loadAcl(), loadTheme(), loadLayouts(),
    ]);
    return { sources: src, users, acl, theme: t, layouts: lays };
  } catch (e) {
    if (e instanceof RegistryAccessDeniedError && PROXY_URL) {
      return loadRegistryViaProxy(idToken);
    }
    throw e;
  }
}

async function loadRegistryViaProxy(idToken: string): Promise<RegistryData> {
  if (!PROXY_URL) throw new Error("VITE_GAS_PROXY_URL is not set");
  const res = await fetch(PROXY_URL, {
    method: "POST",
    body: JSON.stringify({ idToken, action: "registry" }),
  });
  if (!res.ok) throw new Error(`proxy ${res.status}`);
  const json = (await res.json()) as {
    ok: boolean;
    error?: string;
    sources?: string[][];
    users?: string[][];
    acl?: string[][];
    theme?: string[][];
    layouts?: string[][];
  };
  if (!json.ok) {
    if (json.error === "user_not_registered") {
      throw new UserNotRegisteredError();
    }
    throw new Error(json.error || "proxy registry denied");
  }
  return {
    sources: parseSources(toObjects<Record<string, string>>(json.sources ?? [])),
    users: parseUsers(toObjects<Record<string, string>>(json.users ?? [])),
    acl: parseAcl(toObjects<Record<string, string>>(json.acl ?? [])),
    theme: parseTheme(json.theme ?? []),
    layouts: parseLayouts(json.layouts ?? []),
  };
}

export class UserNotRegisteredError extends Error {
  constructor() {
    super("user_not_registered");
    this.name = "UserNotRegisteredError";
  }
}

export async function loadUsers(): Promise<UserRow[]> {
  const raw = toObjects<Record<string, string>>(await readRegistry("users!A1:Z"));
  return parseUsers(raw);
}

function parseUsers(raw: Record<string, string>[]): UserRow[] {
  return raw.map((r) => ({
    email: normalizeEmail(r.email),
    role: ((r.role || "viewer").trim().toLowerCase() as UserRow["role"]),
    enabled: parseBool(r.enabled),
  })).filter((u) => u.email);
}

export async function loadSources(): Promise<SourceRow[]> {
  const raw = toObjects<Record<string, string>>(await readRegistry("sources!A1:Z"));
  return parseSources(raw);
}

function parseSources(raw: Record<string, string>[]): SourceRow[] {
  return raw.map((r) => ({
    sourceId: (r.sourceId || "").trim(),
    displayName: (r.displayName || r.sourceId || "").trim(),
    schemaType: (r.schemaType || "").trim() as SourceRow["schemaType"],
    spreadsheetId: (r.spreadsheetId || "").trim(),
    sheetName: (r.sheetName || "Sheet1").trim(),
    headerRow: Number(r.headerRow) || 1,
    siteId: (r.siteId || "").trim(),
    tz: (r.tz || "Asia/Tokyo").trim(),
    accessMode: ((r.accessMode || "direct").trim().toLowerCase() as SourceRow["accessMode"]),
    enabled: parseBool(r.enabled),
    notes: r.notes || undefined,
  })).filter((s) => s.sourceId && s.spreadsheetId && s.schemaType);
}

export async function loadAcl(): Promise<AclRow[]> {
  const raw = toObjects<Record<string, string>>(await readRegistry("acl!A1:Z"));
  return parseAcl(raw);
}

function parseAcl(raw: Record<string, string>[]): AclRow[] {
  return raw.map((r) => ({
    email: normalizeEmail(r.email),
    sourceId: (r.sourceId || "").trim(),
    permission: "read" as const,
  })).filter((a) => a.email && a.sourceId);
}

function parseEvents(raw: Record<string, string>[]): EventRow[] {
  return raw.map((r) => ({
    date: r.date,
    label: r.label,
    color: r.color || undefined,
    deviceId: r.deviceId ? r.deviceId.trim() : undefined,
  })).filter((e) => e.date && e.label);
}

/**
 * Load events from a data-source spreadsheet's `events` sheet.
 * Returns [] if the sheet does not exist.
 */
export async function loadSourceEvents(
  source: SourceRow,
  idToken?: string,
): Promise<EventRow[]> {
  try {
    const values = source.accessMode === "proxy"
      ? await readProxy(source, idToken || "", "events")
      : await sheetsGet(source.spreadsheetId, "events!A1:Z");
    return parseEvents(toObjects<Record<string, string>>(values));
  } catch {
    // events tab may not exist — that's fine
    return [];
  }
}

export async function loadTheme(): Promise<Theme | null> {
  const rows = await readRegistry("theme!A1:B");
  return parseTheme(rows);
}

function parseTheme(rows: string[][]): Theme | null {
  if (rows.length < 2) return null;
  const json = rows[1]?.[1];
  if (!json) return null;
  try { return JSON.parse(json) as Theme; } catch { return null; }
}

export async function loadLayouts(): Promise<LayoutConfig[]> {
  try {
    const rows = await readRegistry("layouts!A1:B");
    return parseLayouts(rows);
  } catch {
    // layouts sheet may not exist
    return [];
  }
}

function parseLayouts(rows: string[][]): LayoutConfig[] {
  if (rows.length < 2) return [];
  const configs: LayoutConfig[] = [];
  for (let i = 1; i < rows.length; i++) {
    const [, json] = rows[i];
    if (!json) continue;
    try {
      const cfg = JSON.parse(json) as LayoutConfig;
      if (cfg.sourceId) configs.push(cfg);
    } catch { /* skip malformed */ }
  }
  return configs;
}

// ─── per-source data reads ──────────────────────────────────────────────────

export interface DataSourceResult {
  source: SourceRow;
  rows: NormalizedRow[];
}

/**
 * Fetch the list of sheet tab names for a spreadsheet.
 * Filters out tabs whose name starts with "_".
 */
export async function getSheetNames(spreadsheetId: string): Promise<string[]> {
  const token = await getAccessToken();
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}` +
    `?fields=sheets.properties.title`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets API ${res.status} fetching sheet names`);
  const json = (await res.json()) as {
    sheets?: { properties?: { title?: string } }[];
  };
  const names = (json.sheets ?? [])
    .map((s) => s.properties?.title ?? "")
    .filter((name) => name && !name.startsWith("_") && name !== "alerts" && name !== "alert_rules" && name !== "events");
  return names;
}

/**
 * Check whether the current user can read a source sheet.
 * Uses a minimal range read to avoid loading full datasets.
 */
export async function canAccessSource(
  source: SourceRow,
  idToken?: string,
  options?: { sheetNameOverride?: string },
): Promise<boolean> {
  try {
    const sheetName = (options?.sheetNameOverride || source.sheetName).trim();
    const headerRow = Math.max(1, Number(source.headerRow) || 1);
    if (source.accessMode === "proxy") {
      await readProxy(source, idToken || "", sheetName);
      return true;
    }
    await sheetsGet(source.spreadsheetId, `${sheetName}!A${headerRow}:A${headerRow}`);
    return true;
  } catch (e) {
    if (e instanceof RegistryAccessDeniedError) return false;
    throw e;
  }
}

async function readDirect(src: SourceRow, sheetNameOverride?: string): Promise<string[][]> {
  // Read from headerRow downwards so the adapter receives the header as row 0.
  const sheetName = (sheetNameOverride || src.sheetName).trim();
  const range = `${sheetName}!A${src.headerRow}:ZZ`;
  return sheetsGet(src.spreadsheetId, range);
}

async function readProxy(src: SourceRow, idToken: string, sheetNameOverride?: string): Promise<string[][]> {
  if (!PROXY_URL) throw new Error("VITE_GAS_PROXY_URL is not set for proxy access");
  const res = await fetch(PROXY_URL, {
    method: "POST",
    body: JSON.stringify({ idToken, sourceId: src.sourceId, sheetName: sheetNameOverride || undefined }),
  });
  if (!res.ok) throw new Error(`proxy ${res.status}`);
  const json = (await res.json()) as { ok: boolean; error?: string; values?: string[][] };
  if (!json.ok) throw new Error(json.error || "proxy denied");
  return json.values ?? [];
}

export async function loadDataSource(
  source: SourceRow,
  idToken?: string,
  options?: { sheetNameOverride?: string },
): Promise<DataSourceResult> {
  const values = source.accessMode === "proxy"
    ? await readProxy(source, idToken || "", options?.sheetNameOverride)
    : await readDirect(source, options?.sheetNameOverride);
  return { source, rows: toNormalized(source.schemaType, values) };
}

// ─── access-control helper ─────────────────────────────────────────────────

export function resolveAllowedSources(
  email: string,
  sources: SourceRow[],
  users: UserRow[],
  acl: AclRow[],
): SourceRow[] {
  const e = normalizeEmail(email);
  const user = users.find((u) => normalizeEmail(u.email) === e);
  if (!user || !user.enabled) return [];
  const enabled = sources.filter((s) => s.enabled);
  if (user.role === "admin") return enabled;
  const allowed = new Set<string>();
  for (const a of acl) {
    if (normalizeEmail(a.email) !== e) continue;
    if ((a.sourceId || "").trim() === "*") return enabled;
    allowed.add(normalizeSourceId(a.sourceId));
  }
  return enabled.filter((s) => allowed.has(normalizeSourceId(s.sourceId)));
}
