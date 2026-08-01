// Turning the panel's samples into the columnar form uPlot wants.
//
// Kept out of the component so it can be tested without a canvas: the one
// decision in here is worth checking, and it is not about drawing.
//
//   points: [{ ts, v: [n, ...] }]  ->  [xs, series0, series1, ...]
//
// x is in SECONDS, which is what uPlot's time scale expects; passing
// milliseconds silently plots everything in the year 56000 or thereabouts.
export function toColumns(points, seriesCount) {
  if (!points?.length || !seriesCount) return null;
  const xs = new Array(points.length);
  const cols = Array.from({ length: seriesCount }, () => new Array(points.length));
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    xs[i] = new Date(p.ts).getTime() / 1000;
    for (let s = 0; s < seriesCount; s++) {
      const v = p.v?.[s];
      // A missing reading is null, never 0. A gap drawn as zero is how a
      // server that was restarted looks like a server that went idle — and
      // those call for opposite reactions.
      cols[s][i] = Number.isFinite(v) ? v : null;
    }
  }
  return [xs, ...cols];
}

// What must force uPlot to be rebuilt rather than re-fed. It cannot add or
// remove a series after construction, so the shape is derived from the things
// that change it — never signalled by a flag someone has to remember to set.
export function plotShape(series, unit, height) {
  return `${(series || []).join('|')}|${unit || ''}|${height || 0}`;
}
