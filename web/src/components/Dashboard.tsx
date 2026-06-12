import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import {
  CategoryScale, Chart as ChartJS, Filler, Legend, LinearScale, LineElement,
  PointElement, TimeScale, Title, Tooltip,
} from "chart.js";
import annotationPlugin from "chartjs-plugin-annotation";
import "chartjs-adapter-date-fns";
import { ResponsiveGridLayout, useContainerWidth, type Layout, type LayoutItem } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import {
  loadAcl, loadDataSource, loadEvents, loadLayouts, loadSources, loadTheme, loadUsers,
  resolveAllowedSources,
} from "../api/sheets";
import { useApp } from "../store";
import {
  SCHEMA_EXTRA_PANELS,
  type EventRow, type SourceRow, type ThemePanel,
} from "../types";
import type { NormalizedRow } from "../adapters";
import { ConsentRequiredError, requestConsentToken, signOut } from "../auth/google";
import {
  type DateRangeType, type DeviceColorMap,
  type PanelSettings, type UserSettings,
  dateRangeToMs, loadSettings, parseTs, saveSettings,
} from "../settings";
import type { LayoutConfig } from "../layoutConfig";
import { generateDeviceColumnLayout } from "../layoutConfig";
import { CustomLayoutDashboard } from "./CustomLayoutDashboard";

ChartJS.register(
  CategoryScale, LinearScale, LineElement, PointElement, TimeScale,
  Title, Tooltip, Legend, Filler, annotationPlugin,
);

const DATE_RANGE_OPTIONS: { value: DateRangeType; label: string }[] = [
  { value: "last24h", label: "24時間" },
  { value: "last3d", label: "3日間" },
  { value: "last7d", label: "7日間" },
  { value: "last30d", label: "30日間" },
  { value: "all", label: "全期間" },
  { value: "custom", label: "カスタム" },
];

function getEventLabelYAdjust(): number {
  // Scriptable yAdjust anchored to chart height so label stays near top
  // independent of window size.
  const scriptable = (ctx: { chart?: { chartArea?: { top: number; bottom: number } } }) => {
    const area = ctx?.chart?.chartArea;
    if (!area) return -8;
    const height = Math.max(0, area.bottom - area.top);
    return -Math.max(8, Math.floor(height / 2) - 6);
  };
  return scriptable as unknown as number;
}

