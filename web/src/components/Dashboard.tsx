import { useEffect, useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import {
  CategoryScale, Chart as ChartJS, Filler, Legend, LinearScale, LineElement,
  PointElement, TimeScale, Title, Tooltip,
} from "chart.js";
import "chartjs-adapter-date-fns";
import {
  loadAcl, loadDataSource, loadEvents, loadSources, loadTheme, loadUsers,
  resolveAllowedSources,
} from "../api/sheets";
import { useApp } from "../store";
import {
  SCHEMA_EXTRA_PANELS,
  type EventRow, type SourceRow, type ThemePanel,
} from "../types";
import type { NormalizedRow } from "../adapters";

ChartJS.register(
  CategoryScale, LinearScale, LineElement, PointElement, TimeScale,
  Title, Tooltip, Legend, Filler,
);

function downloadCsv(filename: string, rows: NormalizedRow[]) {
  if (!rows.length) return;
  const headers = Array.from(new Set<string>(
    rows.flatMap((r) => Object.keys(r)),
  ));
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => {
      const v = (r as Record<string, unknown>)[h];
      return v === undefined || v === null ? "" : String(v);
    }).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export default function Dashboard() {
  const { user, theme, setTheme, selectedSourceId, setSelectedSource } = useApp();
  const [, setSources] = useState<SourceRow[]>([]);
  const [allowed, setAllowed] = useState<SourceRow[]>([]);
  const [rows, setRows] = useState<NormalizedRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unregistered, setUnregistered] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Load registry on mount.
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const [src, users, acl, ev, t] = await Promise.all([
          loadSources(), loadUsers(), loadAcl(), loadEvents(), loadTheme(),
        ]);
        setSources(src); setEvents(ev);
        if (t) setTheme(t);
        const me = users.find((u) => u.email.toLowerCase() === user.email.toLowerCase());
        if (!me || !me.enabled) { setUnregistered(true); return; }
        setIsAdmin(me.role === "admin");
        const list = resolveAllowedSources(user.email, src, users, acl);
        setAllowed(list);
        if (list.length && !selectedSourceId) {
          setSelectedSource(list[0]);
        }
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [user, setTheme, setSelectedSource, selectedSourceId]);

  // Load data when source changes.
  useEffect(() => {
    if (!user || !selectedSourceId) return;
    const src = allowed.find((s) => s.sourceId === selectedSourceId);
    if (!src) return;
    setLoading(true); setError(null);
    loadDataSource(src, user.idToken)
      .then((r) => setRows(r.rows))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [user, allowed, selectedSourceId]);

  const selected = useMemo(
    () => allowed.find((s) => s.sourceId === selectedSourceId) || null,
    [allowed, selectedSourceId],
  );

  const panels = useMemo<ThemePanel[]>(() => {
    if (!selected) return theme.panels;
    return [...theme.panels, ...(SCHEMA_EXTRA_PANELS[selected.schemaType] || [])];
  }, [selected, theme.panels]);

  const visibleEvents = useMemo(
    () => (selected ? events.filter((e) => e.sourceId === selected.sourceId) : []),
    [selected, events],
  );

  if (unregistered) {
    return (
      <div className="p-10 text-center text-rose-600">
        このアカウント ({user?.email}) は登録されていません。管理者に連絡してください。
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: theme.bg, color: theme.text }}>
      <header className="px-6 py-4 flex flex-wrap gap-2 justify-between items-center border-b"
        style={{ background: theme.surface }}>
        <div className="text-lg font-semibold">Soil Sensor Monitor</div>
        <div className="flex gap-2 items-center text-sm">
          <label className="text-slate-600">データソース：</label>
          <select
            value={selectedSourceId || ""}
            onChange={(e) => setSelectedSource(e.target.value || null)}
            className="border rounded px-2 py-1 bg-white min-w-[14rem]"
          >
            {allowed.length === 0 && <option value="">(アクセス可能なソースなし)</option>}
            {allowed.map((s) => (
              <option key={s.sourceId} value={s.sourceId}>
                {s.displayName} [{s.schemaType}]
              </option>
            ))}
          </select>
          <button
            onClick={() => selected && downloadCsv(`${selected.sourceId}.csv`, rows)}
            disabled={!rows.length}
            className="px-3 py-1 rounded bg-emerald-600 text-white disabled:opacity-50">
            CSV ダウンロード
          </button>
          {isAdmin && (
            <a href="./admin" className="px-3 py-1 rounded bg-slate-800 text-white">管理</a>
          )}
        </div>
      </header>

      {error && (
        <div className="m-4 p-3 rounded bg-rose-100 text-rose-700 text-sm">{error}</div>
      )}
      {loading && <div className="m-4 text-sm text-slate-500">読み込み中…</div>}

      <main className="p-4 grid grid-cols-12 gap-4 auto-rows-[80px]">
        {panels.map((p) => (
          <Panel key={p.id} panel={p} rows={rows} events={visibleEvents}
            colors={theme.chartColors} />
        ))}
      </main>
    </div>
  );
}

function Panel({ panel, rows, events, colors }: {
  panel: ThemePanel;
  rows: NormalizedRow[];
  events: EventRow[];
  colors: string[];
}) {
  const style: React.CSSProperties = {
    gridColumn: `span ${panel.w} / span ${panel.w}`,
    gridRow: `span ${panel.h} / span ${panel.h}`,
  };
  const datasets = useMemo(() => buildDatasets(panel, rows, colors), [panel, rows, colors]);
  const annotations = useMemo(() => events.map((e) => ({
    type: "line" as const, xMin: e.date, xMax: e.date,
    borderColor: e.color || "#ef4444", borderWidth: 1,
    label: { content: e.label, display: true },
  })), [events]);
  return (
    <section className="bg-white rounded-2xl shadow p-3 flex flex-col" style={style}>
      <h3 className="text-sm font-semibold mb-2">{panel.title}</h3>
      <div className="relative flex-1 min-h-0">
        <Line
          data={{ datasets }}
          options={{
            responsive: true, maintainAspectRatio: false,
            parsing: false, animation: false,
            scales: {
              x: { type: "time", time: { tooltipFormat: "yyyy-MM-dd HH:mm" } },
              y: { min: panel.yMin, max: panel.yMax },
            },
            plugins: {
              legend: { display: true, position: "bottom" as const },
              tooltip: { mode: "nearest", intersect: false },
              // @ts-expect-error annotation plugin not registered; harmless if absent
              annotation: { annotations },
            },
            elements: {
              point: { radius: panel.showPoints ? 2 : 0 },
              line: { borderWidth: 1.5, tension: 0.1 },
            },
          }}
        />
      </div>
    </section>
  );
}

function buildDatasets(panel: ThemePanel, rows: NormalizedRow[], colors: string[]) {
  // Group by deviceId so multi-device sources show one line per device.
  const groups = new Map<string, { color: string; label: string; data: { x: string; y: number }[] }>();
  let i = 0;
  for (const r of rows) {
    const v = (r as Record<string, unknown>)[panel.metric];
    if (typeof v !== "number" || !r.ts) continue;
    const key = r.deviceId || "(default)";
    if (!groups.has(key)) {
      groups.set(key, { color: colors[i % colors.length], label: key, data: [] });
      i++;
    }
    groups.get(key)!.data.push({ x: r.ts, y: v });
  }
  return Array.from(groups.values()).map((g) => ({
    label: g.label, borderColor: g.color, data: g.data,
  }));
}
