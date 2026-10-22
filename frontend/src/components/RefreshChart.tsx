import { useMemo, useState } from 'react';
import { RefreshRun } from '../types.js';

interface RefreshChartProps {
  runs: RefreshRun[];
  /** Window to display, in hours (6 / 24 / 168). */
  rangeHours: number;
  /** Budget for the upcoming tick, used to extend the budget line to "now". */
  currentBudget?: number;
  /** Sources currently due, used to extend the backlog line to "now". */
  dueNow?: number;
  /** Cron period; bars are sized to this so the chart reads as a continuous timeline. */
  tickIntervalMinutes?: number;
}

interface Pt {
  x: number;
  y: number;
}

const W = 800;
const H = 240;
const PAD = { left: 42, right: 14, top: 14, bottom: 28 };
const Y_DIVISIONS = 4;

function timestamp(run: RefreshRun): number {
  return new Date(run.startedAt).getTime();
}

function formatTime(ms: number, rangeHours: number): string {
  const date = new Date(ms);
  if (rangeHours > 24) {
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Round a step up to 1/2/5 x 10^n so axis labels stay readable. */
function niceStep(value: number): number {
  if (value <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

/**
 * Monotone cubic curve through the points (Fritsch-Carlson tangents). It is smooth
 * but does not overshoot between values, so a tick count never dips below zero or
 * above a nearby peak.
 */
function smoothPath(points: Pt[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }

  const n = points.length;
  const h: number[] = [];
  const delta: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h[i] = Math.max(0.001, points[i + 1].x - points[i].x);
    delta[i] = (points[i + 1].y - points[i].y) / h[i];
  }

  const tangent: number[] = new Array(n);
  tangent[0] = delta[0];
  tangent[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      tangent[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      tangent[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }

  for (let i = 0; i < n - 1; i++) {
    if (delta[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / delta[i];
    const b = tangent[i + 1] / delta[i];
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangent[i] = scale * a * delta[i];
      tangent[i + 1] = scale * b * delta[i];
    }
  }

  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = h[i];
    const c1x = points[i].x + dx / 3;
    const c1y = points[i].y + (tangent[i] * dx) / 3;
    const c2x = points[i + 1].x - dx / 3;
    const c2y = points[i + 1].y - (tangent[i + 1] * dx) / 3;
    path += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${points[i + 1].x} ${points[i + 1].y}`;
  }
  return path;
}

function areaPath(points: Pt[], baseY: number): string {
  if (points.length < 2) return '';
  return `${smoothPath(points)} L ${points[points.length - 1].x} ${baseY} L ${points[0].x} ${baseY} Z`;
}

/**
 * Smooth SVG chart of refresh ticks: attempted sources and failures as smoothed
 * areas, the adaptive budget and the due backlog as smoothed lines.
 *
 * The x-axis always spans the selected window ending at "now", so gaps after the
 * server was offline show up as real gaps instead of stretching a few ticks across
 * the whole chart. Series are split at gaps larger than one cron interval, so a
 * smooth curve never bridges an outage.
 */
export default function RefreshChart({
  runs,
  rangeHours,
  currentBudget,
  dueNow,
  tickIntervalMinutes = 5,
}: RefreshChartProps) {
  const [hover, setHover] = useState<number | null>(null);

  const data = useMemo(() => {
    const cutoff = Date.now() - rangeHours * 60 * 60 * 1000;
    return runs
      .filter((run) => timestamp(run) >= cutoff)
      .sort((a, b) => timestamp(a) - timestamp(b));
  }, [runs, rangeHours]);

  const geom = useMemo(() => {
    const now = Date.now();
    const rangeMs = rangeHours * 60 * 60 * 1000;
    const t0 = now - rangeMs;
    const span = Math.max(1, rangeMs);

    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;

    const rawMax = Math.max(
      4,
      currentBudget ?? 0,
      dueNow ?? 0,
      ...data.map((run) => Math.max(run.budget, run.due, run.attempted))
    );
    const yStep = niceStep(rawMax / Y_DIVISIONS);
    const yMax = yStep * Y_DIVISIONS;

    const tickMs = Math.max(1, tickIntervalMinutes) * 60 * 1000;
    const bucketWidth = Math.max(2, Math.min(28, (tickMs / span) * plotW));
    const innerLeft = PAD.left + bucketWidth / 2;
    const innerRight = W - PAD.right - bucketWidth / 2;

    const x = (t: number) =>
      innerLeft + (Math.min(now, Math.max(t0, t)) - t0) / span * (innerRight - innerLeft);
    const y = (value: number) => PAD.top + plotH - (value / yMax) * plotH;
    const baseY = y(0);

    // Split at missing ticks (outage / paused machine) so interpolation cannot draw
    // a curve through a period where nothing ran.
    const gapMs = tickMs * 1.5;
    const rawSegments: RefreshRun[][] = [];
    for (const run of data) {
      const last = rawSegments[rawSegments.length - 1];
      if (!last || timestamp(run) - timestamp(last[last.length - 1]) > gapMs) {
        rawSegments.push([run]);
      } else {
        last.push(run);
      }
    }

    const lastRun = data[data.length - 1];
    const connectToNow = Boolean(lastRun) && now - timestamp(lastRun) <= gapMs;

    // An isolated tick has no neighbouring point to interpolate with; widen it to one
    // bucket so it still renders as a short plateau.
    const widen = (points: Pt[]): Pt[] => {
      if (points.length !== 1) return points;
      const point = points[0];
      const x1 = Math.max(PAD.left, point.x - bucketWidth / 2);
      const x2 = Math.max(x1 + 1, Math.min(W - PAD.right, point.x + bucketWidth / 2));
      return [
        { x: x1, y: point.y },
        { x: x2, y: point.y },
      ];
    };

    const segments = rawSegments.map((segment, segmentIndex) => {
      const centers = segment.map((run) => x(timestamp(run)));
      const isLast = segmentIndex === rawSegments.length - 1;

      const attemptedPts = widen(
        segment.map((run, index) => ({ x: centers[index], y: y(run.attempted) }))
      );
      const failedPts = widen(
        segment.map((run, index) => ({ x: centers[index], y: y(run.failed) }))
      );
      const hasFailed = segment.some((run) => run.failed > 0);

      const budgetPts: Pt[] = segment.map((run, index) => ({
        x: centers[index],
        y: y(run.budget),
      }));
      if (isLast && connectToNow && currentBudget !== undefined) {
        budgetPts.push({ x: x(now), y: y(currentBudget) });
      }

      const duePts: Pt[] = segment.map((run, index) => ({
        x: centers[index],
        y: y(run.due),
      }));
      if (isLast && connectToNow && dueNow !== undefined) {
        duePts.push({ x: x(now), y: y(dueNow) });
      }

      return {
        attemptedArea: areaPath(attemptedPts, baseY),
        attemptedLine: smoothPath(attemptedPts),
        failedArea: hasFailed ? areaPath(failedPts, baseY) : '',
        failedLine: hasFailed ? smoothPath(failedPts) : '',
        budgetPath: smoothPath(widen(budgetPts)),
        duePath: smoothPath(widen(duePts)),
      };
    });

    const centers = data.map((run) => x(timestamp(run)));

    const xTicks = [0, 1 / 3, 2 / 3, 1].map((fraction) => ({
      x: x(t0 + fraction * span),
      label: formatTime(t0 + fraction * span, rangeHours),
    }));

    return {
      yMax,
      yStep,
      y,
      centers,
      segments,
      xTicks,
    };
  }, [data, rangeHours, currentBudget, dueNow, tickIntervalMinutes]);

  if (data.length === 0) {
    return (
      <div className="h-48 flex items-center justify-center text-sm text-gray-400 dark:text-gray-500 border border-dashed border-gray-200 dark:border-gray-800 rounded-lg">
        No ticks recorded in this window yet.
      </div>
    );
  }

  const hovered = hover !== null ? data[hover] : null;
  const hoveredX = hover !== null ? geom.centers[hover] : 0;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto select-none"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const frac = (event.clientX - rect.left) / rect.width;
          const target = PAD.left + Math.min(1, Math.max(0, frac)) * (W - PAD.left - PAD.right);
          let nearest = 0;
          let best = Infinity;
          geom.centers.forEach((center, index) => {
            const distance = Math.abs(center - target);
            if (distance < best) {
              best = distance;
              nearest = index;
            }
          });
          setHover(nearest);
        }}
      >
        {/* horizontal grid + y labels */}
        {Array.from({ length: Y_DIVISIONS + 1 }, (_, index) => index).map((index) => {
          const fraction = index / Y_DIVISIONS;
          const yPos = PAD.top + (H - PAD.top - PAD.bottom) * (1 - fraction);
          return (
            <g key={index}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={yPos}
                y2={yPos}
                className="stroke-gray-200 dark:stroke-gray-800"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={yPos + 3}
                textAnchor="end"
                className="fill-gray-400 dark:fill-gray-500"
                fontSize={10}
              >
                {Math.round(geom.yStep * index)}
              </text>
            </g>
          );
        })}

        {/* vertical grid at the x labels, so gaps read against real time */}
        {geom.xTicks.slice(1, -1).map((tick, index) => (
          <line
            key={index}
            x1={tick.x}
            x2={tick.x}
            y1={PAD.top}
            y2={H - PAD.bottom}
            className="stroke-gray-100 dark:stroke-gray-800/70"
            strokeWidth={1}
          />
        ))}

        {/* attempted / failed areas */}
        {geom.segments.map((segment, index) => (
          <g key={`area-${index}`}>
            <path
              d={segment.attemptedArea}
              className="fill-indigo-400/30 dark:fill-indigo-500/30"
            />
            {segment.failedArea && (
              <path d={segment.failedArea} className="fill-red-400/45 dark:fill-red-500/45" />
            )}
          </g>
        ))}

        {/* attempted / failed outlines */}
        {geom.segments.map((segment, index) => (
          <g key={`line-${index}`}>
            <path
              d={segment.attemptedLine}
              fill="none"
              className="stroke-indigo-500"
              strokeWidth={1.5}
            />
            {segment.failedLine && (
              <path
                d={segment.failedLine}
                fill="none"
                className="stroke-red-500"
                strokeWidth={1.5}
              />
            )}
          </g>
        ))}

        {/* due backlog */}
        {geom.segments.map((segment, index) =>
          segment.duePath ? (
            <path
              key={`due-${index}`}
              d={segment.duePath}
              fill="none"
              className="stroke-amber-500"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
          ) : null
        )}

        {/* adaptive budget */}
        {geom.segments.map((segment, index) =>
          segment.budgetPath ? (
            <path
              key={`budget-${index}`}
              d={segment.budgetPath}
              fill="none"
              className="stroke-emerald-500"
              strokeWidth={2}
            />
          ) : null
        )}

        {/* hover crosshair + point */}
        {hover !== null && (
          <>
            <line
              x1={hoveredX}
              x2={hoveredX}
              y1={PAD.top}
              y2={H - PAD.bottom}
              className="stroke-gray-400 dark:stroke-gray-600"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <circle
              cx={hoveredX}
              cy={geom.y(hovered?.attempted ?? 0)}
              r={3}
              className="fill-indigo-500 stroke-white dark:stroke-gray-950"
              strokeWidth={1.5}
            />
          </>
        )}

        {/* x axis labels */}
        {geom.xTicks.map((tick, index) => (
          <text
            key={index}
            x={tick.x}
            y={H - 8}
            textAnchor={
              index === 0 ? 'start' : index === geom.xTicks.length - 1 ? 'end' : 'middle'
            }
            className="fill-gray-400 dark:fill-gray-500"
            fontSize={10}
          >
            {tick.label}
          </text>
        ))}
      </svg>

      {hovered && (
        <div
          className="pointer-events-none absolute top-0 z-10 bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg shadow-lg px-3 py-2 text-[11px] leading-relaxed whitespace-nowrap"
          style={{
            left: `${Math.min(88, Math.max(12, (hoveredX / W) * 100))}%`,
            transform: 'translate(-50%, 0)',
          }}
        >
          <div className="font-semibold text-gray-700 dark:text-gray-200 mb-1">
            {formatTime(timestamp(hovered), rangeHours)}
          </div>
          <div className="text-gray-500 dark:text-gray-400">
            attempted{' '}
            <span className="font-semibold text-gray-800 dark:text-gray-100">
              {hovered.attempted}
            </span>
            {' · '}budget{' '}
            <span className="font-semibold text-emerald-600 dark:text-emerald-400">
              {hovered.budget}
            </span>
          </div>
          <div className="text-gray-500 dark:text-gray-400">
            due{' '}
            <span className="font-semibold text-amber-600 dark:text-amber-400">
              {hovered.due}
            </span>
            {' · '}failed{' '}
            <span className="font-semibold text-red-600 dark:text-red-400">
              {hovered.failed}
            </span>
          </div>
          <div className="text-gray-500 dark:text-gray-400">
            {hovered.durationMs !== null
              ? `${(hovered.durationMs / 1000).toFixed(1)}s`
              : 'running…'}
          </div>
        </div>
      )}

      <div className="flex items-center flex-wrap gap-4 mt-1 pl-10 text-[11px] text-gray-500 dark:text-gray-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-indigo-400/50 border-t border-indigo-500" />
          attempted
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-red-400/60 border-t border-red-500" />
          failed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-4 h-0.5 bg-emerald-500" />
          budget
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-4 h-0.5 bg-amber-500 border-t border-dashed border-amber-500" />
          due backlog
        </span>
        <span className="text-gray-400 dark:text-gray-500">smooth, window ends at now</span>
      </div>
    </div>
  );
}
