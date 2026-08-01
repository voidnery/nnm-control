// iter15 m1 — host metrics from the agent.
//
// Everything in /proc is cumulative, so every number here is a difference
// between two reads. The checks that matter are the ones about NOT producing a
// number: the first read, a reboot, an interface recreated. A graph that
// invents a spike is worse than one with a gap, because the spike gets
// investigated.
//
// The sampler is lifted out of the agent source and run for real, rather than
// reimplemented here — a copy would be testing the copy.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
};
const acheck = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
};

const agentSrc = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');

// Build the sampler against a fake /proc so the arithmetic can be driven.
function samplerWith(files) {
  const fakeFs = {
    readFile: async (p) => {
      if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[p];
    },
    readdir: async () => (files.__ifaces || []),
    access: async (p) => { if (!(files.__devices || []).some(d => p.includes(`/${d}/device`))) throw new Error('ENOENT'); },
  };
  const start = agentSrc.indexOf('let hostPrev = null;');
  const end = agentSrc.indexOf('async function hostLoop()');
  const body = agentSrc.slice(start, end).replace(/^export /gm, '');
  return new Function('fs', `${body}; return { sampleHost, physicalInterfaces };`)(fakeFs);
}

// Two calls in the same millisecond give a zero interval, and the sampler
// correctly refuses to divide by it. Real time has to pass between reads.
const tick = () => new Promise(r => setTimeout(r, 40));

const cpuLine = (u, n, s, i, io, st) => `cpu  ${u} ${n} ${s} ${i} ${io} 0 0 ${st} 0 0\nintr 1\n`;
const meminfo = (total, avail, free, swTotal, swFree) =>
  `MemTotal:       ${total} kB\nMemFree:        ${free} kB\nMemAvailable:   ${avail} kB\n` +
  `SwapTotal:      ${swTotal} kB\nSwapFree:       ${swFree} kB\n`;
const netdev = (rows) =>
  'Inter-|   Receive                    |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n' +
  rows.map(([n, rx, tx]) => `${n.padStart(7)}: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0`).join('\n') + '\n';

console.log('REFUSING TO INVENT A NUMBER:');

await acheck('the first read produces nothing — there is no rate without a prior point', async () => {
  const files = { '/proc/stat': cpuLine(100, 0, 50, 800, 10, 0), '/proc/meminfo': meminfo(1000, 800, 900, 0, 0),
                  '/proc/net/dev': netdev([['eth0', 1000, 2000]]), '/proc/uptime': '100.0 50.0' };
  const s = samplerWith(files);
  assert.equal(await s.sampleHost([]), null);
});

await acheck('a reboot between reads yields nothing, not a spike', async () => {
  const files = { '/proc/stat': cpuLine(100, 0, 50, 800, 10, 0), '/proc/meminfo': meminfo(1000, 800, 900, 0, 0),
                  '/proc/net/dev': netdev([['eth0', 900000, 900000]]), '/proc/uptime': '5000.0 100.0' };
  const s = samplerWith(files);
  await s.sampleHost([]);
  await tick();
  // Counters back to near-zero and uptime backwards: the box restarted.
  files['/proc/stat'] = cpuLine(5, 0, 2, 40, 0, 0);
  files['/proc/net/dev'] = netdev([['eth0', 100, 100]]);
  files['/proc/uptime'] = '12.0 3.0';
  assert.equal(await s.sampleHost([]), null,
    'differencing blindly here would draw a peak that never happened');
});

await acheck('an interface recreated between reads is skipped, not reported backwards', async () => {
  const files = { '/proc/stat': cpuLine(100, 0, 50, 800, 10, 0), '/proc/meminfo': meminfo(1000, 800, 900, 0, 0),
                  '/proc/net/dev': netdev([['eth0', 1_000_000, 2_000_000]]), '/proc/uptime': '1000.0 500.0' };
  const s = samplerWith(files);
  await s.sampleHost(['eth0']);
  await tick();
  files['/proc/stat'] = cpuLine(200, 0, 100, 1600, 20, 0);
  files['/proc/net/dev'] = netdev([['eth0', 500, 900]]);   // restarted at zero
  files['/proc/uptime'] = '1001.0 500.5';
  const out = await s.sampleHost(['eth0']);
  assert.ok(out, 'the rest of the sample is still good');
  assert.equal(out.metrics.net_eth0_rx_bps, undefined, 'no rate for that interface this round');
  assert.equal(out.metrics.net_rx_bps, 0, 'and it contributes nothing to the total');
});

