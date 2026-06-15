/**
 * Custom-layout dashboard renderer.
 *
 * Renders a LayoutConfig with arbitrary panel types (chart, gauge, text, image)
 * using react-grid-layout for positioning. This supports per-source custom layouts
 * like the Kashimadai column-per-device style.
 */
import { useCallback, useMemo } from "react";
import { Line } from "react-chartjs-2";
import { ResponsiveGridLayout, useContainerWidth, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";

import type { NormalizedRow } from "../adapters";
import type { EventRow } from "../types";
import type {
  ChartPanelConfig,
  GaugePanelConfig,
  ImagePanelConfig,
  LayoutConfig,
  LayoutPanel,
  TextPanelConfig,
} from "../layoutConfig";
import { resolveDeviceFilter } from "../layoutConfig";
import { BatteryGauge } from "./BatteryGauge";
import { parseTs, type PanelSettings, type DeviceColorMap } from "../settings";

const SINGLE_SERIES_METRICS = new Set(["battery_v", "air_temp_c"]);

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

// ─── Main Component ─────────────────────────────────────────────────────────

interface CustomLayoutProps {
  layout: LayoutConfig;
  rows: NormalizedRow[];
  events: EventRow[];
  panelSettings?: Record<string, PanelSettings>;
  deviceColors?: DeviceColorMap;
  showEventLabels?: boolean;
  onLayoutChange?: (panels: LayoutPanel[]) => void;
}

export function CustomLayoutDashboard({
  layout,
  rows,
  events,
  panelSettings,
  deviceColors,
  showEventLabels = true,
  onLayoutChange,
}: CustomLayoutProps) {
  const { width, containerRef } = useContainerWidth();
  const cols = layout.cols ?? 12;
  const bg = layout.bg ?? "#1a1a1a";
  const surface = layout.surface ?? "#2a2a2a";
  const textColor = layout.textColor ?? "#ffffff";

  // Compute row height dynamically to fill viewport height
  const maxRow = useMemo(() => {
    let max = 0;
    for (const p of layout.panels) {
      const bottom = p.position.y + p.position.h;
      if (bottom > max) max = bottom;
    }
    return max;
  }, [layout.panels]);

  // Fit all rows into viewport height (minus header ~60px and padding)
  // On mobile, don't compress rows — allow scrolling instead
  const viewportH = typeof window !== "undefined" ? window.innerHeight - 80 : 800;
  const isMobile = width > 0 && width < 480;
  const rowHeight = isMobile
    ? 60
    : Math.max(30, Math.floor(viewportH / Math.max(maxRow, 1)));

  // On mobile, build a stacked layout: charts get full width (2 cols),
  // text & gauge panels share a row (1 col each)
  const initialLayout = useMemo(() => {
    if (!isMobile) {
      return layout.panels.map((p) => ({
        i: p.id,
        x: p.position.x,
        y: p.position.y,
        w: p.position.w,
        h: p.position.h,
        minW: 1,
        minH: 1,
      }));
    }
    // Mobile: compact layout
    let y = 0;
    const items: { i: string; x: number; y: number; w: number; h: number; minW: number; minH: number }[] = [];
    // Group: text/gauge get h=1, charts get h=3
    const smallPanels = layout.panels.filter((p) => p.type === "text" || p.type === "gauge");
    const largePanels = layout.panels.filter((p) => p.type === "chart" || p.type === "image");
    // Place small panels 2-per-row
    for (let i = 0; i < smallPanels.length; i += 2) {
      items.push({ i: smallPanels[i].id, x: 0, y, w: 1, h: 1, minW: 1, minH: 1 });
      if (i + 1 < smallPanels.length) {
        items.push({ i: smallPanels[i + 1].id, x: 1, y, w: 1, h: 1, minW: 1, minH: 1 });
      }
      y += 1;
    }
    // Place large panels full-width
    for (const p of largePanels) {
      items.push({ i: p.id, x: 0, y, w: 2, h: 3, minW: 1, minH: 1 });
      y += 3;
    }
    return items;
  }, [layout.panels, isMobile]);

  const handleLayoutChange = useCallback((newLayout: Layout) => {
    if (!onLayoutChange) return;
    const updated = layout.panels.map((panel) => {
      const item = newLayout.find((l) => l.i === panel.id);
      if (!item) return panel;
      return { ...panel, position: { x: item.x, y: item.y, w: item.w, h: item.h } };
    });
    onLayoutChange(updated);
  }, [layout.panels, onLayoutChange]);

  return (
    <div
      ref={containerRef as React.Ref<HTMLDivElement>}
      style={{ background: bg, color: textColor, minHeight: isMobile ? "auto" : "100vh" }}
    >
      {width > 0 && (
        <ResponsiveGridLayout
          width={width}
          className="layout"
          layouts={{ lg: initialLayout, md: initialLayout, sm: initialLayout }}
          breakpoints={{ lg: 996, md: 768, sm: 480 }}
          cols={{ lg: cols, md: Math.max(4, Math.floor(cols / 2)), sm: 2 }}
          rowHeight={rowHeight}
          onLayoutChange={isMobile ? undefined : handleLayoutChange}
          dragConfig={{ handle: ".panel-drag-handle", enabled: !isMobile }}
          resizeConfig={{ enabled: !isMobile, handles: ["se"] }}
          margin={[4, 4]}
        >
          {layout.panels.map((panel) => (
            <div key={panel.id}>
              <PanelRenderer
                panel={panel}
                rows={rows}
                events={events}
                surface={surface}
                textColor={textColor}
                panelSettings={panelSettings?.[panel.id]}
                deviceColors={deviceColors ?? {}}
                devices={layout.devices}
                deviceLabels={layout.deviceLabels ?? layout.devices}
                showEventLabels={showEventLabels}
              />
            </div>
          ))}
        </ResponsiveGridLayout>
      )}
    </div>
  );
}

// ─── Panel Router ───────────────────────────────────────────────────────────

function PanelRenderer({
  panel,
  rows,
  events,
  surface,
  textColor,
  panelSettings,
  deviceColors,
  devices,
  deviceLabels,
  showEventLabels,
}: {
  panel: LayoutPanel;
  rows: NormalizedRow[];
  events: EventRow[];
  surface: string;
  textColor: string;
  panelSettings?: PanelSettings;
  deviceColors: DeviceColorMap;
  devices?: string[];
  deviceLabels?: string[];
  showEventLabels: boolean;
}) {
  switch (panel.type) {
    case "text":
      return <TextPanel panel={panel} textColor={textColor} deviceLabels={deviceLabels} />;
    case "image":
      return <ImagePanel panel={panel} surface={surface} />;
    case "gauge":
      return <GaugePanel panel={panel} rows={rows} surface={surface} textColor={textColor} devices={devices} />;
    case "chart":
      return (
        <ChartPanel
          panel={panel}
          rows={rows}
          events={events}
          surface={surface}
          textColor={textColor}
          panelSettings={panelSettings}
          deviceColors={deviceColors}
          devices={devices}
          showEventLabels={showEventLabels}
        />
      );
  }
}

// ─── Text Panel ─────────────────────────────────────────────────────────────

function TextPanel({ panel, textColor, deviceLabels }: { panel: TextPanelConfig; textColor: string; deviceLabels?: string[] }) {
  const content = panel.contentRef !== undefined && deviceLabels?.[panel.contentRef]
    ? deviceLabels[panel.contentRef]
    : (panel.content ?? "");
  return (
    <div
      className="flex items-center h-full px-2 panel-drag-handle cursor-move"
      style={{
        color: textColor,
        fontSize: panel.fontSize ?? "1rem",
        textAlign: panel.align ?? "left",
        whiteSpace: "pre-line",
        lineHeight: 1.3,
        justifyContent: panel.align === "center" ? "center" : panel.align === "right" ? "flex-end" : "flex-start",
      }}
    >
      {content}
    </div>
  );
}

// ─── Image Panel ────────────────────────────────────────────────────────────

function ImagePanel({ panel, surface }: { panel: ImagePanelConfig; surface: string }) {
  return (
    <div
      className="h-full w-full rounded overflow-hidden panel-drag-handle cursor-move"
      style={{ background: surface }}
    >
      <img
        src={panel.src}
        alt={panel.alt ?? ""}
        className="w-full h-full"
        style={{ objectFit: panel.fit ?? "contain" }}
      />
    </div>
  );
}

// ─── Gauge Panel ────────────────────────────────────────────────────────────

function GaugePanel({
  panel,
  rows,
  surface,
  textColor,
  devices,
}: {
  panel: GaugePanelConfig;
  rows: NormalizedRow[];
  surface: string;
  textColor: string;
  devices?: string[];
}) {
  const metric = panel.metric ?? "battery_v";
  const ranges = panel.ranges ?? [2.0, 2.5, 3.0, 3.6];
  const df = resolveDeviceFilter(panel, devices);

  // Get the latest value for the filtered device(s)
  // Deduplicate by timestamp (take first occurrence per ts) so the gauge
  // value matches the chart's single-series rendering.
  const latestValue = useMemo(() => {
    const filtered = rows.filter((r) => {
      if (!df?.length) return true;
      return df.includes(r.deviceId ?? "");
    });
    const seenTs = new Set<number>();
    let latest: NormalizedRow | null = null;
    let latestTs = 0;
    for (const r of filtered) {
      const v = (r as Record<string, unknown>)[metric];
      if (typeof v !== "number" || !r.ts) continue;
      const ts = parseTs(r.ts);
      if (!Number.isFinite(ts)) continue;
      if (seenTs.has(ts)) continue; // skip duplicate timestamps
      seenTs.add(ts);
      if (ts > latestTs) { latestTs = ts; latest = r; }
    }
    return latest ? (latest as Record<string, unknown>)[metric] as number : null;
  }, [rows, df, metric]);

  const deviceLabel = panel.deviceRef !== undefined && devices?.[panel.deviceRef]
    ? ` [${devices[panel.deviceRef]}]`
    : df?.length === 1
      ? ` [${df[0]}]`
      : "";

  return (
    <div
      className="h-full rounded-lg p-1 flex flex-col panel-drag-handle cursor-move"
      style={{ background: surface, color: textColor }}
    >
      <BatteryGauge
        value={latestValue}
        ranges={ranges}
        title={panel.title + deviceLabel}
      />
    </div>
  );
}

// ─── Chart Panel ────────────────────────────────────────────────────────────

function ChartPanel({
  panel,
  rows,
  events,
  surface,
  textColor,
  panelSettings,
  deviceColors,
  devices,
  showEventLabels,
}: {
  panel: ChartPanelConfig;
  rows: NormalizedRow[];
  events: EventRow[];
  surface: string;
  textColor: string;
  panelSettings?: PanelSettings;
  deviceColors: DeviceColorMap;
  devices?: string[];
  showEventLabels: boolean;
}) {
  const resolved = useMemo(
    () => ({ ...panel, deviceFilter: resolveDeviceFilter(panel, devices) }),
    [panel, devices],
  );

  const datasets = useMemo(
    () => buildChartDatasets(resolved, rows, deviceColors),
    [resolved, rows, deviceColors],
  );

  const annotations = useMemo(() => {
    if (panel.showEvents === false || panel.metric === "air_temp_c") return {};
    const deviceFilter = resolved.deviceFilter;
    // Show event if: no deviceId (global) OR deviceId matches this panel's device filter
    const visibleEvents = events.filter((e) =>
      !e.deviceId || !deviceFilter?.length || deviceFilter.includes(e.deviceId),
    );
    return Object.fromEntries(
      visibleEvents.map((e, i) => {
        // Support both date-only ("2025-07-15") and datetime ("2025-07-15T10:30+09:00")
        const ts = parseTs(e.date);
        return [
          `ev-${i}`,
          {
            type: "line" as const,
            xMin: ts,
            xMax: ts,
            borderColor: e.color || "#ef4444",
            borderWidth: 1,
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
        ];
      }),
    );
  }, [events, panel.showEvents, panel.metric, resolved.deviceFilter, showEventLabels]);

  const yMin = panelSettings?.yMin ?? (panel.metric === "battery_v" ? 3.0 : panel.yMin);
  const yMax = panelSettings?.yMax ?? (panel.metric === "battery_v" ? 3.6 : panel.yMax);
  const yLabel = panelSettings?.yLabel ?? panel.yLabel;
  const hideLegend = SINGLE_SERIES_METRICS.has(panel.metric) || datasets.length <= 1;

  return (
    <div
      className="h-full rounded-lg p-2 flex flex-col panel-drag-handle cursor-move"
      style={{ background: surface, color: textColor }}
    >
      <h4 className="text-xs font-semibold mb-0.5 opacity-80 truncate">
        {panel.title}
        {panel.deviceRef !== undefined && devices?.[panel.deviceRef] && (
          <span className="ml-1 font-normal opacity-70">[{devices[panel.deviceRef]}]</span>
        )}
        {panel.deviceRef === undefined && panel.deviceFilter?.length === 1 && (
          <span className="ml-1 font-normal opacity-70">[{panel.deviceFilter[0]}]</span>
        )}
      </h4>
      <div className="relative flex-1 min-h-0">
        <Line
          data={{ datasets }}
          options={{
            responsive: true,
            maintainAspectRatio: false,
            parsing: false,
            animation: false,
            scales: {
              x: {
                type: "time",
                time: {
                  tooltipFormat: "yyyy-MM-dd HH:mm",
                  displayFormats: {
                    minute: "M/d HH:mm",
                    hour: "M/d HH:mm",
                    day: "M/d",
                    week: "M/d",
                    month: "yyyy/M",
                  },
                },
                ticks: {
                  color: textColor + "aa",
                  maxTicksLimit: 6,
                  font: { size: 9 },
                },
                grid: { color: textColor + "15" },
              },
              y: {
                min: yMin,
                max: yMax,
                title: yLabel ? { display: true, text: yLabel, color: textColor + "bb", font: { size: 9 } } : undefined,
                ticks: { color: textColor + "aa", font: { size: 9 } },
                grid: { color: textColor + "15" },
              },
            },
            plugins: {
              legend: {
                display: !hideLegend,
                position: "top" as const,
                labels: { color: textColor + "cc", boxWidth: 12, font: { size: 9 } },
              },
              tooltip: { mode: "nearest", intersect: false },
              annotation: { annotations },
            },
            elements: {
              point: { radius: 0 },
              line: { borderWidth: 1.5, tension: 0.1 },
            },
          }}
        />
      </div>
    </div>
  );
}

// ─── Dataset Builder ────────────────────────────────────────────────────────

const DEFAULT_COLORS = [
  "#0000ff", "#00cc00", "#cccc00", "#ff0000", "#a855f7",
  "#14b8a6", "#f97316", "#ec4899",
];

function buildChartDatasets(
  panel: ChartPanelConfig,
  rows: NormalizedRow[],
  deviceColors: DeviceColorMap,
) {
  // Filter rows by device/sensor
  let filtered = rows;
  if (panel.deviceFilter?.length) {
    filtered = filtered.filter((r) => panel.deviceFilter!.includes(r.deviceId ?? ""));
  }
  if (panel.sensorFilter?.length) {
    filtered = filtered.filter((r) => panel.sensorFilter!.includes(r.sensorNumber ?? ""));
  }

  const groupBy = panel.groupBy ?? "deviceId";
  const singleSeries = SINGLE_SERIES_METRICS.has(panel.metric);
  const groups = new Map<string, { color: string; label: string; data: { x: number; y: number }[] }>();
  let colorIdx = 0;
  const fallbackSingleColor = panel.groupColors
    ? Object.values(panel.groupColors)[0]
    : undefined;
  // For single-series metrics, deduplicate by timestamp so duplicate sensor
  // readings at the same moment don't zigzag the line.
  const singleSeriesSeenTs = singleSeries ? new Map<string, Set<number>>() : null;

  for (const r of filtered) {
    const v = (r as Record<string, unknown>)[panel.metric];
    if (typeof v !== "number" || !r.ts) continue;
    const x = parseTs(r.ts);
    if (!Number.isFinite(x)) continue;

    const key = singleSeries
      ? panel.id
      : groupBy === "sensorNumber"
      ? (r.sensorNumber ?? "(no sensor)")
      : (r.deviceId ?? "(default)");

    if (singleSeriesSeenTs) {
      if (!singleSeriesSeenTs.has(key)) singleSeriesSeenTs.set(key, new Set());
      const tsSet = singleSeriesSeenTs.get(key)!;
      if (tsSet.has(x)) continue; // duplicate timestamp — skip
      tsSet.add(x);
    }

    if (!groups.has(key)) {
      // Determine color: groupColors > deviceColors > default palette
      let color: string;
      if (singleSeries && fallbackSingleColor) {
        color = fallbackSingleColor;
      } else if (panel.groupColors?.[key]) {
        color = panel.groupColors[key];
      } else if (deviceColors[key]) {
        color = deviceColors[key];
      } else {
        color = DEFAULT_COLORS[colorIdx % DEFAULT_COLORS.length];
      }
      // Determine label
      const label = singleSeries ? panel.title : (panel.groupLabels?.[key] ?? key);
      groups.set(key, { color, label, data: [] });
      colorIdx++;
    }
    groups.get(key)!.data.push({ x, y: v });
  }

  return Array.from(groups.values()).map((g) => ({
    label: g.label,
    borderColor: g.color,
    backgroundColor: g.color + "20",
    data: g.data,
  }));
}
