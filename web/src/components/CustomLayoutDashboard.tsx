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
  showEventLabels,
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
  const viewportH = typeof window !== "undefined" ? window.innerHeight - 80 : 800;
  const rowHeight = Math.max(30, Math.floor(viewportH / Math.max(maxRow, 1)));

  const gridLayout = useMemo(() =>
    layout.panels.map((p) => ({
      i: p.id,
      x: p.position.x,
      y: p.position.y,
      w: p.position.w,
      h: p.position.h,
      minW: 1,
      minH: 1,
    })),
    [layout.panels],
  );

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
      style={{ background: bg, color: textColor, minHeight: "100vh" }}
    >
      {width > 0 && (
        <ResponsiveGridLayout
          width={width}
          className="layout"
          layouts={{ lg: gridLayout, md: gridLayout, sm: gridLayout }}
          breakpoints={{ lg: 996, md: 768, sm: 480 }}
          cols={{ lg: cols, md: Math.max(4, Math.floor(cols / 2)), sm: 2 }}
          rowHeight={rowHeight}
          onLayoutChange={handleLayoutChange}
          dragConfig={{ handle: ".panel-drag-handle" }}
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
                showEventLabels={showEventLabels ?? true}
                devices={layout.devices}
                deviceLabels={layout.deviceLabels ?? layout.devices}
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
  showEventLabels,
  devices,
  deviceLabels,
}: {
  panel: LayoutPanel;
  rows: NormalizedRow[];
  events: EventRow[];
  surface: string;
  textColor: string;
  panelSettings?: PanelSettings;
  deviceColors: DeviceColorMap;
  showEventLabels: boolean;
  devices?: string[];
  deviceLabels?: string[];
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
          showEventLabels={showEventLabels}
          devices={devices}
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
  const latestValue = useMemo(() => {
    const filtered = rows.filter((r) => {
      if (!df?.length) return true;
      return df.includes(r.deviceId ?? "");
    });
    // Find latest row that has the metric
    let latest: NormalizedRow | null = null;
    let latestTs = 0;
    for (const r of filtered) {
      const v = (r as Record<string, unknown>)[metric];
      if (typeof v !== "number" || !r.ts) continue;
      const ts = parseTs(r.ts);
      if (ts > latestTs) { latestTs = ts; latest = r; }
    }
    return latest ? (latest as Record<string, unknown>)[metric] as number : null;
  }, [rows, df, metric]);

  return (
    <div
      className="h-full rounded-lg p-1 flex flex-col panel-drag-handle cursor-move"
      style={{ background: surface, color: textColor }}
    >
      <BatteryGauge
        value={latestValue}
        ranges={ranges}
        title={panel.title}
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
  showEventLabels,
  devices,
}: {
  panel: ChartPanelConfig;
  rows: NormalizedRow[];
  events: EventRow[];
  surface: string;
  textColor: string;
  panelSettings?: PanelSettings;
  deviceColors: DeviceColorMap;
  showEventLabels: boolean;
  devices?: string[];
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
    if (panel.showEvents === false) return {};
    return Object.fromEntries(
      events.map((e, i) => {
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
              backgroundColor: "rgba(0,0,0,0.7)",
              color: "#fff",
              font: { size: 9 },
            },
          },
        ];
      }),
    );
  }, [events, panel.showEvents, showEventLabels]);

  const yMin = panelSettings?.yMin ?? panel.yMin;
  const yMax = panelSettings?.yMax ?? panel.yMax;
  const yLabel = panelSettings?.yLabel ?? panel.yLabel;

  return (
    <div
      className="h-full rounded-lg p-2 flex flex-col panel-drag-handle cursor-move"
      style={{ background: surface, color: textColor }}
    >
      <h4 className="text-xs font-semibold mb-0.5 opacity-80 truncate">{panel.title}</h4>
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
                  displayFormats: { day: "M/d" },
                },
                ticks: { color: textColor + "aa", maxTicksLimit: 6, font: { size: 9 } },
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
                display: true,
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
  const groups = new Map<string, { color: string; label: string; data: { x: number; y: number }[] }>();
  let colorIdx = 0;

  for (const r of filtered) {
    const v = (r as Record<string, unknown>)[panel.metric];
    if (typeof v !== "number" || !r.ts) continue;
    const x = parseTs(r.ts);
    if (!Number.isFinite(x)) continue;

    const key = groupBy === "sensorNumber"
      ? (r.sensorNumber ?? "(no sensor)")
      : (r.deviceId ?? "(default)");

    if (!groups.has(key)) {
      // Determine color: groupColors > deviceColors > default palette
      let color: string;
      if (panel.groupColors?.[key]) {
        color = panel.groupColors[key];
      } else if (deviceColors[key]) {
        color = deviceColors[key];
      } else {
        color = DEFAULT_COLORS[colorIdx % DEFAULT_COLORS.length];
      }
      // Determine label
      const label = panel.groupLabels?.[key] ?? key;
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