console.log('\nARITHMETIC:');

await acheck('cpu busy excludes idle and iowait, and steal is its own series', async () => {
  // 1000 jiffies pass: 200 user, 100 system, 500 idle, 100 iowait, 100 steal.
  const files = { '/proc/stat': cpuLine(0, 0, 0, 0, 0, 0), '/proc/meminfo': meminfo(1000, 800, 900, 0, 0),
                  '/proc/net/dev': netdev([['eth0', 0, 0]]), '/proc/uptime': '1000.0 500.0' };
  const s = samplerWith(files);
  await s.sampleHost([]);
  await tick();
  files['/proc/stat'] = cpuLine(200, 0, 100, 500, 100, 100);
  files['/proc/uptime'] = '1001.0 500.5';
  const m = (await s.sampleHost([])).metrics;
  assert.equal(Math.round(m.cpu_pct), 40, 'busy = 1000 - idle 500 - iowait 100 = 400');
  assert.equal(Math.round(m.cpu_iowait_pct), 10);
  assert.equal(Math.round(m.cpu_steal_pct), 10, 'a shared VM is diagnosed by this number');
  assert.equal(Math.round(m.cpu_user_pct), 20);
});

await acheck('memory is measured by MemAvailable, not MemTotal minus MemFree', async () => {
  // A warm server: little free, but plenty available because most of it is
  // page cache. The naive formula would report 90% used.
  const files = { '/proc/stat': cpuLine(0, 0, 0, 0, 0, 0),
                  '/proc/meminfo': meminfo(8_000_000, 6_000_000, 800_000, 0, 0),
                  '/proc/net/dev': netdev([['eth0', 0, 0]]), '/proc/uptime': '1000.0 500.0' };
  const s = samplerWith(files);
  await s.sampleHost([]);
  await tick();
  files['/proc/stat'] = cpuLine(10, 0, 10, 980, 0, 0);
  files['/proc/uptime'] = '1001.0 500.5';
  const m = (await s.sampleHost([])).metrics;
  assert.equal(Math.round(m.mem_used_pct), 25, '8G total, 6G available');
  assert.notEqual(Math.round(m.mem_used_pct), 90, 'which is what MemFree would have said');
});

await acheck('swap on a box without any reads as zero, not as a division by zero', async () => {
  const files = { '/proc/stat': cpuLine(0, 0, 0, 0, 0, 0), '/proc/meminfo': meminfo(1000, 800, 900, 0, 0),
                  '/proc/net/dev': netdev([['eth0', 0, 0]]), '/proc/uptime': '1000.0 500.0' };
  const s = samplerWith(files);
  await s.sampleHost([]);
  await tick();
  files['/proc/stat'] = cpuLine(10, 0, 10, 980, 0, 0);
  files['/proc/uptime'] = '1001.0 500.5';
  const m = (await s.sampleHost([])).metrics;
  assert.equal(m.swap_used_pct, 0);
  assert.ok(Number.isFinite(m.swap_used_pct));
});

