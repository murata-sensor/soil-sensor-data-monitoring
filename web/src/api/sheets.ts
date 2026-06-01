/**
 * Sheets API access layer.
 *
 * - `readRegistry()` reads the registry spreadsheet (sources/users/acl/theme/events).
 * - `loadDataSource(source)` reads one data-source spreadsheet via direct or proxy
 *   mode and runs the matching schema adapter.
 */

import { getAccessToken } from "../auth/google";
import { toNormalized, type NormalizedRow } from "../adapters";
import type {
  AclRow, EventRow, SourceRow, Theme, UserRow,
} from "../types";

const REGISTRY_ID = import.meta.env.VITE_REGISTRY_SPREADSHEET_ID;
const PROXY_URL = import.meta.env.VITE_GAS_PROXY_URL;

async function sheetsGet(spreadsheetId: string, range: string): Promise<string[][]> {
  const token = await getAccessToken();
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}` +
    `/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets API ${res.status} on ${range}`);
  const json = (await res.json()) as { values?: string[][] };
  return json.values ?? [];
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

// ─── registry reads ─────────────────────────────────────────────────────────

export async function readRegistry(range: string): Promise<string[][]> {
  if (!REGISTRY_ID) throw new Error("VITE_REGISTRY_SPREADSHEET_ID is not set");
  return sheetsGet(REGISTRY_ID, range);
}

export async function loadUsers(): Promise<UserRow[]> {
  const raw = toObjects<Record<string, string>>(await readRegistry("users!A1:Z"));
  return raw.map((r) => ({
    email: (r.email || "").trim(),
    role: ((r.role || "viewer").trim().toLowerCase() as UserRow["role"]),
    enabled: parseBool(r.enabled),
  })).filter((u) => u.email);
}

export async function loadSources(): Promise<SourceRow[]> {
  const raw = toObjects<Record<string, string>>(await readRegistry("sources!A1:Z"));
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
  return raw.map((r) => ({
    email: (r.email || "").trim().toLowerCase(),
    sourceId: (r.sourceId || "").trim(),
    permission: "read" as const,
  })).filter((a) => a.email && a.sourceId);
}

export async function loadEvents(): Promise<EventRow[]> {
  const raw = toObjects<Record<string, string>>(await readRegistry("events!A1:Z"));
  return raw.map((r) => ({
    date: r.date, sourceId: r.sourceId, label: r.label,
    color: r.color || undefined,
  })).filter((e) => e.date && e.sourceId);
}

export async function loadTheme(): Promise<Theme | null> {
  const rows = await readRegistry("theme!A1:B");
  if (rows.length < 2) return null;
  const json = rows[1]?.[1];
  if (!json) return null;
  try { return JSON.parse(json) as Theme; } catch { return null; }
}

// ─── per-source data reads ──────────────────────────────────────────────────

export interface DataSourceResult {
  source: SourceRow;
  rows: NormalizedRow[];
}

async function readDirect(src: SourceRow): Promise<string[][]> {
  // Read from headerRow downwards so the adapter receives the header as row 0.
  const range = `${src.sheetName}!A${src.headerRow}:ZZ`;
  return sheetsGet(src.spreadsheetId, range);
}

async function readProxy(src: SourceRow, idToken: string): Promise<string[][]> {
  if (!PROXY_URL) throw new Error("VITE_GAS_PROXY_URL is not set for proxy access");
  const res = await fetch(PROXY_URL, {
    method: "POST",
    body: JSON.stringify({ idToken, sourceId: src.sourceId }),
  });
  if (!res.ok) throw new Error(`proxy ${res.status}`);
  const json = (await res.json()) as { ok: boolean; error?: string; values?: string[][] };
  if (!json.ok) throw new Error(json.error || "proxy denied");
  return json.values ?? [];
}

export async function loadDataSource(
  source: SourceRow,
  idToken?: string,
): Promise<DataSourceResult> {
  const values = source.accessMode === "proxy"
    ? await readProxy(source, idToken || "")
    : await readDirect(source);
  return { source, rows: toNormalized(source.schemaType, values) };
}

// ─── access-control helper ─────────────────────────────────────────────────

export function resolveAllowedSources(
  email: string,
  sources: SourceRow[],
  users: UserRow[],
  acl: AclRow[],
): SourceRow[] {
  const e = (email || "").toLowerCase();
  const user = users.find((u) => u.email.toLowerCase() === e);
  if (!user || !user.enabled) return [];
  const enabled = sources.filter((s) => s.enabled);
  if (user.role === "admin") return enabled;
  const allowed = new Set<string>();
  for (const a of acl) {
    if (a.email !== e) continue;
    if (a.sourceId === "*") return enabled;
    allowed.add(a.sourceId);
  }
  return enabled.filter((s) => allowed.has(s.sourceId));
}
