import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import {
  CategoryScale, Chart as ChartJS, Filler, Legend, LinearScale, LineElement,
  PointElement, TimeScale, Title, Tooltip,
} from "chart.js";
import "chartjs-adapter-date-fns";
import { ResponsiveGridLayout, useContainerWidth, type Layout, type LayoutItem } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
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
import { ConsentRequiredError, requestConsentToken } from "../auth/google";
import {
  type DateRangeType, type DeviceColorMap,
  type PanelSettings, type UserSettings,
  dateRangeToMs, loadSettings, parseTs, saveSettings,
} from "../settings";

ChartJS.register(
  CategoryScale, LinearScale, LineElement, PointElement, TimeScale,
  Title, Tooltip, Legend, Filler,
);

const DATE_RANGE_OPTIONS: { value: DateRangeType; label: string }[] = [
  { value: "last24h", label: "24時間" },
  { value: "last3d", label: "3日間" },
  { value: "last7d", label: "7日間" },
  { value: "last30d", label: "30日間" },
  { value: "all", label: "全期間" },
  { value: "custom", label: "カスタム" },
];

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
  const [needsConsent, setNeedsConsent] = useState(false);
  const [settings, setSettingsState] = useState<UserSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const updateSettings = useCallback((patch: Partial<UserSettings>) => {
    if (!user || !settings) return;
    const next = { ...settings, ...patch };
    setSettingsState(next);
    saveSettings(user.email, next);
  }, [user, settings]);

  // Load settings when user logs in
  useEffect(() => {
    if (user) setSettingsState(loadSettings(user.email));
  }, [user]);

  const loadRegistry = async () => {
    if (!user) return;
    setNeedsConsent(false); setError(null);
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
      if (e instanceof ConsentRequiredError) {
        setNeedsConsent(true);
      } else {
        setError(String(e));
      }
    }
  };

  useEffect(() => { loadRegistry(); }, [user, setTheme, setSelectedSource, selectedSourceId]);

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

  // Filter rows by date range
  const filteredRows = useMemo(() => {
    if (!settings) return rows;
    const range = dateRangeToMs(settings.dateRange);
    if (!range) return rows;
    return rows.filter((r) => {
      if (!r.ts) return false;
      const ms = parseTs(r.ts);
      return ms >= range.start && ms <= range.end;
    });
  }, [rows, settings]);

  // Layout for react-grid-layout
  const defaultLayout = useMemo<LayoutItem[]>(
    () => panels.map((p) => ({ i: p.id, x: p.x, y: p.y, w: p.w, h: p.h, minW: 3, minH: 2 })),
    [panels],
  );
  const currentLayout: LayoutItem[] = settings?.layout
    ? settings.layout.map((l) => ({ ...l, minW: 3, minH: 2 }))
    : defaultLayout;

  const handleLayoutChange = useCallback((layout: Layout) => {
    if (!settings) return;
    updateSettings({
      layout: layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })),
    });
  }, [settings, updateSettings]);

  if (needsConsent) {
    return (
      <div className="p-10 text-center">
        <p className="mb-4 text-slate-700">
          Google スプレッドシートへのアクセス許可が必要です。<br />
          下のボタンをクリックして許可してください。
        </p>
        <button
          className="px-6 py-2 rounded bg-blue-600 text-white font-semibold hover:bg-blue-700"
          onClick={async () => {
            try {
              await requestConsentToken();
              setNeedsConsent(false);
              loadRegistry();
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          スプレッドシートへのアクセスを許可
        </button>
        {error && <p className="mt-4 text-rose-600 text-sm">{error}</p>}
      </div>
    );
  }

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
        <div className="flex gap-2 items-center text-sm flex-wrap">
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

          {/* Date range selector */}
          <label className="text-slate-600 ml-2">表示期間：</label>
          <select
            value={settings?.dateRange.type || "last7d"}
            onChange={(e) => {
              const type = e.target.value as DateRangeType;
              updateSettings({ dateRange: { ...settings!.dateRange, type } });
            }}
            className="border rounded px-2 py-1 bg-white"
          >
            {DATE_RANGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {settings?.dateRange.type === "custom" && (
            <>
              <input type="date" className="border rounded px-1 py-0.5 text-xs"
                value={settings.dateRange.start || ""}
                onChange={(e) => updateSettings({
                  dateRange: { ...settings.dateRange, start: e.target.value },
                })} />
              <span>〜</span>
              <input type="date" className="border rounded px-1 py-0.5 text-xs"
                value={settings.dateRange.end || ""}
                onChange={(e) => updateSettings({
                  dateRange: { ...settings.dateRange, end: e.target.value },
                })} />
            </>
          )}

          <button
            onClick={() => selected && downloadCsv(`${selected.sourceId}.csv`, filteredRows)}
            disabled={!filteredRows.length}
            className="px-3 py-1 rounded bg-emerald-600 text-white disabled:opacity-50">
            CSV ダウンロード
          </button>
          <button onClick={() => setShowSettings(true)}
            className="px-3 py-1 rounded bg-indigo-600 text-white">
            設定
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

      <main className="p-4">
        <GridContainer
          layout={currentLayout}
          panels={panels}
          filteredRows={filteredRows}
          visibleEvents={visibleEvents}
          colors={theme.chartColors}
          settings={settings}
          onLayoutChange={handleLayoutChange}
        />
      </main>

      {showSettings && settings && (
        <SettingsModal
          settings={settings}
          panels={panels}
          rows={filteredRows}
          onSave={(s) => { updateSettings(s); setShowSettings(false); }}
          onClose={() => setShowSettings(false)}
          onResetLayout={() => updateSettings({ layout: null })}
        />
      )}
    </div>
  );
}

// ─── Grid Container (uses useContainerWidth hook) ───────────────────────────

function GridContainer({ layout, panels, filteredRows, visibleEvents, colors, settings, onLayoutChange }: {
  layout: LayoutItem[];
  panels: ThemePanel[];
  filteredRows: NormalizedRow[];
  visibleEvents: EventRow[];
  colors: string[];
  settings: UserSettings | null;
  onLayoutChange: (layout: Layout) => void;
}) {
  const { width, containerRef } = useContainerWidth();

  return (
    <div ref={containerRef as React.Ref<HTMLDivElement>}>
      {width > 0 && (
        <ResponsiveGridLayout
          width={width}
          className="layout"
          layouts={{ lg: layout, md: layout, sm: layout }}
          breakpoints={{ lg: 996, md: 768, sm: 480 }}
          cols={{ lg: 12, md: 8, sm: 4 }}
          rowHeight={80}
          onLayoutChange={onLayoutChange}
          dragConfig={{ handle: ".panel-drag-handle" }}
        >
          {panels.map((p) => (
            <div key={p.id}>
              <Panel
                panel={p}
                rows={filteredRows}
                events={visibleEvents}
                colors={colors}
                panelSettings={settings?.panelSettings[p.id]}
                deviceColors={settings?.deviceColors || {}}
              />
            </div>
          ))}
        </ResponsiveGridLayout>
      )}
    </div>
  );
}

// ─── Panel ──────────────────────────────────────────────────────────────────

function Panel({ panel, rows, events, colors, panelSettings, deviceColors }: {
  panel: ThemePanel;
  rows: NormalizedRow[];
  events: EventRow[];
  colors: string[];
  panelSettings?: PanelSettings;
  deviceColors: DeviceColorMap;
}) {
  const datasets = useMemo(
    () => buildDatasets(panel, rows, colors, deviceColors),
    [panel, rows, colors, deviceColors],
  );
  const annotations = useMemo(() => events.map((e) => ({
    type: "line" as const, xMin: e.date, xMax: e.date,
    borderColor: e.color || "#ef4444", borderWidth: 1,
    label: { content: e.label, display: true },
  })), [events]);

  const yMin = panelSettings?.yMin ?? panel.yMin;
  const yMax = panelSettings?.yMax ?? panel.yMax;
  const yLabel = panelSettings?.yLabel;
  const showPoints = panelSettings?.showPoints ?? panel.showPoints ?? false;

  return (
    <section
      className="bg-white rounded-2xl shadow p-3 flex flex-col h-full">
      <h3 className="text-sm font-semibold mb-1 panel-drag-handle cursor-move select-none">
        ⠿ {panel.title}
      </h3>
      <div className="relative flex-1 min-h-0">
        <Line
          data={{ datasets }}
          options={{
            responsive: true, maintainAspectRatio: false,
            parsing: false, animation: false,
            scales: {
              x: { type: "time", time: { tooltipFormat: "yyyy-MM-dd HH:mm" } },
              y: {
                min: yMin, max: yMax,
                title: yLabel ? { display: true, text: yLabel } : undefined,
              },
            },
            plugins: {
              legend: { display: true, position: "bottom" as const },
              tooltip: { mode: "nearest", intersect: false },
              // @ts-expect-error annotation plugin not registered; harmless if absent
              annotation: { annotations },
            },
            elements: {
              point: { radius: showPoints ? 2 : 0 },
              line: { borderWidth: 1.5, tension: 0.1 },
            },
          }}
        />
      </div>
    </section>
  );
}

// ─── buildDatasets ──────────────────────────────────────────────────────────

function buildDatasets(
  panel: ThemePanel,
  rows: NormalizedRow[],
  colors: string[],
  deviceColors: DeviceColorMap,
) {
  const groups = new Map<string, { color: string; label: string; data: { x: number; y: number }[] }>();
  let i = 0;
  for (const r of rows) {
    const v = (r as Record<string, unknown>)[panel.metric];
    if (typeof v !== "number" || !r.ts) continue;
    const x = parseTs(r.ts);
    if (!Number.isFinite(x)) continue;
    const key = r.deviceId || "(default)";
    if (!groups.has(key)) {
      const color = deviceColors[key] || colors[i % colors.length];
      groups.set(key, { color, label: key, data: [] });
      i++;
    }
    groups.get(key)!.data.push({ x, y: v });
  }
  return Array.from(groups.values()).map((g) => ({
    label: g.label, borderColor: g.color, backgroundColor: g.color + "20", data: g.data,
  }));
}

// ─── Settings Modal ─────────────────────────────────────────────────────────

function SettingsModal({ settings, panels, rows, onSave, onClose, onResetLayout }: {
  settings: UserSettings;
  panels: ThemePanel[];
  rows: NormalizedRow[];
  onSave: (s: Partial<UserSettings>) => void;
  onClose: () => void;
  onResetLayout: () => void;
}) {
  const [panelSettings, setPanelSettings] = useState(settings.panelSettings);
  const [deviceColors, setDeviceColors] = useState(settings.deviceColors);

  // Collect unique device IDs from the data
  const deviceIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.deviceId) set.add(r.deviceId);
    return Array.from(set).sort();
  }, [rows]);

  const DEFAULT_PALETTE = [
    "#0ea5e9", "#22c55e", "#eab308", "#ef4444", "#a855f7",
    "#14b8a6", "#f97316", "#ec4899", "#6366f1", "#84cc16",
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[80vh] overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold mb-4">ダッシュボード設定</h2>

        {/* Panel axis settings */}
        <section className="mb-6">
          <h3 className="font-semibold text-sm mb-2 text-slate-700">パネル設定（Y軸）</h3>
          <div className="space-y-2">
            {panels.map((p) => {
              const ps = panelSettings[p.id] || {};
              const update = (patch: Partial<PanelSettings>) => {
                setPanelSettings((prev) => ({ ...prev, [p.id]: { ...ps, ...patch } }));
              };
              return (
                <div key={p.id} className="flex items-center gap-2 text-xs">
                  <span className="w-32 truncate font-medium">{p.title}</span>
                  <label>Min:</label>
                  <input type="number" step="any" className="border rounded w-16 px-1"
                    value={ps.yMin ?? ""} placeholder="auto"
                    onChange={(e) => update({
                      yMin: e.target.value ? Number(e.target.value) : undefined,
                    })} />
                  <label>Max:</label>
                  <input type="number" step="any" className="border rounded w-16 px-1"
                    value={ps.yMax ?? ""} placeholder="auto"
                    onChange={(e) => update({
                      yMax: e.target.value ? Number(e.target.value) : undefined,
                    })} />
                  <label>ラベル:</label>
                  <input type="text" className="border rounded w-24 px-1"
                    value={ps.yLabel ?? ""} placeholder={p.title}
                    onChange={(e) => update({ yLabel: e.target.value || undefined })} />
                </div>
              );
            })}
          </div>
        </section>

        {/* Device color settings */}
        <section className="mb-6">
          <h3 className="font-semibold text-sm mb-2 text-slate-700">デバイス線色</h3>
          <div className="grid grid-cols-2 gap-2">
            {deviceIds.map((id, idx) => (
              <div key={id} className="flex items-center gap-2 text-xs">
                <span className="font-mono w-16">{id}</span>
                <input type="color" className="w-8 h-6 border rounded cursor-pointer"
                  value={deviceColors[id] || DEFAULT_PALETTE[idx % DEFAULT_PALETTE.length]}
                  onChange={(e) => setDeviceColors((prev) => ({ ...prev, [id]: e.target.value }))} />
                {deviceColors[id] && (
                  <button className="text-slate-400 hover:text-red-500"
                    onClick={() => setDeviceColors((prev) => {
                      const next = { ...prev }; delete next[id]; return next;
                    })}>×</button>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Actions */}
        <div className="flex gap-2 justify-between">
          <button onClick={onResetLayout}
            className="px-3 py-1 text-sm rounded border border-slate-300 hover:bg-slate-100">
            レイアウトをリセット
          </button>
          <div className="flex gap-2">
            <button onClick={onClose}
              className="px-4 py-1 text-sm rounded border border-slate-300 hover:bg-slate-100">
              キャンセル
            </button>
            <button
              onClick={() => onSave({ panelSettings, deviceColors })}
              className="px-4 py-1 text-sm rounded bg-indigo-600 text-white hover:bg-indigo-700">
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
