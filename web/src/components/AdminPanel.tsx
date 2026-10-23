import { useEffect, useRef, useState } from "react";
import { useApp } from "../store";
import { adminGetSheet, adminPutRows, adminSaveTheme } from "../api/admin";
import { isThemeConfig } from "../configValidation";
import { signOut } from "../auth/google";

const SHEETS = ["sources", "users", "acl"] as const;
type Sheet = typeof SHEETS[number];

export default function AdminPanel() {
  const { user, theme, setTheme, setUser } = useApp();
  const accountEmail = user?.email.trim().toLowerCase();
  const [sheet, setSheet] = useState<Sheet>("sources");
  const [rows, setRows] = useState<string[][]>([]);
  const [status, setStatus] = useState<string>("");
  const [themeJson, setThemeJson] = useState<string>(JSON.stringify(theme, null, 2));
  const [revision, setRevision] = useState<string | null>(null);
  const [themeRevision, setThemeRevision] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const screenActive = useRef(false);

  useEffect(() => {
    screenActive.current = true;
    return () => { screenActive.current = false; };
  }, []);

  useEffect(() => {
    if (!user) return;
    let active = true;
    setRevision(null);
    setRows([]);
    (async () => {
      try {
        const snapshot = await adminGetSheet(user.idToken, sheet);
        if (active) { setRows(snapshot.values); setRevision(snapshot.revision); }
      } catch (e) { if (active) setStatus(String(e)); }
    })();
    return () => { active = false; };
  }, [sheet, accountEmail, reloadKey]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    setThemeRevision(null);
    void adminGetSheet(user.idToken, "theme").then((snapshot) => {
      if (!active) return;
      const jsonColumn = snapshot.values[0]?.indexOf("json") ?? -1;
      const json = snapshot.values[1]?.[jsonColumn];
      if (json) setThemeJson(json);
      setThemeRevision(snapshot.revision);
    }).catch((error) => { if (active) setStatus(String(error)); });
    return () => { active = false; };
  }, [accountEmail, reloadKey]);

  if (!user) return <div className="p-8">サインインが必要です。</div>;

  const isCurrentAccount = () => screenActive.current
    && useApp.getState().user?.email.trim().toLowerCase() === user.email.trim().toLowerCase();

  const updateCell = (r: number, c: number, v: string) => {
    const next = rows.map((row) => row.slice());
    while (next.length <= r) next.push([]);
    while (next[r].length <= c) next[r].push("");
    next[r][c] = v;
    setRows(next);
  };

  const save = async () => {
    if (!revision || saving) return;
    setSaving(true);
    try {
      const result = await adminPutRows(user.idToken, sheet, rows, revision);
      if (!isCurrentAccount()) return;
      setRevision(result.revision);
      setStatus(`保存しました (${result.written} 行)`);
    } catch (e) { if (isCurrentAccount()) setStatus(String(e)); }
    finally { if (isCurrentAccount()) setSaving(false); }
  };

  const saveTheme = async () => {
    if (!themeRevision || saving) return;
    setSaving(true);
    try {
      const parsed: unknown = JSON.parse(themeJson);
      if (!isThemeConfig(parsed)) throw new Error("テーマの形式が不正です。設定は保存されていません。");
      const savedRevision = await adminSaveTheme(user.idToken, parsed, themeRevision);
      if (!isCurrentAccount()) return;
      setThemeRevision(savedRevision);
      setTheme(parsed);
      setStatus("テーマを保存しました");
    } catch (e) { if (isCurrentAccount()) setStatus(`テーマを保存できませんでした: ${e}`); }
    finally { if (isCurrentAccount()) setSaving(false); }
  };

  return (
    <div className="min-h-screen p-6 bg-slate-50">
      <header className="flex justify-between mb-4">
        <h1 className="text-lg font-semibold">管理画面 (Registry)</h1>
        <div className="flex items-center gap-3">
          <a href="./" className="text-sky-700 underline">← ダッシュボード</a>
          <button
            onClick={() => {
              signOut();
              setUser(null);
            }}
            className="px-3 py-1 rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
          >
            ログアウト
          </button>
        </div>
      </header>

      <nav className="mb-4 flex gap-2">
        {SHEETS.map((s) => (
          <button key={s} onClick={() => setSheet(s)} disabled={saving}
            className={`px-3 py-1 rounded ${sheet === s ? "bg-sky-600 text-white" : "bg-white border"}`}>
            {s}
          </button>
        ))}
      </nav>

      {status && <div className="mb-3 text-sm text-emerald-700">{status}</div>}

      <div className="bg-white rounded shadow overflow-auto mb-4">
        <table className="text-sm w-full">
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className={ri === 0 ? "bg-slate-100 font-semibold" : ""}>
                {row.map((cell, ci) => (
                  <td key={ci} className="border p-1">
                    <input value={cell} disabled={saving}
                      onChange={(e) => updateCell(ri, ci, e.target.value)}
                      className="w-full px-1 py-0.5 outline-none" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex gap-2 mb-8">
        <button onClick={save} disabled={!revision || saving} className="px-4 py-2 bg-sky-600 text-white rounded disabled:opacity-50">{sheet} を保存</button>
        <button onClick={() => setRows([...rows, []])} disabled={!revision || saving} className="px-4 py-2 bg-slate-200 rounded disabled:opacity-50">行追加</button>
        <button disabled={saving} onClick={() => {
          if (window.confirm("編集中の内容を破棄して、最新の設定を読み込みますか？")) {
            setStatus("");
            setReloadKey((key) => key + 1);
          }
        }} className="px-4 py-2 bg-slate-200 rounded disabled:opacity-50">再読み込み</button>
      </div>

      <section>
        <h2 className="text-md font-semibold mb-2">テーマ (JSON)</h2>
        <textarea value={themeJson} disabled={!themeRevision || saving} onChange={(e) => setThemeJson(e.target.value)}
          className="w-full h-64 font-mono text-xs p-2 border rounded" />
        <div className="mt-2">
          <button onClick={saveTheme} disabled={!themeRevision || saving} className="px-4 py-2 bg-emerald-600 text-white rounded disabled:opacity-50">テーマを保存</button>
        </div>
      </section>
    </div>
  );
}