await acheck('network is reported in bits per second, per interface and in total', async () => {
  const files = { '/proc/stat': cpuLine(0, 0, 0, 0, 0, 0), '/proc/meminfo': meminfo(1000, 800, 900, 0, 0),
                  '/proc/net/dev': netdev([['eth0', 0, 0], ['eth1', 0, 0]]), '/proc/uptime': '1000.0 500.0' };
  const s = samplerWith(files);
  await s.sampleHost(['eth0', 'eth1']);
  await tick();
  files['/proc/stat'] = cpuLine(10, 0, 10, 980, 0, 0);
  // 1 MB in on eth0, 2 MB out on eth1, over whatever interval actually
  // elapsed — so the assertions are on relationships, which do not depend on
  // the clock, rather than on absolute rates, which do.
  files['/proc/net/dev'] = netdev([['eth0', 1_000_000, 0], ['eth1', 0, 2_000_000]]);
  files['/proc/uptime'] = '1001.0 500.5';
  const m = (await s.sampleHost(['eth0', 'eth1'])).metrics;
  assert.ok(m.net_eth0_rx_bps > 0 && m.net_eth1_tx_bps > 0);
  assert.equal(m.net_eth0_tx_bps, 0, 'eth0 sent nothing');
  assert.ok(Math.abs(m.net_eth1_tx_bps / m.net_eth0_rx_bps - 2) < 0.01, '2 MB against 1 MB');
  assert.ok(Math.abs(m.net_rx_bps - m.net_eth0_rx_bps) < 1, 'the total sums the chosen interfaces');
  assert.ok(Math.abs(m.net_tx_bps - m.net_eth1_tx_bps) < 1);
  // Bits, not bytes. rx_bps = bytes/secs * 8, so the interval it implies is
  // 8 * bytes / rx_bps — and that must land near the delay the test waited.
  const impliedSecs = (8 * 1_000_000) / m.net_eth0_rx_bps;
  assert.ok(impliedSecs > 0.02 && impliedSecs < 1,
    `implied interval ${impliedSecs.toFixed(3)}s — if the unit were bytes this would be eight times larger`);
});

console.log('\nWHICH INTERFACES:');

await acheck('only real NICs are offered — bridges and veth pairs would double-count', async () => {
  const s = samplerWith({ __ifaces: ['lo', 'eth0', 'eth1', 'docker0', 'veth1a2b', 'br-abc'], __devices: ['eth0', 'eth1'] });
  assert.deepEqual(await s.physicalInterfaces(), ['eth0', 'eth1']);
});

check('the panel decides which, and carries it on the poll response', () => {
  const gw = readFileSync(new URL('../src/routes/agentGateway.js', import.meta.url), 'utf8');
  assert.ok(gw.includes('interfaces: Array.isArray(server.agent?.interfaces)'),
    'per server, because the machines differ');
  assert.ok(agentSrc.includes('if (config?.host) hostCfg'), 'and there is nothing to configure on the box');
});

console.log('\nSTORAGE:');

check('host samples reuse the existing time series, under their own group', () => {
  const gw = readFileSync(new URL('../src/routes/agentGateway.js', import.meta.url), 'utf8');
  assert.ok(gw.includes("group: 'host'"));
  assert.ok(gw.includes('StatSample.create'), 'one store, so one query serves host and stream charts alike');
});

check('a sample is filtered before it is written', () => {
  // Written unattended and read as a graph: a non-numeric value becomes a line
  // that cannot be plotted, and an odd key one that cannot be queried.
  const gw = readFileSync(new URL('../src/routes/agentGateway.js', import.meta.url), 'utf8');
  assert.ok(gw.includes('/^[a-z0-9_]{1,64}$/i'));
  assert.ok(gw.includes('Number.isFinite(n)'));
});

console.log('\nFLEET SERIES (iter15 m3):');

const statsSrc = readFileSync(new URL('../src/routes/stats.js', import.meta.url), 'utf8');
const dashSrc = readFileSync(new URL('../../frontend/src/pages/DashboardPage.jsx', import.meta.url), 'utf8');

