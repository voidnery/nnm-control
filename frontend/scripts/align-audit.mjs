import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Lift alignStreams out of the page so it runs without React.
const src = readFileSync(new URL('../src/pages/DashboardPage.jsx', import.meta.url),'utf8');
const from = src.indexOf('export function alignStreams');
const to = src.indexOf('\n}', src.indexOf('series: withData.map')) + 2;
const alignStreams = new Function(src.slice(from, to).replace('export function','function') + '; return alignStreams;')();

let pass=0, fail=0;
const check=(n,f)=>{try{f();console.log('  ✓ '+n);pass++}catch(e){console.log('  ✗ '+n+': '+e.message);fail++}};

const at = (secs, v) => ({ ts: new Date(1e12 + secs*1000).toISOString(), v: [v] });

check('series on different timelines are aligned onto their union', () => {
  const r = alignStreams([
    { label: 'a', points: [at(0, 10), at(20, 12)] },
    { label: 'b', points: [at(10, 5)] },
  ]);
  assert.deepEqual(r.series, ['a','b']);
  assert.equal(r.points.length, 3, 'three distinct timestamps');
  assert.deepEqual(r.points.map(p => p.v), [[10, null], [null, 5], [12, null]]);
});

check('a stream absent at a moment is null there, not zero', () => {
  // A stopped stream and a stream at zero bitrate are different events.
  const r = alignStreams([{ label:'a', points:[at(0,10), at(10,0)] }, { label:'b', points:[at(0,7)] }]);
  assert.equal(r.points[1].v[1], null, 'b was not reporting');
  assert.equal(r.points[1].v[0], 0, 'a genuinely read zero');
});

check('timestamps come out in order', () => {
  const r = alignStreams([{ label:'a', points:[at(30,1), at(0,2)] }, { label:'b', points:[at(10,3)] }]);
  const xs = r.points.map(p => Date.parse(p.ts));
  assert.deepEqual(xs, [...xs].sort((a,b)=>a-b));
});

check('streams with no points at all are dropped from the legend', () => {
  const r = alignStreams([{ label:'a', points:[at(0,1)] }, { label:'nodata', points:[] }]);
  assert.deepEqual(r.series, ['a'], 'a series with nothing to draw would be a legend entry with no line');
});

check('nothing to draw yields empty, not a chart of nulls', () => {
  assert.deepEqual(alignStreams([]), { points: [], series: [] });
  assert.deepEqual(alignStreams([{ label:'x', points:[] }]), { points: [], series: [] });
});
console.log(fail ? `\n${fail} failed` : '\nalign checks OK');
process.exit(fail?1:0);
