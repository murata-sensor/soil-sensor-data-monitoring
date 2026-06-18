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
  loadAllRegistry, loadDataSource, loadSourceEvents, getSheetNames,
  resolveAllowedSources, canAccessSource, RegistryAccessDeniedError, UserNotRegisteredError,
} from "../api/sheets";
import { useApp } from "../store";
import {
  SCHEMA_EXTRA_PANELS,
  SUBSTRATE_OPTIONS,
  getPanelsForSubstrate,
  type EventRow, type SourceRow, type SubstrateType, type ThemePanel,
} from "../types";
import type { NormalizedRow } from "../adapters";
import { ConsentRequiredError, requestConsentToken, signOut } from "../auth/google";
import {
  type DateRangeType, type DeviceColorMap, type LayoutPreset,
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

/** Metrics where legend is only shown when multiple datasets exist (not per-sensor data). */
const LEGEND_ONLY_IF_MULTIPLE = new Set([
  "battery_v", "battery_pct", "rssi_dbm", "error_flag",
  "air_temp_c", "precip_1h_mm", "sunshine_1h_h",
]);

/** Shared metrics that should NOT be grouped by device (same value across all devices). */
const SHARED_METRICS = new Set([
  "air_temp_c", "precip_1h_mm", "sunshine_1h_h",
]);

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
  const [rows, setRows] = useState<NormalizedRow[] | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [layouts, setLayouts] = useState<LayoutConfig[]>([]);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unregistered, setUnregistered] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [needsConsent, setNeedsConsent] = useState(false);
  const [settings, setSettingsState] = useState<UserSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [customLayoutResetKey, setCustomLayoutResetKey] = useState(0);

  const updateSettings = useCallback((patch: Partial<UserSettings>) => {
    if (!user || !settings) return;
    const next = { ...settings, ...patch };
    setSettingsState(next);
    saveSettings(user.email, next);
  }, [user, settings]);

  // Load settings when user logs in
  useEffect(() => {
    if (user) {
      const s = loadSettings(user.email);
      setSettingsState(s);
      // Restore last selected source
      if (s.selectedSourceId) {
        setSelectedSource(s.selectedSourceId);
      }
    }
  }, [user]);

  const ftpSheetName = settings?.ftpSheetName ?? "sensor_raw";

  const loadRegistry = async () => {
    if (!user) return;
    setRegistryLoading(true);
    setNeedsConsent(false); setError(null);
    try {
      const { sources: src, users, acl, theme: t, layouts: lays } =
        await loadAllRegistry(user.idToken);
      setSources(src); setLayouts(lays);
      if (t) setTheme(t);
      const me = users.find((u) => u.email.toLowerCase() === user.email.toLowerCase());
      if (!me || !me.enabled) { setUnregistered(true); return; }
      setIsAdmin(me.role === "admin");
      const candidates = resolveAllowedSources(user.email, src, users, acl);
      const accessResults = await Promise.all(
        candidates.map(async (source) => {
          const accessible = await canAccessSource(source, user.idToken, {
            sheetNameOverride: source.schemaType === "remote-ftp" ? ftpSheetName : undefined,
          });
          return { source, accessible };
        }),
      );
      const list = accessResults
        .filter((r) => r.accessible)
        .map((r) => r.source);
      setAllowed(list);
      // Use persisted sourceId if Zustand store hasn't been updated yet (first load)
      const savedSourceId = selectedSourceId || loadSettings(user.email).selectedSourceId;
      const selectedStillAvailable = savedSourceId && list.some((s) => s.sourceId === savedSourceId);
      if (!selectedStillAvailable) {
        setSelectedSource(list.length ? list[0] : null);
      } else if (!selectedSourceId && savedSourceId) {
        // Store hasn't caught up yet — set it explicitly
        setSelectedSource(savedSourceId);
      }
    } catch (e) {
      if (e instanceof ConsentRequiredError) {
        setNeedsConsent(true);
      } else if (e instanceof RegistryAccessDeniedError) {
        setAccessDenied(true);
      } else if (e instanceof UserNotRegisteredError) {
        setUnregistered(true);
      } else {
        const msg = String(e);
        setError(msg);
        // Auto-retry for transient errors (429 rate limit)
        if (msg.includes("429")) {
          setTimeout(() => { setError(null); loadRegistry(); }, 5000);
        }
      }
    } finally {
      setRegistryLoading(false);
    }
  };

  useEffect(() => { loadRegistry(); }, [user, setTheme, setSelectedSource, selectedSourceId, ftpSheetName]);

  useEffect(() => {
    if (!user || !selectedSourceId) {
      setRows(null);
      setEvents([]);
      return;
    }
    const src = allowed.find((s) => s.sourceId === selectedSourceId);
    if (!src) {
      setRows(null);
      setEvents([]);
      return;
    }
    setLoading(true); setError(null);
    setRows(null);
    Promise.all([
      loadDataSource(src, user.idToken, {
        sheetNameOverride: src.schemaType === "remote-ftp" ? ftpSheetName : undefined,
      }),
      loadSourceEvents(src, user.idToken),
    ])
      .then(([r, ev]) => { setRows(r.rows); setEvents(ev); })
      .catch((e) => {
        setRows([]);
        setEvents([]);
        setError(String(e));
      })
      .finally(() => setLoading(false));
  }, [user, allowed, selectedSourceId, ftpSheetName]);

  const selected = useMemo(
    () => allowed.find((s) => s.sourceId === selectedSourceId) || null,
    [allowed, selectedSourceId],
  );

  // Fetch sheet tab names when selected source changes
  useEffect(() => {
    if (!selected || selected.schemaType !== "remote-ftp") {
      setSheetNames([]);
      return;
    }
    getSheetNames(selected.spreadsheetId)
      .then((names) => setSheetNames(names))
      .catch(() => setSheetNames([]));
  }, [selected]);

  const panels = useMemo<ThemePanel[]>(() => {
    if (!selected) return theme.panels;
    // For m5stack/mechatrax, use substrate-aware panel generation
    if (selected.schemaType === "m5stack" || selected.schemaType === "mechatrax") {
      const substrate: SubstrateType = settings?.substrateTypes[selected.sourceId] ?? "soil";
      return getPanelsForSubstrate(selected.schemaType, substrate);
    }
    return [...theme.panels, ...(SCHEMA_EXTRA_PANELS[selected.schemaType] || [])];
  }, [selected, theme.panels, settings?.substrateTypes]);

  const visibleEvents = useMemo(
    () => (selected ? events : []),
    [selected, events],
  );

  const mergedEvents = useMemo(
    () => [...visibleEvents, ...(settings?.localEvents ?? [])],
    [visibleEvents, settings?.localEvents],
  );

  // Filter rows by date range
  const filteredRows = useMemo(() => {
    if (!rows || !settings) return rows ?? [];
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
  const isInitialUnresolved = Boolean(user && rows === null && !selectedSourceId);
  const isResolvingSource = Boolean(user && !registryLoading && allowed.length > 0 && !selectedSourceId);
  const isSourceSelectedButUnresolved = Boolean(user && selectedSourceId && !selected);
  const isDataLoading = Boolean(
    user
    && (
      isInitialUnresolved
      || registryLoading
      || isResolvingSource
      || isSourceSelectedButUnresolved
      || loading
      || (selectedSourceId !== null && rows === null)
    )
  );

  const visiblePanels = useMemo(
    () => {
      // For m5stack/mechatrax, panels are generated by getPanelsForSubstrate — show all
      if (selected?.schemaType === "m5stack" || selected?.schemaType === "mechatrax") return panels;
      return panels.filter((p) => showAirTemperature || p.metric !== "air_temp_c");
    },
    [panels, showAirTemperature, selected],
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

  const skeletonCount = useMemo(() => {
    if (visibleCustomLayout) return visibleCustomLayout.panels.length;
    if (customLayout) return customLayout.panels.length;
    return visiblePanels.length;
  }, [visibleCustomLayout, customLayout, visiblePanels]);

  // Layout for react-grid-layout
  const defaultLayout = useMemo<LayoutItem[]>(
    () => visiblePanels.map((p) => ({ i: p.id, x: p.x, y: p.y, w: p.w, h: p.h, minW: 3, minH: 2 })),
    [visiblePanels],
  );
  // Merge saved layout with defaults: only keep items that match current panels,
  // and fill in missing panels from their default positions.
  const currentLayout: LayoutItem[] = useMemo(() => {
    if (!settings?.layout) return defaultLayout;
    const savedMap = new Map(settings.layout.map((l) => [l.i, l]));
    return visiblePanels.map((p) => {
      const saved = savedMap.get(p.id);
      if (saved) return { ...saved, minW: 3, minH: 2 };
      return { i: p.id, x: p.x, y: p.y, w: p.w, h: p.h, minW: 3, minH: 2 };
    });
  }, [settings?.layout, defaultLayout, visiblePanels]);

  const handleLayoutChange = useCallback((layout: Layout) => {
    if (!settings) return;
    updateSettings({
      layout: layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })),
    });
  }, [settings, updateSettings]);

  const handleResetLayout = useCallback(() => {
    updateSettings({ layout: null });
    setCustomLayoutResetKey((k) => k + 1);
  }, [updateSettings]);

  const handleSavePreset = useCallback((name: string) => {
    if (!settings) return;
    const preset: LayoutPreset = {
      id: crypto.randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      layout: settings.layout,
      sourceId: selectedSourceId,
      ftpSheetName: settings.ftpSheetName,
      substrateTypes: { ...settings.substrateTypes },
      dateRange: { ...settings.dateRange },
      panelSettings: { ...settings.panelSettings },
      deviceColors: { ...settings.deviceColors },
    };
    updateSettings({ savedPresets: [...(settings.savedPresets ?? []), preset] });
  }, [settings, selectedSourceId, updateSettings]);

  const handleLoadPreset = useCallback((preset: LayoutPreset) => {
    updateSettings({
      layout: preset.layout,
      selectedSourceId: preset.sourceId,
      ftpSheetName: preset.ftpSheetName,
      substrateTypes: { ...settings!.substrateTypes, ...preset.substrateTypes },
      dateRange: preset.dateRange,
      panelSettings: preset.panelSettings,
      deviceColors: preset.deviceColors,
    });
    if (preset.sourceId) {
      setSelectedSource(preset.sourceId);
    }
    setCustomLayoutResetKey((k) => k + 1);
    setShowSettings(false);
  }, [settings, updateSettings, setSelectedSource]);

  const handleDeletePreset = useCallback((presetId: string) => {
    if (!settings) return;
    updateSettings({
      savedPresets: (settings.savedPresets ?? []).filter((p) => p.id !== presetId),
    });
  }, [settings, updateSettings]);

  if (needsConsent) {
    return (
      <div className="p-10 text-center">
        <p className="mb-4 text-slate-700">
          Google スプレッドシートへのアクセス許可が必要です。<br />
          下のボタンをクリックして許可してください。<br />
          <span className="text-xs text-slate-500">（初回のみ。次回以降は自動で接続します）</span>
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

  if (accessDenied) {
    return (
      <div className="p-10 text-center space-y-3">
        <p className="text-rose-600 font-semibold">スプレッドシートへのアクセス権がありません</p>
        <p className="text-sm text-slate-600">
          このアカウント ({user?.email}) には Registry スプレッドシートの閲覧権限がありません。<br />
          管理者にスプレッドシートの共有設定を確認してもらってください。
        </p>
        <button
          onClick={() => { signOut(); setUser(null); }}
          className="mt-2 px-4 py-1 rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 text-sm"
        >
          サインアウト
        </button>
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
    <div className="min-h-screen" style={{ background: settings?.bgColor || theme.bg, color: theme.text }}>
      <header className="px-4 sm:px-6 py-3 sm:py-4 border-b"
        style={{ background: theme.surface }}>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          {/* 左: タイトル */}
          <div className="text-base sm:text-lg font-semibold">Soil Sensor Monitor</div>
          {/* 中央: データソース・表示期間・CSV */}
          <div className="flex items-center gap-2 flex-wrap justify-center">
            <div className="flex items-center gap-2 min-w-0">
              <label className="text-slate-600 shrink-0 text-xs sm:text-sm">データソース：</label>
              <select
                value={selectedSourceId || ""}
                onChange={(e) => {
                  setRows(null);
                  const newId = e.target.value || null;
                  setSelectedSource(newId);
                  updateSettings({ selectedSourceId: newId });
                }}
                className="border rounded px-2 py-1 bg-white text-xs sm:text-sm min-w-0 sm:min-w-[14rem]"
              >
                {allowed.length === 0 && <option value="">(アクセス可能なソースなし)</option>}
                {allowed.map((s) => (
                  <option key={s.sourceId} value={s.sourceId}>
                    {s.displayName} [{s.schemaType}]
                  </option>
                ))}
              </select>
            </div>
            {selected?.schemaType === "remote-ftp" && (
              <div className="flex items-center gap-1 min-w-0">
                <label className="text-slate-600 shrink-0 text-xs sm:text-sm">シート：</label>
                <select
                  value={ftpSheetName}
                  onChange={(e) => updateSettings({ ftpSheetName: e.target.value })}
                  className="border rounded px-2 py-1 bg-white text-xs sm:text-sm"
                >
                  {sheetNames.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </div>
            )}
            {(selected?.schemaType === "m5stack" || selected?.schemaType === "mechatrax") && (
              <div className="flex items-center gap-1 min-w-0">
                <label className="text-slate-600 shrink-0 text-xs sm:text-sm">培地：</label>
                <select
                  value={settings?.substrateTypes[selected.sourceId] ?? "soil"}
                  onChange={(e) => {
                    const val = e.target.value as SubstrateType;
                    updateSettings({
                      substrateTypes: {
                        ...settings!.substrateTypes,
                        [selected.sourceId]: val,
                      },
                      // Reset layout when switching substrate to avoid stale panel ids
                      layout: null,
                    });
                  }}
                  className="border rounded px-2 py-1 bg-white text-xs sm:text-sm"
                >
                  {SUBSTRATE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              <label className="text-slate-600 shrink-0 text-xs sm:text-sm">表示期間：</label>
              <select
                value={settings?.dateRange.type || "last7d"}
                onChange={(e) => {
                  const type = e.target.value as DateRangeType;
                  updateSettings({ dateRange: { ...settings!.dateRange, type } });
                }}
                className="border rounded px-2 py-1 bg-white text-xs sm:text-sm"
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
                className="px-2 sm:px-3 py-1 rounded bg-emerald-600 text-white disabled:opacity-50 text-xs sm:text-sm">
                CSV
              </button>
            </div>
          </div>
          {/* 右: 設定・管理・ログアウト */}
          <div className="flex gap-1 sm:gap-2 items-center justify-end">
            <button onClick={() => setShowSettings(true)}
              className="px-2 sm:px-3 py-1 rounded bg-indigo-600 text-white text-xs sm:text-sm">
              設定
            </button>
            {isAdmin && (
              <a href="./admin" className="px-2 sm:px-3 py-1 rounded bg-slate-800 text-white text-xs sm:text-sm">管理</a>
            )}
            <button
              onClick={() => { signOut(); setUser(null); }}
              className="px-2 sm:px-3 py-1 rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 text-xs sm:text-sm"
            >
              ログアウト
            </button>
          </div>
        </div>
      </header>

      {error && (
        <div className="m-4 p-3 rounded bg-rose-100 text-rose-700 text-sm flex items-center gap-3">
          <span>{error}</span>
          {error.includes("429") && (
            <span className="text-xs text-rose-500">（5秒後に自動リトライ…）</span>
          )}
          <button
            onClick={() => { setError(null); loadRegistry(); }}
            className="ml-auto px-3 py-1 rounded bg-rose-600 text-white text-xs hover:bg-rose-700 shrink-0"
          >
            再試行
          </button>
        </div>
      )}
      {isDataLoading && (
        <div className="m-4 inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-600">
          <span className="h-2 w-2 animate-pulse rounded-full bg-sky-500" />
          データを読み込み中…
        </div>
      )}

      <main className="p-2 sm:p-4">
        {isDataLoading ? (
          <DashboardSkeleton count={skeletonCount} />
        ) : customLayout ? (
          <CustomLayoutDashboard
            key={`custom-layout-${selectedSourceId ?? "none"}-${customLayoutResetKey}`}
            layout={visibleCustomLayout || customLayout}
            rows={filteredRows}
            events={mergedEvents}
            panelSettings={settings?.panelSettings}
            deviceColors={settings?.deviceColors}
            showEventLabels={showEventLabels}
            bgColor={settings?.bgColor}
            chartBgColor={settings?.chartBgColor}
          />
        ) : (
          <GridContainer
            layout={currentLayout}
            panels={visiblePanels}
            filteredRows={filteredRows}
            visibleEvents={mergedEvents}
            colors={theme.chartColors}
            settings={settings}
            showEventLabels={showEventLabels}
            chartBgColor={settings?.chartBgColor}
            onLayoutChange={handleLayoutChange}
          />
        )}
      </main>

      {showSettings && settings && (
        <SettingsModal
          settings={settings}
          panels={settingsPanels}
          rows={filteredRows}
          schemaType={selected?.schemaType}
          onSave={(s) => { updateSettings(s); setShowSettings(false); }}
          onClose={() => setShowSettings(false)}
          onResetLayout={handleResetLayout}
          onSavePreset={handleSavePreset}
          onLoadPreset={handleLoadPreset}
          onDeletePreset={handleDeletePreset}
        />
      )}
    </div>
  );
}

function DashboardSkeleton({ count }: { count: number }) {
  const cardCount = Math.min(Math.max(count, 4), 8);

  return (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      {Array.from({ length: cardCount }).map((_, i) => (
        <section
          key={`skeleton-${i}`}
          className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow"
        >
          <div className="space-y-3 p-3">
            <div className="h-4 w-32 animate-pulse rounded bg-slate-200" />
            <div className="h-36 animate-pulse rounded-xl bg-slate-100" />
            <div className="grid grid-cols-3 gap-2">
              <div className="h-2 animate-pulse rounded bg-slate-100" />
              <div className="h-2 animate-pulse rounded bg-slate-100" />
              <div className="h-2 animate-pulse rounded bg-slate-100" />
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

// ─── Grid Container (uses useContainerWidth hook) ───────────────────────────

function GridContainer({ layout, panels, filteredRows, visibleEvents, colors, settings, showEventLabels, chartBgColor, onLayoutChange }: {
  layout: LayoutItem[];
  panels: ThemePanel[];
  filteredRows: NormalizedRow[];
  visibleEvents: EventRow[];
  colors: string[];
  settings: UserSettings | null;
  showEventLabels: boolean;
  chartBgColor?: string;
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
          dragConfig={{ handle: ".panel-drag-handle", enabled: true }}
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
                chartBgColor={chartBgColor}
              />
            </div>
          ))}
        </ResponsiveGridLayout>
      )}
    </div>
  );
}

// ─── Panel ──────────────────────────────────────────────────────────────────

function Panel({ panel, rows, events, colors, panelSettings, deviceColors, showEventLabels, chartBgColor }: {
  panel: ThemePanel;
  rows: NormalizedRow[];
  events: EventRow[];
  colors: string[];
  panelSettings?: PanelSettings;
  deviceColors: DeviceColorMap;
  showEventLabels: boolean;
  chartBgColor?: string;
}) {
  const datasets = useMemo(
    () => buildDatasets(panel, rows, colors, deviceColors),
    [panel, rows, colors, deviceColors],
  );
  const annotations = useMemo(() => {
    // Determine data time range from datasets to exclude out-of-range events
    let dataMin = Infinity;
    let dataMax = -Infinity;
    for (const ds of datasets) {
      for (const pt of ds.data as { x: number }[]) {
        if (pt.x < dataMin) dataMin = pt.x;
        if (pt.x > dataMax) dataMax = pt.x;
      }
    }

    return events
      .filter((e) => {
        if (e.deviceId && e.deviceId !== "*") return false; // non-custom panels: skip per-device events (except wildcard)
        const ts = parseTs(e.date);
        if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) return false;
        return ts >= dataMin && ts <= dataMax;
      })
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
      })).reduce((acc, cur) => ({ ...acc, ...cur }), {});
  }, [events, datasets, showEventLabels]);

  const shouldShowEvents = panel.metric !== "air_temp_c";

  const yMin = panelSettings?.yMin ?? panel.yMin;
  const yMax = panelSettings?.yMax ?? panel.yMax;
  const yLabel = panelSettings?.yLabel;
  const showPoints = panelSettings?.showPoints ?? panel.showPoints ?? false;

  return (
    <section
      className="rounded-2xl shadow p-3 flex flex-col h-full"
      style={{ backgroundColor: chartBgColor || "#ffffff" }}>
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
              x: {
                type: "time",
                time: {
                  tooltipFormat: "yyyy-MM-dd HH:mm",
                  displayFormats: { minute: "yyyy/M/d HH:mm", hour: "yyyy/M/d HH:mm", day: "yyyy/M/d", week: "yyyy/M/d", month: "yyyy/M" },
                },
                ticks: {
                  maxTicksLimit: 6,
                  font: { size: 9 },
                },
              },
              y: {
                min: yMin, max: yMax,
                title: yLabel ? { display: true, text: yLabel } : undefined,
              },
            },
            plugins: {
              legend: {
                display: LEGEND_ONLY_IF_MULTIPLE.has(panel.metric) ? datasets.length > 1 : true,
                position: "bottom" as const,
              },
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

const METRIC_LABELS: Record<string, string> = {
  vwc_pct: "VWC 一般土壌",
  vwc_rock_pct: "VWC ロックウール",
  vwc_coco_pct: "VWC ココピート",
  ec_bulk_dsm: "Bulk EC",
  ec_pore_dsm: "Pore EC",
  ec_pore_coco_dsm: "Pore EC ココピート",
};

function buildDatasets(
  panel: ThemePanel,
  rows: NormalizedRow[],
  colors: string[],
  deviceColors: DeviceColorMap,
) {
  // Multi-metric mode (for "all" substrate panels)
  if (panel.metrics && panel.metrics.length > 1) {
    return buildMultiMetricDatasets(panel.metrics, rows, colors, deviceColors);
  }

  // Shared metrics (weather): merge all devices into one dataset, dedup by timestamp
  if (SHARED_METRICS.has(panel.metric)) {
    const seen = new Map<number, number>();
    for (const r of rows) {
      const v = (r as Record<string, unknown>)[panel.metric];
      if (typeof v !== "number" || !r.ts) continue;
      const x = parseTs(r.ts);
      if (!Number.isFinite(x)) continue;
      if (!seen.has(x)) seen.set(x, v);
    }
    if (seen.size === 0) return [];
    const data = Array.from(seen.entries()).map(([x, y]) => ({ x, y }));
    data.sort((a, b) => a.x - b.x);
    return [{ label: panel.title, borderColor: colors[0], backgroundColor: colors[0] + "20", data }];
  }

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

function buildMultiMetricDatasets(
  metrics: string[],
  rows: NormalizedRow[],
  colors: string[],
  deviceColors: DeviceColorMap,
) {
  // Group by device × metric so legend shows device serial numbers
  const groups = new Map<string, { color: string; label: string; data: { x: number; y: number }[] }>();
  let colorIdx = 0;
  for (const r of rows) {
    if (!r.ts) continue;
    const x = parseTs(r.ts);
    if (!Number.isFinite(x)) continue;
    const deviceId = r.deviceId || "(default)";
    for (const metric of metrics) {
      const v = (r as Record<string, unknown>)[metric];
      if (typeof v !== "number") continue;
      const key = `${deviceId}::${metric}`;
      if (!groups.has(key)) {
        const metricLabel = METRIC_LABELS[metric] || metric;
        const label = `${deviceId} - ${metricLabel}`;
        const color = deviceColors[deviceId] || colors[colorIdx % colors.length];
        groups.set(key, { color, label, data: [] });
        colorIdx++;
      }
      groups.get(key)!.data.push({ x, y: v });
    }
  }
  return Array.from(groups.values()).map((g) => ({
    label: g.label, borderColor: g.color, backgroundColor: g.color + "20", data: g.data,
  }));
}

// ─── Settings Modal ─────────────────────────────────────────────────────────

function SettingsModal({ settings, panels, rows, schemaType, onSave, onClose, onResetLayout, onSavePreset, onLoadPreset, onDeletePreset }: {
  settings: UserSettings;
  panels: SettingsPanelInfo[];
  rows: NormalizedRow[];
  schemaType?: string;
  onSave: (s: Partial<UserSettings>) => void;
  onClose: () => void;
  onResetLayout: () => void;
  onSavePreset: (name: string) => void;
  onLoadPreset: (preset: LayoutPreset) => void;
  onDeletePreset: (presetId: string) => void;
}) {
  const [panelSettings, setPanelSettings] = useState(settings.panelSettings);
  const [deviceColors, setDeviceColors] = useState(settings.deviceColors);
  const [showAirTemperature, setShowAirTemperature] = useState(settings.showAirTemperature ?? false);
  const [showEventLabels, setShowEventLabels] = useState(settings.showEventLabels ?? true);
  const [bgColor, setBgColor] = useState(settings.bgColor ?? "");
  const [chartBgColor, setChartBgColor] = useState(settings.chartBgColor ?? "");
  const [localEvents, setLocalEvents] = useState<EventRow[]>(settings.localEvents ?? []);
  const [newEventDate, setNewEventDate] = useState("");
  const [newEventLabel, setNewEventLabel] = useState("");
  const [newEventColor, setNewEventColor] = useState("#ef4444");
  const [presetName, setPresetName] = useState("");

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
      <div className="bg-white rounded-none sm:rounded-xl shadow-xl w-full h-full sm:h-auto sm:max-w-2xl sm:max-h-[80vh] overflow-y-auto p-4 sm:p-6"
        onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold mb-4">ダッシュボード設定</h2>

        {/* Batch Y-axis settings by metric */}
        <section className="mb-6">
          <h3 className="font-semibold text-sm mb-2 text-slate-700">一括Y軸設定（メトリック別）</h3>
          <div className="space-y-2">
            {uniqueMetrics.map(({ metric, title }) => (
              <div key={metric} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="w-full sm:w-36 truncate font-medium">{title}</span>
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
                      <div key={p.id} className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="w-full sm:w-48 truncate font-medium" title={p.displayName || p.title}>
                          {p.displayName || p.title}
                        </span>
                        <span className="hidden sm:inline w-16 truncate font-mono text-slate-500" title={p.id}>{p.id}</span>
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

        {/* Device color settings — M5Stack/Mechatrax only */}
        {schemaType !== "remote-ftp" && (
        <section className="mb-6">
          <h3 className="font-semibold text-sm mb-2 text-slate-700">デバイス線色</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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
        )}

        {/* Metric visibility */}
        <section className="mb-6">
          <h3 className="font-semibold text-sm mb-2 text-slate-700">表示設定</h3>
          <div className="space-y-2">
            {schemaType === "remote-ftp" && (
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={showAirTemperature}
                  onChange={(e) => setShowAirTemperature(e.target.checked)}
                />
                <span>air temperature（外気温）を表示</span>
              </label>
            )}
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={showEventLabels}
                onChange={(e) => setShowEventLabels(e.target.checked)}
              />
              <span>events のラベルを表示</span>
            </label>
          </div>
        </section>

        {/* イベント管理 */}
        <section className="mb-6">
          <h3 className="font-semibold text-sm mb-2 text-slate-700">イベント管理</h3>
          <p className="text-xs text-slate-500 mb-2">
            グラフ上にイベントラインを追加できます。スプレッドシートの events シートからも自動的に読み込まれます。
          </p>
          {localEvents.length > 0 && (
            <div className="space-y-1 mb-3 max-h-32 overflow-y-auto">
              {localEvents.map((ev, i) => (
                <div key={i} className="flex items-center gap-2 text-xs border rounded px-2 py-1">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: ev.color || "#ef4444" }} />
                  <span className="font-mono shrink-0">{ev.date}</span>
                  <span className="flex-1 truncate">{ev.label}</span>
                  <button className="text-slate-400 hover:text-red-500"
                    onClick={() => setLocalEvents((prev) => prev.filter((_, j) => j !== i))}>×</button>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2 items-end">
            <div>
              <label className="text-xs text-slate-500 block">日付</label>
              <input type="datetime-local" className="border rounded px-1 py-0.5 text-xs"
                value={newEventDate} onChange={(e) => setNewEventDate(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-slate-500 block">ラベル</label>
              <input type="text" className="border rounded px-1 py-0.5 text-xs w-32"
                value={newEventLabel} onChange={(e) => setNewEventLabel(e.target.value)}
                placeholder="例: 灌水" />
            </div>
            <div>
              <label className="text-xs text-slate-500 block">色</label>
              <input type="color" className="w-8 h-6 border rounded cursor-pointer"
                value={newEventColor} onChange={(e) => setNewEventColor(e.target.value)} />
            </div>
            <button
              disabled={!newEventDate || !newEventLabel}
              onClick={() => {
                setLocalEvents((prev) => [...prev, {
                  date: newEventDate.replace("T", " "),
                  label: newEventLabel,
                  color: newEventColor,
                }]);
                setNewEventDate(""); setNewEventLabel("");
              }}
              className="px-2 py-0.5 text-xs rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
            >
              追加
            </button>
          </div>
        </section>

        {/* 背景色設定 */}
        <section className="mb-6">
          <h3 className="font-semibold text-sm mb-2 text-slate-700">背景色</h3>
          <div className="flex flex-wrap gap-4">
            <div className="flex items-center gap-2 text-sm">
              <span>全体の背景色</span>
              <input type="color" className="w-8 h-6 border rounded cursor-pointer"
                value={bgColor || "#f8fafc"}
                onChange={(e) => setBgColor(e.target.value)} />
              {bgColor && (
                <button className="text-xs text-slate-400 hover:text-red-500"
                  onClick={() => setBgColor("")}>リセット</button>
              )}
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span>グラフの背景色</span>
              <input type="color" className="w-8 h-6 border rounded cursor-pointer"
                value={chartBgColor || "#ffffff"}
                onChange={(e) => setChartBgColor(e.target.value)} />
              {chartBgColor && (
                <button className="text-xs text-slate-400 hover:text-red-500"
                  onClick={() => setChartBgColor("")}>リセット</button>
              )}
            </div>
          </div>
        </section>

        {/* Layout Presets */}
        <section className="mb-6">
          <h3 className="font-semibold text-sm mb-2">レイアウトプリセット</h3>
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              placeholder="プリセット名を入力"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              className="flex-1 border rounded px-2 py-1 text-sm"
              maxLength={40}
            />
            <button
              onClick={() => { if (presetName.trim()) { onSavePreset(presetName.trim()); setPresetName(""); } }}
              disabled={!presetName.trim()}
              className="px-3 py-1 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
            >
              現在の状態を保存
            </button>
          </div>
          {(settings.savedPresets ?? []).length === 0 ? (
            <p className="text-xs text-slate-400">保存されたプリセットはありません</p>
          ) : (
            <ul className="space-y-1 max-h-40 overflow-y-auto">
              {(settings.savedPresets ?? []).map((p) => (
                <li key={p.id} className="flex items-center justify-between border rounded px-2 py-1 text-sm">
                  <div className="min-w-0 flex-1">
                    <span className="font-medium truncate block">{p.name}</span>
                    <span className="text-xs text-slate-400">
                      {new Date(p.createdAt).toLocaleDateString("ja-JP")}
                      {p.sourceId && ` · ${p.sourceId}`}
                    </span>
                  </div>
                  <div className="flex gap-1 ml-2 shrink-0">
                    <button
                      onClick={() => onLoadPreset(p)}
                      className="px-2 py-0.5 text-xs rounded bg-indigo-600 text-white hover:bg-indigo-700"
                    >
                      読み込み
                    </button>
                    <button
                      onClick={() => onDeletePreset(p.id)}
                      className="px-2 py-0.5 text-xs rounded border border-rose-300 text-rose-600 hover:bg-rose-50"
                    >
                      削除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-2 sm:justify-between">
          <button onClick={onResetLayout}
            className="px-3 py-1 text-sm rounded border border-slate-300 hover:bg-slate-100">
            レイアウトをリセット
          </button>
          <div className="flex gap-2 justify-end">
            <button onClick={onClose}
              className="px-4 py-1 text-sm rounded border border-slate-300 hover:bg-slate-100">
              キャンセル
            </button>
            <button
              onClick={() => onSave({ panelSettings, deviceColors, showAirTemperature, showEventLabels, bgColor: bgColor || undefined, chartBgColor: chartBgColor || undefined, localEvents })}
              className="px-4 py-1 text-sm rounded bg-indigo-600 text-white hover:bg-indigo-700">
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