type SettingsPanelInfo = Pick<ThemePanel, "id" | "title" | "metric"> & {
  displayName?: string;
};

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
  const { user, theme, setUser, setTheme, selectedSourceId, setSelectedSource } = useApp();
  const [, setSources] = useState<SourceRow[]>([]);
  const [allowed, setAllowed] = useState<SourceRow[]>([]);
  const [rows, setRows] = useState<NormalizedRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [layouts, setLayouts] = useState<LayoutConfig[]>([]);
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
      const [src, users, acl, ev, t, lays] = await Promise.all([
        loadSources(), loadUsers(), loadAcl(), loadEvents(), loadTheme(), loadLayouts(),
      ]);
      setSources(src); setEvents(ev); setLayouts(lays);
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

  // Check if there's a custom layout for this source
  const customLayout = useMemo(() => {
    // First check for explicitly configured layout
    const explicit = layouts.find((l) => l.sourceId === selectedSourceId);
    if (explicit) return explicit;
    // For remote-ftp sources with data, auto-generate column layout
    if (selected?.schemaType === "remote-ftp" && filteredRows.length > 0) {
      const devices = Array.from(new Set(filteredRows.map((r) => r.deviceId).filter(Boolean) as string[])).sort();
      if (devices.length > 0) {
        return generateDeviceColumnLayout(selected.sourceId, devices, {
          title: selected.displayName,
        });
      }
    }
    return null;
  }, [layouts, selectedSourceId, selected, filteredRows]);

  const settingsPanels = useMemo(() => {
    if (customLayout) {
      return customLayout.panels
        .filter((panel): panel is LayoutConfig["panels"][number] & { type: "chart" } => panel.type === "chart")
        .map((panel): SettingsPanelInfo => {
          const deviceRef = panel.deviceRef;
          const deviceId = deviceRef !== undefined
            ? customLayout.devices?.[deviceRef]
            : panel.deviceFilter?.[0];
          const rawLabel = deviceRef !== undefined
            ? (customLayout.deviceLabels?.[deviceRef] ?? deviceId)
            : deviceId;
          const shortLabel = rawLabel ? rawLabel.split("\n")[0] : undefined;
          return {
            id: panel.id,
            title: panel.title,
            metric: panel.metric,
            displayName: shortLabel ? `${panel.title} [${shortLabel}]` : panel.title,
          };
        });
    }
    return panels;
  }, [customLayout, panels]);

  const showAirTemperature = settings?.showAirTemperature ?? false;
  const showEventLabels = settings?.showEventLabels ?? true;

  const visiblePanels = useMemo(
    () => panels.filter((p) => showAirTemperature || p.metric !== "air_temp_c"),
    [panels, showAirTemperature],
  );

  const visibleCustomLayout = useMemo(() => {
    if (!customLayout) return null;
    if (showAirTemperature) return customLayout;
    return {
      ...customLayout,
      panels: customLayout.panels.filter(
        (panel) => panel.type !== "chart" || panel.metric !== "air_temp_c",
      ),
    };
  }, [customLayout, showAirTemperature]);

  // Layout for react-grid-layout
  const defaultLayout = useMemo<LayoutItem[]>(
    () => visiblePanels.map((p) => ({ i: p.id, x: p.x, y: p.y, w: p.w, h: p.h, minW: 3, minH: 2 })),
    [visiblePanels],
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

      {error && (
        <div className="m-4 p-3 rounded bg-rose-100 text-rose-700 text-sm">{error}</div>
      )}
      {loading && <div className="m-4 text-sm text-slate-500">読み込み中…</div>}

      <main className="p-4">
        {customLayout ? (
          <CustomLayoutDashboard
            layout={visibleCustomLayout || customLayout}
            rows={filteredRows}
            events={visibleEvents}
            panelSettings={settings?.panelSettings}
            deviceColors={settings?.deviceColors}
            showEventLabels={showEventLabels}
          />
        ) : (
          <GridContainer
            layout={currentLayout}
            panels={visiblePanels}
            filteredRows={filteredRows}
            visibleEvents={visibleEvents}
            colors={theme.chartColors}
            settings={settings}
              showEventLabels={showEventLabels}
            onLayoutChange={handleLayoutChange}
          />
        )}
      </main>

      {showSettings && settings && (
        <SettingsModal
          settings={settings}
          panels={settingsPanels}
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

function GridContainer({ layout, panels, filteredRows, visibleEvents, colors, settings, showEventLabels, onLayoutChange }: {
  layout: LayoutItem[];
  panels: ThemePanel[];
  filteredRows: NormalizedRow[];
  visibleEvents: EventRow[];
  colors: string[];
  settings: UserSettings | null;
  showEventLabels: boolean;
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
                showEventLabels={showEventLabels}
              />
            </div>
          ))}
        </ResponsiveGridLayout>
      )}
    </div>
  );
}

// ─── Panel ──────────────────────────────────────────────────────────────────

