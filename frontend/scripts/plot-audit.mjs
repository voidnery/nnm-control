// The chart wrapper, checked where it can be checked without a canvas.
//
// The drawing itself is uPlot's problem. What is ours is the data handed to
// it, when the instance is rebuilt rather than re-fed, and that importing the
// library cannot take a page down in an environment without a canvas — which
// is not hypothetical: uPlot touches browser globals at module load, and a
// static import crashed the render harness before any component rendered.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toColumns, plotShape } from '../src/lib/plotData.js';

let pass = 0, fail = 0;
const check = (n, f) => {
  try { f(); console.log(`  ✓ ${n}`); pass++; }
  catch (e) { console.log(`  ✗ ${n}: ${e.message}`); fail++; }
};

console.log('DATA HANDED TO THE CHART:');

check('samples become columns, x in seconds', () => {
  const t0 = '2026-07-31T10:00:00.000Z';
  const t1 = '2026-07-31T10:00:10.000Z';
  const cols = toColumns([{ ts: t0, v: [1, 2] }, { ts: t1, v: [3, 4] }], 2);
  assert.equal(cols.length, 3, 'x plus one column per series');
  assert.deepEqual(cols[0], [Date.parse(t0) / 1000, Date.parse(t1) / 1000]);
  assert.deepEqual(cols[1], [1, 3]);
  assert.deepEqual(cols[2], [2, 4]);
  // Milliseconds would plot everything tens of thousands of years from now.
  assert.ok(cols[0][0] < 2e10, 'seconds, not milliseconds');
});

check('a missing reading is null, never zero', () => {
  // A gap drawn as zero is how a restarted server looks like an idle one, and
  // those call for opposite reactions.
  const cols = toColumns([{ ts: 0, v: [5] }, { ts: 1000, v: [] }, { ts: 2000, v: [7] }], 1);
  assert.deepEqual(cols[1], [5, null, 7]);
});

check('a non-numeric reading is a gap, not NaN', () => {
  const cols = toColumns([{ ts: 0, v: ['x'] }, { ts: 1000, v: [Infinity] }, { ts: 2000, v: [null] }], 1);
  assert.deepEqual(cols[1], [null, null, null], 'NaN and Infinity would break the y-scale');
});

check('zero is kept as zero', () => {
  const cols = toColumns([{ ts: 0, v: [0] }], 1);
  assert.deepEqual(cols[1], [0], 'a real zero reading must survive the gap handling');
});

check('nothing to draw yields nothing, not an empty chart', () => {
  assert.equal(toColumns([], 1), null);
  assert.equal(toColumns(null, 1), null);
  assert.equal(toColumns([{ ts: 0, v: [1] }], 0), null);
});

console.log('\nWHEN THE INSTANCE IS REBUILT:');

check('the same shape re-feeds; a changed one rebuilds', () => {
  // uPlot cannot add or remove a series after construction, so the series list
  // must force a rebuild — while new readings must not, or every tick would
  // discard the operator's zoom.
  assert.equal(plotShape(['a'], 'bps', 220), plotShape(['a'], 'bps', 220));
  assert.notEqual(plotShape(['a'], 'bps', 220), plotShape(['a', 'b'], 'bps', 220));
  assert.notEqual(plotShape(['a'], 'bps', 220), plotShape(['a'], 'pct', 220));
  assert.notEqual(plotShape(['a'], 'bps', 220), plotShape(['a'], 'bps', 150));
});

check('the shape is derived, not passed in', () => {
  const src = readFileSync(new URL('../src/components/Plot.jsx', import.meta.url), 'utf8');
  assert.ok(src.includes('plotShape(series, unit, height)'));
  // Narrowed to the component's own props: the first version of this check
  // matched the word "rebuild" in a comment, which is testing prose.
  const props = /export default function Plot\(\{([\s\S]*?)\}\)/.exec(src)?.[1] || '';
  assert.ok(!/rebuild|forceNew|key\b/.test(props),
    'a flag someone must remember to set would eventually not be set');
  assert.ok(props.includes('points') && props.includes('series'),
    'the shape follows from what is drawn');
});

console.log('\nIMPORTING IT CANNOT TAKE A PAGE DOWN:');

const src = readFileSync(new URL('../src/components/Plot.jsx', import.meta.url), 'utf8');

check('uPlot is loaded dynamically, behind the canvas check', () => {
  assert.ok(!/^import uPlot from 'uplot'/m.test(src), 'a static import runs its side effects everywhere');
  assert.ok(src.includes("import('uplot')"));
  const guard = src.indexOf('!canDraw()');
  const load = src.indexOf("import('uplot')");
  assert.ok(guard > 0 && guard < load, 'the guard must come first, or the import happens anyway');
});

check('without a canvas it renders a number rather than throwing', () => {
  assert.ok(src.includes('function canDraw'));
  assert.ok(src.includes('formatValue(last?.v?.[i], unit)'), 'the latest value beats an empty box');
});

check('the instance and the observer are both torn down', () => {
  assert.ok(src.includes('ro?.disconnect()'));
  assert.ok(src.includes('chart.current?.destroy()'));
  assert.ok(src.includes('cancelled = true'), 'a load in flight must not build into an unmounted host');
});

console.log(fail ? `\n${fail} failed` : `\nplot audit: OK`);
process.exit(fail ? 1 : 0);
