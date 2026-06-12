

interface BatteryGaugeProps {
  /** Current battery voltage value. */
  value: number | null;
  /** [min, yellowStart, greenStart, max] thresholds. */
  ranges: [number, number, number, number];
  /** Label text (e.g. "Battery voltage[V]"). */
  title?: string;
}

/**
 * Half-circle battery gauge with red/yellow/green zones.
 * Matches the Kashimadai dashboard style.
 * Responsive: fills its container.
 */
export function BatteryGauge({ value, ranges, title }: BatteryGaugeProps) {
  const [min, yellowStart, greenStart, max] = ranges;
  const total = max - min;

  // Use a fixed viewBox and let SVG scale to container
  const vw = 200;
  const vh = 120;
  const cx = vw / 2;
  const cy = vh * 0.85;
  const radius = 70;
  const strokeWidth = 18;

  function angleForValue(v: number): number {
    const ratio = Math.max(0, Math.min(1, (v - min) / total));
    return Math.PI * (1 - ratio); // π (left) to 0 (right)
  }

  function arcPath(startAngle: number, endAngle: number): string {
    const x1 = cx + radius * Math.cos(startAngle);
    const y1 = cy - radius * Math.sin(startAngle);
    const x2 = cx + radius * Math.cos(endAngle);
    const y2 = cy - radius * Math.sin(endAngle);
    const largeArc = startAngle - endAngle > Math.PI ? 1 : 0;
    return `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 0 ${x2} ${y2}`;
  }

  // Zone arcs
  const redEnd = angleForValue(yellowStart);
  const yellowEnd = angleForValue(greenStart);

  // Needle position
  const needleAngle = value !== null ? angleForValue(value) : Math.PI / 2;
  const needleLen = radius - strokeWidth * 0.4;
  const nx = cx + needleLen * Math.cos(needleAngle);
  const ny = cy - needleLen * Math.sin(needleAngle);

  return (
    <div className="flex flex-col items-center justify-center h-full w-full">
      {title && (
        <div className="text-xs font-medium opacity-80 truncate w-full text-center">
          {title}
        </div>
      )}
      <svg viewBox={`0 0 ${vw} ${vh}`} className="w-full flex-1 max-h-full" preserveAspectRatio="xMidYMid meet">
        {/* Red zone */}
        <path
          d={arcPath(Math.PI, redEnd)}
          fill="none"
          stroke="#dc2626"
          strokeWidth={strokeWidth}
          strokeLinecap="butt"
        />
        {/* Yellow zone */}
        <path
          d={arcPath(redEnd, yellowEnd)}
          fill="none"
          stroke="#eab308"
          strokeWidth={strokeWidth}
          strokeLinecap="butt"
        />
        {/* Green zone */}
        <path
          d={arcPath(yellowEnd, 0)}
          fill="none"
          stroke="#16a34a"
          strokeWidth={strokeWidth}
          strokeLinecap="butt"
        />
        {/* Needle */}
        {value !== null && (
          <>
            <line
              x1={cx} y1={cy} x2={nx} y2={ny}
              stroke="#ffffff" strokeWidth={2.5}
            />
            <circle cx={cx} cy={cy} r={4} fill="#ffffff" />
          </>
        )}
      </svg>
      {value !== null && (
        <div className="text-sm font-mono font-bold">
          {value.toFixed(3)}
        </div>
      )}
    </div>
  );
}