function Panel({ panel, rows, events, colors, panelSettings, deviceColors, showEventLabels }: {
  panel: ThemePanel;
  rows: NormalizedRow[];
  events: EventRow[];
  colors: string[];
  panelSettings?: PanelSettings;
  deviceColors: DeviceColorMap;
  showEventLabels: boolean;
}) {
  const datasets = useMemo(
    () => buildDatasets(panel, rows, colors, deviceColors),
    [panel, rows, colors, deviceColors],
  );
  const annotations = useMemo(() => events
    .filter((e) => !e.deviceId) // non-custom panels have no device context; skip per-device events
    .map((e, i) => ({
    [`ev-${i}`]: {
      type: "line" as const, xMin: parseTs(e.date), xMax: parseTs(e.date),
      borderColor: e.color || "#ef4444", borderWidth: 1,
      borderDash: [4, 2],
      label: {
        content: e.label,
        display: showEventLabels,
        position: "start" as const,
        xAdjust: 6,
        yAdjust: getEventLabelYAdjust(),
        backgroundColor: "rgba(0,0,0,0.72)",
        color: "#fff",
        font: { size: 9 },
        padding: 2,
      },
    },
  })).reduce((acc, cur) => ({ ...acc, ...cur }), {}), [events, showEventLabels]);

  const shouldShowEvents = panel.metric !== "air_temp_c";

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
              annotation: { annotations: shouldShowEvents ? annotations : {} },
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
  panels: SettingsPanelInfo[];
  rows: NormalizedRow[];
  onSave: (s: Partial<UserSettings>) => void;
  onClose: () => void;
  onResetLayout: () => void;
}) {
  const [panelSettings, setPanelSettings] = useState(settings.panelSettings);
  const [deviceColors, setDeviceColors] = useState(settings.deviceColors);
  const [showAirTemperature, setShowAirTemperature] = useState(settings.showAirTemperature ?? false);
  const [showEventLabels, setShowEventLabels] = useState(settings.showEventLabels ?? true);

  // Collect unique device IDs from the data
  const deviceIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.deviceId) set.add(r.deviceId);
    return Array.from(set).sort();
  }, [rows]);

  // Collect unique metrics for batch Y-axis control
  const uniqueMetrics = useMemo(() => {
    const seen = new Set<string>();
    return panels.filter((p) => {
      if (seen.has(p.metric)) return false;
      seen.add(p.metric);
      return true;
    }).map((p) => ({ metric: p.metric, title: p.title }));
  }, [panels]);

  const groupedPanels = useMemo(
    () => uniqueMetrics.map((m) => ({
      ...m,
      panels: panels.filter((p) => p.metric === m.metric),
    })),
    [panels, uniqueMetrics],
  );

  const applyBatchYAxis = (
    metric: string,
    patch: { yMin?: number; yMax?: number; updateMin?: boolean; updateMax?: boolean },
  ) => {
    setPanelSettings((prev) => {
      const next = { ...prev };
      for (const p of panels) {
        if (p.metric === metric) {
          const current = next[p.id] || {};
          next[p.id] = {
            ...current,
            ...(patch.updateMin ? { yMin: patch.yMin } : {}),
            ...(patch.updateMax ? { yMax: patch.yMax } : {}),
          };
        }
      }
      return next;
    });
  };

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

        {/* Batch Y-axis settings by metric */}
        <section className="mb-6">
          <h3 className="font-semibold text-sm mb-2 text-slate-700">一括Y軸設定（メトリック別）</h3>
          <div className="space-y-2">
            {uniqueMetrics.map(({ metric, title }) => (
              <div key={metric} className="flex items-center gap-2 text-xs">
                <span className="w-36 truncate font-medium">{title}</span>
                <label>Min:</label>
                <input type="number" step="any" className="border rounded w-16 px-1"
                  placeholder="auto"
                  onChange={(e) => {
                    const val = e.target.value ? Number(e.target.value) : undefined;
                    applyBatchYAxis(metric, { yMin: val, updateMin: true });
                  }} />
                <label>Max:</label>
                <input type="number" step="any" className="border rounded w-16 px-1"
                  placeholder="auto"
                  onChange={(e) => {
                    const val = e.target.value ? Number(e.target.value) : undefined;
                    applyBatchYAxis(metric, { yMax: val, updateMax: true });
                  }} />
                <button
                  className="px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                  onClick={() => {
                    // Find first panel of this metric with settings and apply to all
                    const first = panels.find((p) => p.metric === metric && panelSettings[p.id]);
                    if (first) {
                      const ps = panelSettings[first.id];
                      applyBatchYAxis(metric, {
                        yMin: ps?.yMin,
                        yMax: ps?.yMax,
                        updateMin: true,
                        updateMax: true,
                      });
                    }
                  }}
                >
                  一括適用
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* Panel axis settings */}
        <section className="mb-6">
          <h3 className="font-semibold text-sm mb-2 text-slate-700">パネル設定（Y軸）</h3>
          <div className="space-y-4">
            {groupedPanels.map((group) => (
              <div key={group.metric} className="border border-slate-200 rounded p-2">
                <div className="text-xs font-semibold text-slate-600 mb-2">
                  {group.title} ({group.panels.length})
                </div>
                <div className="space-y-2">
                  {group.panels.map((p) => {
                    const ps = panelSettings[p.id] || {};
                    const update = (patch: Partial<PanelSettings>) => {
                      setPanelSettings((prev) => {
                        const current = prev[p.id] || {};
                        return { ...prev, [p.id]: { ...current, ...patch } };
                      });
                    };
                    return (
                      <div key={p.id} className="flex items-center gap-2 text-xs">
                        <span className="w-48 truncate font-medium" title={p.displayName || p.title}>
                          {p.displayName || p.title}
                        </span>
                        <span className="w-16 truncate font-mono text-slate-500" title={p.id}>{p.id}</span>
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
              </div>
            ))}
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

        {/* Metric visibility */}
        <section className="mb-6">
          <h3 className="font-semibold text-sm mb-2 text-slate-700">表示設定</h3>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showAirTemperature}
              onChange={(e) => setShowAirTemperature(e.target.checked)}
            />
            <span>air temperature（外気温）を表示</span>
          </label>
          <label className="mt-2 inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showEventLabels}
              onChange={(e) => setShowEventLabels(e.target.checked)}
            />
            <span>events のラベルを表示</span>
          </label>
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
              onClick={() => onSave({ panelSettings, deviceColors, showAirTemperature, showEventLabels })}
              className="px-4 py-1 text-sm rounded bg-indigo-600 text-white hover:bg-indigo-700">
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
