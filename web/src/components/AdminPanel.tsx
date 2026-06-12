import { useEffect, useState } from "react";
import { useApp } from "../store";
import { adminGetSheet, adminPutRows, adminSaveTheme } from "../api/admin";
import type { Theme } from "../types";
import { signOut } from "../auth/google";

const SHEETS = ["sources", "users", "acl", "events"] as const;
type Sheet = typeof SHEETS[number];

export default function AdminPanel() {
  const { user, theme, setTheme, setUser } = useApp();
  const [sheet, setSheet] = useState<Sheet>("sources");
  const [rows, setRows] = useState<string[][]>([]);
  const [status, setStatus] = useState<string>("");
  const [themeJson, setThemeJson] = useState<string>(JSON.stringify(theme, null, 2));

  useEffect(() => {
    if (!user) return;
    (async () => {
      try { setRows(await adminGetSheet(user.idToken, sheet)); }
      catch (e) { setStatus(String(e)); }
    })();
  }, [sheet, user]);

  if (!user) return <div className="p-8">サインインが必要です。</div>;

  const updateCell = (r: number, c: number, v: string) => {
    const next = rows.map((row) => row.slice());
    while (next.length <= r) next.push([]);
    while (next[r].length <= c) next[r].push("");
    next[r][c] = v;
    setRows(next);
  };

  const save = async () => {
    try {
      const written = await adminPutRows(user.idToken, sheet, rows);
      setStatus(`保存しました (${written} 行)`);
    } catch (e) { setStatus(String(e)); }
  };

  const saveTheme = async () => {
    try {
      const parsed = JSON.parse(themeJson) as Theme;
      await adminSaveTheme(user.idToken, parsed);
      setTheme(parsed);
      setStatus("テーマを保存しました");
    } catch (e) { setStatus(`テーマJSONエラー: ${e}`); }
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
          <button key={s} onClick={() => setSheet(s)}
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
                    <input value={cell}
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
        <button onClick={save} className="px-4 py-2 bg-sky-600 text-white rounded">{sheet} を保存</button>
        <button onClick={() => setRows([...rows, []])} className="px-4 py-2 bg-slate-200 rounded">行追加</button>
      </div>

      <section>
        <h2 className="text-md font-semibold mb-2">テーマ (JSON)</h2>
        <textarea value={themeJson} onChange={(e) => setThemeJson(e.target.value)}
          className="w-full h-64 font-mono text-xs p-2 border rounded" />
        <div className="mt-2">
          <button onClick={saveTheme} className="px-4 py-2 bg-emerald-600 text-white rounded">テーマを保存</button>
        </div>
      </section>
    </div>
  );
}
