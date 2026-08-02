import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { formatValue } from './TimeChart.jsx';
import { toColumns, plotShape } from '../lib/plotData.js';

// uPlot is imported dynamically, and that is not a size optimisation — it
// touches browser globals (matchMedia, devicePixelRatio) at MODULE LOAD, not
// at construction. A static import therefore runs that code everywhere the
// module is pulled in, including the render harness, where it throws before a
// single component has rendered. Loading it behind the same guard that decides
// whether a canvas can be drawn at all keeps it out of those environments
// entirely — and keeps it out of the initial bundle as a bonus.

// iter15 m2 — a chart that can be drawn thirty times on one screen.
//
// The hand-written SVG chart it replaces was the right call for a single graph
// on a single tab: a library would have outweighed the page. A dashboard of
// per-server and per-stream charts is a different problem — dozens of series,
// several hundred points each, redrawn every few seconds — and that is the
// case uPlot exists for. Naming the reversal rather than quietly making it.
//
// Everything awkward about wrapping an imperative canvas library in React is
// in here so no caller has to think about it:
//
//   * the instance is created once and fed with setData; recreating it on
//     every render would drop the zoom and cost a full redraw per tick
//   * it IS recreated when the shape changes — uPlot cannot add or remove a
//     series after construction — and the shape is derived, not signalled
//   * the size follows the container through a ResizeObserver, because these
//     live in a grid that reflows
//   * colours come from the stylesheet, so the light theme needs no second
//     code path

const COLORS = ['#3fb6a8', '#e0a83c', '#7aa7ff', '#e04545', '#9d7ae0', '#4fc36a'];

const cssVar = (name, fallback) => {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch { return fallback; }
};

// jsdom has no 2D context, and the render smoke tests run there. A chart that
// throws would take the whole page down with it — in the tests and in any
// browser with canvas disabled — so it degrades to nothing instead.
function canDraw() {
  try { return Boolean(document.createElement('canvas').getContext('2d')); }
  catch { return false; }
}

export default function Plot({
  points,          // [{ ts, v: [n, ...] }]
  series,          // series names, one per entry in v
  unit = '',
  height = 220,
  emptyText = 'No data',
}) {
  const host = useRef(null);
  const chart = useRef(null);

  // uPlot wants columnar data; the transform lives in lib/ so it can be
  // tested without a canvas.
  const data = useMemo(() => toColumns(points, series?.length || 0), [points, series]);

  // What forces a rebuild rather than a data swap.
  const shape = useMemo(() => plotShape(series, unit, height), [series, unit, height]);

  useLayoutEffect(() => {
    if (!host.current || !data || !canDraw()) return undefined;

    let cancelled = false;
    let ro = null;

    const tip = document.createElement('div');
    tip.className = 'plot-tip';
    tip.style.display = 'none';

    (async () => {
      const [{ default: uPlot }] = await Promise.all([
        import('uplot'),
        import('uplot/dist/uPlot.min.css'),
      ]);
      if (cancelled || !host.current) return;

      const text = cssVar('--text-dim', '#8b9bb4');
      const line = cssVar('--line', '#243244');
      const opts = {
        width: host.current.clientWidth || 600,
        height,
        padding: [8, 8, 0, 0],
        cursor: {
          drag: { x: true, y: false },
          points: { size: 5 },
          // A reading without its moment is half a reading. uPlot's own legend
          // is a table under the chart, which is too much furniture for a
          // 90px tile — so the values are lifted into a small floating label
          // that follows the cursor.
          bind: {
            mouseleave: (u, targ, handler) => (e) => { tip.style.display = 'none'; handler(e); },
          },
        },
        legend: { show: false },
        hooks: {
          setCursor: [(u) => {
            const { idx, left, top } = u.cursor;
            if (idx == null || left < 0) { tip.style.display = 'none'; return; }
            const at = new Date(u.data[0][idx] * 1000);
            const rows = (series || []).map((name, i) => {
              const v = u.data[i + 1]?.[idx];
              return v == null ? null : `${name}: ${formatValue(v, unit)}`;
            }).filter(Boolean);
            if (!rows.length) { tip.style.display = 'none'; return; }
            tip.innerHTML = `<b>${at.toLocaleTimeString()}</b><br>${rows.join('<br>')}`;
            tip.style.display = 'block';
            // Flip to the other side near the right edge so the label never
            // leaves the chart it belongs to.
            const w = tip.offsetWidth;
            tip.style.left = `${left + w + 16 > u.over.clientWidth ? left - w - 12 : left + 12}px`;
            tip.style.top = `${Math.max(0, top - 8)}px`;
          }],
        },
        scales: { x: { time: true } },
        axes: [
          { stroke: text, grid: { stroke: line, width: 1 }, ticks: { stroke: line } },
          {
            stroke: text,
            grid: { stroke: line, width: 1 },
            ticks: { stroke: line },
            // Measured, not guessed. A fixed 58px fitted bare numbers and
            // stopped fitting the moment the labels carried units: "22.89M
            // pkt" and "0.06 Mbps" were clipped, and a clipped axis reads as a
            // different number rather than as a truncated one — which is worse
            // than no label at all.
            //
            // uPlot calls this per redraw with the values it is about to
            // draw, so the gutter follows the data instead of a guess about
            // it.
            size: (u, values) => {
              if (!values?.length) return 44;
              const ctx = u.ctx;
              ctx.save();
              ctx.font = u.axes[1].font?.[0] || '12px system-ui';
              const widest = Math.max(...values.map(v => ctx.measureText(String(v)).width));
              ctx.restore();
              // Ticks and a little breathing room; capped so one enormous
              // label cannot eat the chart it belongs to.
              return Math.min(120, Math.ceil(widest) + 14);
            },
            values: (_u, vals) => vals.map(v => formatValue(v, unit)),
          },
        ],
        series: [
          { label: 'time' },
          ...(series || []).map((name, i) => ({
            label: name,
            stroke: COLORS[i % COLORS.length],
            width: 1.5,
            // Points only when they are far enough apart to be read; at a
            // thousand samples they would be a solid band.
            points: { show: (u) => u.data[0].length < 120 },
            value: (_u, v) => (v == null ? '—' : formatValue(v, unit)),
          })),
        ],
      };

      chart.current = new uPlot(opts, data, host.current);
      // Inside the plotting area, so its coordinates are the cursor's.
      chart.current.over.appendChild(tip);

      ro = typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
          if (chart.current && host.current) {
            chart.current.setSize({ width: host.current.clientWidth || 600, height });
          }
        })
        : null;
      ro?.observe(host.current);
    })();

    return () => {
      cancelled = true;
      ro?.disconnect();
      chart.current?.destroy();
      chart.current = null;
    };
    // Deliberately NOT depending on `data`: a new instance per tick would
    // discard the operator's zoom and redraw everything from scratch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, Boolean(data)]);

  // New readings go in without rebuilding.
  useEffect(() => {
    if (chart.current && data) chart.current.setData(data);
  }, [data]);

  if (!data) {
    return <div className="hint" style={{ height, display: 'grid', placeItems: 'center' }}>{emptyText}</div>;
  }
  if (!canDraw()) {
    // A number is still worth more than an empty box.
    const last = points[points.length - 1];
    return (
      <div className="hint mono" style={{ height, display: 'grid', placeItems: 'center' }}>
        {(series || []).map((s, i) => `${s}: ${formatValue(last?.v?.[i], unit)}`).join('   ')}
      </div>
    );
  }
  return <div ref={host} style={{ width: '100%', height }} />;
}
