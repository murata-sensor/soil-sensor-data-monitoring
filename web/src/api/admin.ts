import type { Theme } from "../types";

const GAS_URL = import.meta.env.VITE_GAS_ADMIN_URL;

function requireUrl(): string {
  if (!GAS_URL) throw new Error("VITE_GAS_ADMIN_URL is not set");
  return GAS_URL;
}

async function call(idToken: string, body: Record<string, unknown>) {
  const res = await fetch(requireUrl(), {
    method: "POST",
    body: JSON.stringify({ idToken, ...body }),
  });
  if (!res.ok) throw new Error(`admin api error ${res.status}`);
  const json = (await res.json()) as {
    ok: boolean; error?: string; values?: string[][]; written?: number;
  };
  if (!json.ok) throw new Error(json.error || "admin api failed");
  return json;
}

export async function adminGetSheet(idToken: string, sheet: string): Promise<string[][]> {
  const r = await call(idToken, { action: "getSheet", sheet });
  return (r.values ?? []).map((row) => row.map((c) => String(c ?? "")));
}

export async function adminPutRows(
  idToken: string,
  sheet: string,
  rows: (string | number)[][],
): Promise<number> {
  const r = await call(idToken, { action: "putRows", sheet, rows });
  return r.written ?? 0;
}

export async function adminSaveTheme(idToken: string, theme: Theme): Promise<void> {
  await adminPutRows(idToken, "theme", [
    ["themeId", "json"],
    [theme.themeId, JSON.stringify(theme)],
  ]);
}
