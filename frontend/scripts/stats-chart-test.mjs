// The chart drew identifiers and raw cumulative totals on one axis, which made
// every real series flatten to zero. These checks pin the classification and the
// rate conversion that fixed it.
import { build } from 'esbuild';
import { rmSync } from 'fs';
const SRC = '/home/claude/nnm-control/frontend/src';
const out = '/tmp/.stats-bundle.mjs';
await build({ stdin: { contents: `export { classify, toRate } from '${SRC}/pages/StatsTab.jsx';`,
  resolveDir: SRC, loader: 'jsx' }, bundle: true, format: 'esm', outfile: out, jsx: 'automatic', logLevel: 'silent' });
const { classify, toRate } = await import(out);
rmSync(out, { force: true });

let bad = 0;
const check = (n, ok, d = '') => { if (ok) console.log(`  ✓ ${n}`); else { bad++; console.log(`  ✗ ${n} ${d}`); } };

console.log('COUNTER CLASSIFICATION:');
for (const m of ['owner', 'dest_port', 'server_id', 'port']) check(`${m} -> identifier (not charted)`, classify(m) === 'ident', classify(m));
for (const m of ['bytes_sent', 'bytes_recv', 'retry_count', 'pkt_loss', 'packets_total']) check(`${m} -> counter (rate)`, classify(m) === 'counter', classify(m));
for (const m of ['bandwidth', 'bitrate', 'session_duration', 'connected', 'msRTT']) check(`${m} -> gauge (as-is)`, classify(m) === 'gauge', classify(m));

console.log('\nRATE CONVERSION:');
const t0 = Date.now();
const pts = [0, 10, 20, 30].map((s, i) => ({ ts: new Date(t0 + s * 1000).toISOString(), v: [i * 5_000_000] }));
const rate = toRate(pts, 0);
check('totals become per-second rates', rate.length === 3 && rate.every(p => p.v[0] === 500_000), JSON.stringify(rate.map(p => p.v[0])));
const reset = [{ ts: new Date(t0).toISOString(), v: [900] }, { ts: new Date(t0 + 10000).toISOString(), v: [100] }];
check('counter reset yields a gap, not a negative cliff', toRate(reset, 0)[0].v[0] === null, JSON.stringify(toRate(reset, 0)));
const gappy = [{ ts: new Date(t0).toISOString(), v: [null] }, { ts: new Date(t0 + 10000).toISOString(), v: [50] }];
check('missing samples do not fabricate a value', toRate(gappy, 0)[0].v[0] === null);

console.log(bad ? `\n${bad} failure(s)` : '\nall chart-handling checks passed');
process.exit(bad ? 1 : 0);
