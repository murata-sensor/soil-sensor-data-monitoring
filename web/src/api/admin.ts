import type { Theme } from "../types";
import { getValidIdToken } from "../auth/google";
import { isThemeConfig } from "../configValidation";

const GAS_URL = import.meta.env.VITE_GAS_ADMIN_URL;

function requireUrl(): string {
  if (!GAS_URL) throw new Error("VITE_GAS_ADMIN_URL is not set");
  return GAS_URL;
}

async function call(idToken: string, body: Record<string, unknown>) {
  const res = await fetch(requireUrl(), {
    method: "POST",
    body: JSON.stringify({ idToken: await getValidIdToken(idToken), ...body }),
  });
  if (!res.ok) throw new Error(`admin api error ${res.status}`);
  const json = (await res.json()) as {
    ok: boolean; error?: string; values?: string[][]; written?: number; revision?: string;
  };
  if (json.error === "conflict") throw new Error("設定が更新されています。現在の編集内容は保存されていません。再読み込みして内容を確認してください。");
  if (json.error === "admin_required") throw new Error("操作できる有効な管理者を少なくとも1人残してください。設定は保存されていません。");
  if (json.error === "invalid_users") throw new Error("利用者のメールアドレスが重複しています。1人につき1行に整理してください。設定は保存されていません。");
  if (json.error === "invalid_sources") throw new Error("ソースIDの重複、またはソース設定の列の不足・重複があります。設定は保存されていません。");
  if (json.error === "invalid_acl") throw new Error("閲覧権限の設定に必要な列の不足・重複があります。設定は保存されていません。");
  if (!json.ok) throw new Error(json.error || "admin api failed");
  if (!json.revision) throw new Error("管理APIの更新が必要です。新しいバージョンを配備してから画面を開き直してください。");
  return json;
}

export async function adminGetSheet(idToken: string, sheet: string): Promise<{ values: string[][]; revision: string }> {
  const r = await call(idToken, { action: "getSheet", sheet });
  return { values: (r.values ?? []).map((row) => row.map((c) => String(c ?? ""))), revision: r.revision! };
}

export async function adminPutRows(
  idToken: string,
  sheet: string,
  rows: (string | number)[][],
  expectedRevision: string,
): Promise<{ written: number; revision: string }> {
  const r = await call(idToken, { action: "putRows", sheet, rows, expectedRevision });
  return { written: r.written ?? 0, revision: r.revision! };
}

export async function adminSaveTheme(idToken: string, theme: Theme, expectedRevision: string): Promise<string> {
  if (!isThemeConfig(theme)) throw new Error("テーマの形式が不正です。設定は保存されていません。");
  const result = await adminPutRows(idToken, "theme", [
    ["themeId", "json"],
    [theme.themeId, JSON.stringify(theme)],
  ], expectedRevision);
  return result.revision;
}