check('one request serves the whole fleet', () => {
  // Thirteen servers asking for themselves is thirteen round trips and a page
  // that paints in thirteen jerks.
  assert.ok(statsSrc.includes("statsRouter.get('/host'"));
  assert.ok(dashSrc.includes('/stats/host?minutes='));
  // Two call sites since m4 — host and streams — and that is the point: two
  // requests for the whole page, not two per card.
  assert.equal((dashSrc.match(/api\(`\/stats\//g) || []).length, 2);
  assert.ok(!/servers\.map[\s\S]{0,200}api\(/.test(dashSrc), 'nothing fetches per card');
});

check('both series endpoints thin the data the same way', () => {
  // Two implementations of the same averaging would eventually draw two
  // different pictures of the same minute.
  assert.ok(statsSrc.includes('async function seriesFor'));
  assert.equal((statsSrc.match(/\$group: group/g) || []).length, 1, 'bucketing exists once');
});

check('a card is given fewer points than a full-width chart', () => {
  assert.ok(statsSrc.includes('targetPoints: 240'),
    'six hundred points in three hundred pixels is work nobody can see');
});

check('a server without an agent is told apart from one that is silent', () => {
  // An empty chart looks like an outage; "no agent" is not an outage.
  assert.ok(statsSrc.includes('const enabled = Boolean(s.agent?.enabled)'));
  assert.ok(dashSrc.includes("t('db.noAgent')") && dashSrc.includes("t('db.silent'"));
  assert.ok(dashSrc.includes("t('db.noSamples')"), 'and from one that has simply not sent anything yet');
});

check('the card is still the way to the server', () => {
  // The list it replaced was also the navigation.
  assert.ok(dashSrc.includes('<Link to={`/servers/${s.id}`}'));
});

check('steal and iowait are drawn, not folded into the CPU number', () => {
  assert.ok(dashSrc.includes("'cpu_pct', 'cpu_steal_pct', 'cpu_iowait_pct'"));
});

check('any swap in use is coloured', () => {
  // On a streaming box swap in use means the machine has already run out once.
  assert.ok(/swap_used_pct\] > 5/.test(dashSrc));
});

console.log('\nSTREAMS ON THE DASHBOARD (iter15 m4):');

check('the rate metric is discovered, never assumed', () => {
  // flattenNumbers stores whatever numeric fields Nimble reported, and those
  // differ between builds — which is why StatSample keeps a free-form map. A
  // hardcoded metric name would work on one fleet and silently plot nothing
  // on another.
  assert.ok(statsSrc.includes('function pickRateMetric'));
  assert.ok(statsSrc.includes('const RATE_RE = /bandwidth|bitrate|bps/i'),
    'the same pattern the graphs tab already uses');
  assert.ok(statsSrc.includes('$objectToArray'), 'the field names come from the samples themselves');
});

check('the plainest field name wins', () => {
  const pick = (keys) => {
    const rate = keys.filter(k => /bandwidth|bitrate|bps/i.test(k));
    return rate.length ? rate.sort((a, b) => a.length - b.length || a.localeCompare(b))[0] : '';
  };
  assert.equal(pick(['stats.output.bandwidth_avg', 'bandwidth', 'packets']), 'bandwidth');
  assert.equal(pick(['packets', 'errors']), '', 'and a subject with no rate field reports none');
});

check('a stream with no rate field is reported, not dropped', () => {
  // It still exists; it just cannot be plotted, and hiding it would be a lie
  // by omission.
  assert.ok(dashSrc.includes("t('db.streamsNoMetric'"));
});

check('the busiest streams are the ones given the space', () => {
  assert.ok(statsSrc.includes('all.sort((a, b) => (b.latest ?? -1) - (a.latest ?? -1))'));
  assert.ok(statsSrc.includes('const perServer'), 'a box with two hundred streams must not draw two hundred charts');
});

check('one chart per card, streams as series', () => {
  // Six charts per card would be seventy-eight more uPlot instances on a page
  // already carrying thirty-nine — and separate axes make the comparison an
  // operator actually wants impossible.
  assert.ok(dashSrc.includes('export function alignStreams'));
  assert.equal((dashSrc.match(/<Plot /g) || []).length, 2, 'the host ChartRow and the streams chart');
});

check('the dashboard makes two requests, not two per card', () => {
  assert.ok(dashSrc.includes('/stats/streams?minutes='));
  assert.ok(dashSrc.includes('Promise.all(['));
});

check('a stream section failing does not take the host charts with it', () => {
  // Streams are the newer, less certain half; the host charts must survive it.
  assert.ok(/api\(`\/stats\/streams[^`]*`\)\.catch\(\(\) => null\)/.test(dashSrc));
});

console.log('\nDASHBOARD SETTINGS (iter15 m5):');

const authSrc = readFileSync(new URL('../src/routes/auth.js', import.meta.url), 'utf8');

check('settings live on the account, not on the panel', () => {
  // One person watches the network on a wall display while another chases a
  // memory leak; they should not be fighting over one screen.
  assert.ok(authSrc.includes('if (dashboard !== undefined'));
  assert.ok(dashSrc.includes("api('/auth/me/preferences'"));
  assert.ok(!dashSrc.includes("rememberFilters('dashboard'"), 'and they survive a reload');
});

check('every value is validated by allow-list', () => {
  // These drive queries: a range of "999999" would be a way to ask the
  // database for everything it has.
  for (const frag of ["['15m', '1h', '6h', '24h'].includes(dashboard.range)",
                      "['1', '2', '3'].includes(String(dashboard.columns))",
                      "[0, 10, 15, 30, 60, 300].includes(n)",
                      "[3, 6, 12, 24].includes(n)"]) {
    assert.ok(authSrc.includes(frag), frag);
  }
});

check('an unknown chart name is dropped rather than stored', () => {
  assert.ok(authSrc.includes("const CHARTS = ['cpu', 'mem', 'net', 'streams']"));
  assert.ok(authSrc.includes('CHARTS.filter(c => dashboard.charts.includes(c))'));
});

check('manual refresh means no timer, not a default someone did not choose', () => {
  assert.ok(dashSrc.includes('if (cfg.refreshSec > 0) timer.current = setInterval'));
});

check('the defaults show everything', () => {
  // A dashboard whose defaults hide things is one where a fault is missed by
  // whoever never opened the settings.
  assert.ok(dashSrc.includes('const DEFAULTS = { charts: ALL_CHARTS'));
  assert.ok(/range: '1h'/.test(dashSrc) && /refreshSec: 15/.test(dashSrc));
});

check('the chart order is canonical, not the order boxes were ticked', () => {
  assert.ok(dashSrc.includes('ALL_CHARTS.filter(x => next.includes(x))'));
});

console.log('\nTHE TOOLBAR (v0.22.8):');

const selectSrc = readFileSync(new URL('../../frontend/src/components/Select.jsx', import.meta.url), 'utf8');

check('a choice applies before the server confirms it', () => {
  // The range is reached for constantly. Waiting on a PUT and then a GET made
  // the dropdown look unresponsive, and did nothing at all if either failed.
  assert.ok(dashSrc.includes('const [pending, setPending]'));
  assert.ok(dashSrc.includes('setPending(optimistic)'));
  assert.ok(/const cfg = useMemo\(\(\) => \(\{ \.\.\.saved, \.\.\.\(pending \|\| \{\}\) \}\)/.test(dashSrc));
});

check('a failed save reverts rather than leaving the two disagreeing', () => {
  const from = dashSrc.indexOf('const patch = useCallback');
  const body = dashSrc.slice(from, from + 700);
  assert.ok(body.includes('setPending(null);\n      setError(e.message)'), 'the optimistic value is dropped on failure');
  const clear = body.indexOf('setPending(null);\n      setError(\'\')');
  const refresh = body.indexOf('await refreshUser()');
  assert.ok(refresh > 0 && refresh < clear, 'and only cleared once the account agrees');
});

check('the optimistic state is declared before it is read', () => {
  // It was not, and the page threw "Cannot access 'pending' before
  // initialization" — caught by the click gate rather than by a browser.
  assert.ok(dashSrc.indexOf('const [pending, setPending]') < dashSrc.indexOf('...(pending || {})'));
});

check('Select forwards the width its caller gives it', () => {
  // It did not, so every Select took its natural width, the toolbar row
  // overflowed and wrapped, and each label ended up above its own control.
  assert.ok(/style,\s*className = ''/.test(selectSrc) || selectSrc.includes('className = \'\''));
  assert.ok(selectSrc.includes('style={style}'));
});

check('a label and its control cannot wrap apart', () => {
  assert.ok(dashSrc.includes("flexWrap: 'nowrap'"));
  const css = readFileSync(new URL('../../frontend/src/styles.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.row .row.pair'), 'and there is a house rule for the next one');
});

console.log('\nWMSPANEL BUDGET READOUT:');

const clientSrc = readFileSync(new URL('../src/services/wmspanelClient.js', import.meta.url), 'utf8');

check('a call is counted before it is attempted', () => {
  // Counting successes would under-report exactly when something is failing
  // and being retried — and a failed call has still left the account.
  const from = clientSrc.indexOf('countCall(path);');
  const fetchAt = clientSrc.indexOf('await fetch(');
  assert.ok(from > 0 && from < fetchAt);
});

check('counting does not itself cost a write per call', () => {
  // Solving a budget problem by spending a different budget.
  assert.ok(clientSrc.includes('const pending ='));
  assert.ok(clientSrc.includes('setTimeout'), 'accumulated and flushed on a timer');
  assert.ok(clientSrc.includes('$inc'), 'and merged atomically when it lands');
});

check('the count survives a restart', () => {
  // In memory only, a restart at midday would report a fraction of what had
  // really been spent — the number most worth trusting and least able to be.
  assert.ok(clientSrc.includes('ApiUsage.updateOne'));
  assert.ok(clientSrc.includes('upsert: true'));
});

check('ids are collapsed so paths group instead of fragmenting', () => {
  const key = (p) => String(p).split('?')[0].replace(/\/[0-9a-f]{16,}/gi, '/:id');
  assert.equal(key('/server/6a172131c7e706df9da4f1e0/rtmp/republish'), '/server/:id/rtmp/republish');
  assert.equal(key('/server/6a172131c7e706df9da4f1e0/mpegts/outgoing?x=1'), '/server/:id/mpegts/outgoing');
});

check('the projection answers "will I run out", and stays quiet when it cannot', () => {
  const project = (used, hUTC) => {
    const now = new Date(Date.UTC(2026, 6, 31, hUTC, 0, 0));
    const end = Date.UTC(2026, 6, 32);
    const elapsed = 24 - (end - now.getTime()) / 3_600_000;
    return elapsed > 0.25 ? Math.round((used / elapsed) * 24) : null;
  };
  assert.equal(project(3000, 12), 6000, 'half a day at 3000 lands at 6000');
  assert.equal(project(3000, 0), null, 'and it says nothing in the first minutes, where a rate means nothing');
});

check('the number is presented as a floor, not a balance', () => {
  // WMSPanel reports no remaining quota and the account is shared, so anything
  // else spending it is invisible here. Said in the payload and on screen.
  assert.ok(statsSrc.includes("note: 'panel-only'"));
  assert.ok(dashSrc.includes("t('db.quotaPanelOnly')"));
});

check('the readout can be switched off, and then returns nothing to render', () => {
  // Off means off: the dashboard is handed nothing rather than a number it
  // then has to decide to ignore.
  assert.ok(statsSrc.includes("if (settings.apiQuota?.enabled === false) return res.json({ enabled: false })"));
  assert.ok(dashSrc.includes("q.enabled !== false ? q : null"));
});

check('the daily limit is the operator\'s to set', () => {
  // It is a property of the account's plan, and the person who knows it cannot
  // edit the container's environment.
  const settingsSrc = readFileSync(new URL('../src/routes/settings.js', import.meta.url), 'utf8');
  assert.ok(settingsSrc.includes('s.apiQuota.dailyLimit = Math.round(n)'));
  assert.ok(settingsSrc.includes('n < 100 || n > 10_000_000'),
    'zero would make every reading over budget; unbounded would make it meaningless');
  assert.ok(statsSrc.includes('Number(settings.apiQuota?.dailyLimit) || DAILY_LIMIT'),
    'and the environment variable stays as the fallback');
});

check('the readout cannot break the page it sits on', () => {
  assert.ok(/api\('\/stats\/api-quota'\)\.catch\(\(\) => null\)/.test(dashSrc));
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : '\nall host-metric checks passed');
process.exit(fail ? 1 : 0);
