import { useMemo, useRef, useState } from 'react';

// Small multi-series line chart. Written by hand rather than pulling in a chart
// library: the panel needs one chart type, and a dependency would outweigh the
// whole page it lives on.
const COLORS = ['#3fb6a8', '#e0a83c', '#7aa7ff', '#e04545', '#9d7ae0', '#4fc36a'];

const niceStep = (span, target = 4) => {
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  return [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || mag * 10;
};

export function formatValue(v, unit) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (unit === 'bps') {
    if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + ' Gbps';
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + ' Mbps';
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + ' kbps';
    return v.toFixed(0) + ' bps';
  }
  if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return String(Math.round(v * 100) / 100);
}

export default function TimeChart({ points, series, unit = '', height = 240, emptyText = 'No data' }) {
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null);
  const W = 900, H = height, padL = 62, padR = 12, padT = 10, padB = 24;

  const model = useMemo(() => {
    if (!points?.length || !series?.length) return null;
    const xs = points.map(p => new Date(p.ts).getTime());
    const x0 = xs[0], x1 = xs[xs.length - 1] || x0 + 1;
    let lo = Infinity, hi = -Infinity;
    for (const p of points) {
      p.v.forEach(v => { if (typeof v === 'number') { if (v < lo) lo = v; if (v > hi) hi = v; } });
    }
    if (!Number.isFinite(lo)) return null;
    if (lo === hi) { hi = lo + 1; lo = Math.min(0, lo); }
    else lo = Math.min(lo, 0);                     // rates read better against zero
    const sx = (t) => padL + ((t - x0) / (x1 - x0 || 1)) * (W - padL - padR);
    const sy = (v) => H - padB - ((v - lo) / (hi - lo || 1)) * (H - padT - padB);
    const paths = series.map((_, si) => {
      let d = '', pen = false;
      points.forEach((p, i) => {
        const v = p.v[si];
        if (typeof v !== 'number') { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${sx(xs[i]).toFixed(1)},${sy(v).toFixed(1)}`;
        pen = true;
      });
      return d;
    });
    const step = niceStep(hi - lo);
    const ticks = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
    return { xs, x0, x1, lo, hi, sx, sy, paths, ticks };
  }, [points, series, H]);

  if (!model) return <div className="panel hint" style={{ height, display: 'grid', placeItems: 'center' }}>{emptyText}</div>;

  const onMove = (e) => {
    const rect = wrapRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0, bestD = Infinity;
    model.xs.forEach((t, i) => { const d = Math.abs(model.sx(t) - x); if (d < bestD) { bestD = d; best = i; } });
    setHover(best);
  };

  const hp = hover !== null ? points[hover] : null;

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}
         onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height }}>
        {model.ticks.map(v => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={model.sy(v)} y2={model.sy(v)} stroke="var(--line)" strokeWidth="1" />
            <text x={padL - 6} y={model.sy(v) + 4} textAnchor="end" fontSize="11" fill="var(--text-dim)">{formatValue(v, unit)}</text>
          </g>
        ))}
        <text x={padL} y={H - 6} fontSize="11" fill="var(--text-dim)">{new Date(model.x0).toLocaleTimeString()}</text>
        <text x={W - padR} y={H - 6} fontSize="11" textAnchor="end" fill="var(--text-dim)">{new Date(model.x1).toLocaleTimeString()}</text>
        {model.paths.map((d, i) => (
          <path key={i} d={d} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth="1.6" />
        ))}
        {hp && (
          <line x1={model.sx(new Date(hp.ts).getTime())} x2={model.sx(new Date(hp.ts).getTime())}
                y1={padT} y2={H - padB} stroke="var(--accent-dim)" strokeDasharray="3 3" />
        )}
      </svg>

      <div className="row" style={{ flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
        {series.map((s, i) => (
          <span key={s} className="hint" style={{ fontSize: 12 }}>
            <span style={{ display: 'inline-block', width: 10, height: 3, background: COLORS[i % COLORS.length], marginRight: 5, verticalAlign: 'middle' }} />
            {s}{hp ? `: ${formatValue(hp.v[i], unit)}` : ''}
          </span>
        ))}
        {hp && <span className="hint" style={{ marginLeft: 'auto', fontSize: 12 }}>{new Date(hp.ts).toLocaleString()}</span>}
      </div>
    </div>
  );
}
