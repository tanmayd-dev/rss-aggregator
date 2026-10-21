import { useMemo, useState } from 'react';
import { RefreshRun } from '../types.js';

interface RefreshChartProps {
  runs: RefreshRun[];
  /** Window to display, in hours (6 / 24 / 168). */
  rangeHours: number;
}

const W = 800;
const H = 240;
const PAD = { left: 42, right: 14, top: 14, bottom: 28 };

function timestamp(run: RefreshRun): number {
  return new Date(run.finishedAt ?? run.startedAt).getTime();
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

/**
 * Lightweight SVG chart of refresh ticks: attempted sources (bars), the adaptive
 * budget (step line) and the due backlog (dashed line). No chart dependency.
 */
export default function RefreshChart({ runs, rangeHours }: RefreshChartProps) {
  const [hover, setHover] = useState<number | null>(null);

  const data = useMemo(() => {
    const cutoff = Date.now() - rangeHours * 60 * 60 * 1000;
    return runs.filter((run) => timestamp(run) >= cutoff);
  }, [runs, rangeHours]);

  const geom = useMemo(() => {
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const maxValue = Math.max(
      1,
      ...data.map((run) => Math.max(run.budget, run.due, run.attempted))
    );
    const yMax = Math.max(4, Math.ceil(maxValue * 1.15));

    const t0 = data.length > 0 ? timestamp(data[0]) : Date.now();
    const t1 = data.length > 1 ? timestamp(data[data.length - 1]) : t0 + 60_000;
    const span = Math.max(1, t1 - t0);

    const x = (t: number) => PAD.left + ((t - t0) / span) * plotW;
    const y = (value: number) => PAD.top + plotH - (value / yMax) * plotH;

    const centers = data.map((run) =>
      data.length === 1 ? PAD.left + plotW / 2 : x(timestamp(run))
    );
    const barWidth =
      data.length <= 1 ? 14 : Math.max(1.5, (plotW / data.length) * 0.66);

    let budgetPath = '';
    if (data.length > 0) {
      budgetPath = `M ${centers[0]} ${y(data[0].budget)}`;
      for (let i = 1; i < data.length; i++) {
        budgetPath += ` H ${centers[i]} V ${y(data[i].budget)}`;
      }
    }

    const duePath =
      data.length > 1
        ? data.map((run, i) => `${i === 0 ? 'M' : 'L'} ${centers[i]} ${y(run.due)}`).join(' ')
        : '';

    const xTicks = [0, 1 / 3, 2 / 3, 1].map((fraction) => ({
      x: PAD.left + fraction * plotW,
      label: formatTime(t0 + fraction * span, rangeHours),
    }));

    return { plotW, plotH, yMax, x, y, centers, barWidth, budgetPath, duePath, xTicks };
  }, [data, rangeHours]);

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
          const target = PAD.left + Math.min(1, Math.max(0, frac)) * geom.plotW;
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
        {[0, 0.5, 1].map((fraction) => {
          const value = Math.round(geom.yMax * fraction);
          const yPos = geom.y(geom.yMax * fraction);
          return (
            <g key={fraction}>
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
                {value}
              </text>
            </g>
          );
        })}

        {/* attempted bars, with failed portion in red */}
        {data.map((run, index) => {
          const center = geom.centers[index];
          const base = geom.y(0);
          const top = geom.y(Math.max(run.attempted, 0));
          const failedTop = geom.y(Math.max(run.failed, 0));
          return (
            <g key={run.id}>
              <rect
                x={center - geom.barWidth / 2}
                y={top}
                width={geom.barWidth}
                height={Math.max(0, base - top)}
                className="fill-indigo-400 dark:fill-indigo-500"
                rx={1}
              />
              {run.failed > 0 && (
                <rect
                  x={center - geom.barWidth / 2}
                  y={failedTop}
                  width={geom.barWidth}
                  height={Math.max(0, base - failedTop)}
                  className="fill-red-400 dark:fill-red-500"
                  rx={1}
                />
              )}
            </g>
          );
        })}

        {/* due backlog */}
        {geom.duePath && (
          <path
            d={geom.duePath}
            fill="none"
            className="stroke-amber-500"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
        )}

        {/* adaptive budget */}
        <path
          d={geom.budgetPath}
          fill="none"
          className="stroke-emerald-500"
          strokeWidth={2}
        />

        {/* hover crosshair */}
        {hover !== null && (
          <line
            x1={hoveredX}
            x2={hoveredX}
            y1={PAD.top}
            y2={H - PAD.bottom}
            className="stroke-gray-400 dark:stroke-gray-600"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        )}

        {/* x axis labels */}
        {geom.xTicks.map((tick, index) => (
          <text
            key={index}
            x={tick.x}
            y={H - 8}
            textAnchor={index === 0 ? 'start' : index === geom.xTicks.length - 1 ? 'end' : 'middle'}
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
            {formatTime(timestamp(hovered), 168)}
          </div>
          <div className="text-gray-500 dark:text-gray-400">
            attempted <span className="font-semibold text-gray-800 dark:text-gray-100">{hovered.attempted}</span>
            {' · '}budget <span className="font-semibold text-emerald-600 dark:text-emerald-400">{hovered.budget}</span>
          </div>
          <div className="text-gray-500 dark:text-gray-400">
            due <span className="font-semibold text-amber-600 dark:text-amber-400">{hovered.due}</span>
            {' · '}failed <span className="font-semibold text-red-600 dark:text-red-400">{hovered.failed}</span>
          </div>
          <div className="text-gray-500 dark:text-gray-400">
            {hovered.durationMs !== null ? `${(hovered.durationMs / 1000).toFixed(1)}s` : 'running…'}
          </div>
        </div>
      )}

      <div className="flex items-center flex-wrap gap-4 mt-1 pl-10 text-[11px] text-gray-500 dark:text-gray-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-indigo-400 dark:bg-indigo-500" />
          attempted
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-red-400 dark:bg-red-500" />
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
      </div>
    </div>
  );
}
