// Two views of one edge, iter24 m1.
//
// Everything the panel knew about an edge came from outside it. That answers
// "can a viewer get this" and stops — Nimble, the machine's firewall, the route
// between and the panel's own network all look identical from here, and they
// are four different repairs.
//
// These checks are about what the pair means, not about whether a fetch works.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reconcile, cacheFromInside } from '../src/services/insideOutside.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

const inside = (status, moving = true) => ({ first: { status }, moving });

console.log('\nWHAT THE TWO VIEWS MEAN TOGETHER:');

check('serving and reachable is the only "ok"', () => {
  assert.equal(reconcile({ inside: inside(200), outside: { ok: true } }).verdict, 'ok');
});

check('a playlist that does not advance is not "ok"', () => {
  // 200 on a frozen playlist is the most convincing wrong answer this check
  // could give: the file exists, the request succeeds, the stream is dead.
  // Only the inside view watched it long enough to know.
  assert.equal(reconcile({ inside: inside(200, false), outside: { ok: true } }).verdict, 'stale');
});

check('serving but unreachable is named as a path problem', () => {
  // Nimble is fine. A firewall, a route or the wrong address is not, and
  // sending somebody to look at Nimble would waste the afternoon.
  const r = reconcile({ inside: inside(200), outside: { ok: false } });
  assert.equal(r.verdict, 'unreachable');
  assert.match(r.why, /firewall|route|address/);
});

check('not serving anywhere says which end it asked', () => {
  const r = reconcile({ inside: { first: { status: 404 } }, outside: { ok: false } });
  assert.equal(r.verdict, 'not-served');
  assert.match(r.why, /404/);
});

check('a combination that cannot happen is reported as such', () => {
  // The panel served and the machine not, for one stream, means the two checks
  // are asking different questions. Calling that a verdict about the machine
  // would be worse than saying nothing.
  const r = reconcile({ inside: { first: { status: 404 } }, outside: { ok: true } });
  assert.equal(r.verdict, 'contradictory');
  assert.match(r.why, /cannot both be true/);
});

check('no agent is a fact about the fleet, not a failure', () => {
  const r = reconcile({ inside: null, outside: { ok: true } });
  assert.equal(r.verdict, 'outside-only');
  assert.equal(r.servedInside, null);
});

console.log('\nCACHE, MEASURED WHERE IT CAN BE:');

check('amplification is the figure, because Nimble has no hit counters', () => {
  // Confirmed against a live fleet: RamCacheSize, FileCacheSize and their
  // maxima, and nothing that counts a hit or a miss. Bytes out over bytes in
  // is the only effectiveness measure available.
  const c = cacheFromInside({ OutBytes: 1000, InBytes: 100, RamCacheSize: 100, MaxRamCacheSize: 500 });
  assert.equal(c.measured, true);
  assert.equal(c.amplification, 10);
  assert.equal(c.caching, true);
});

check('an idle edge is not measured and not called broken', () => {
  // A pull cache with no viewers pulls nothing. That is health, and reporting
  // it as a cache failure is the conflation this whole file exists to avoid.
  const c = cacheFromInside({ OutBytes: 0, InBytes: 0, RamCacheSize: 0, MaxRamCacheSize: 500 });
  assert.equal(c.measured, false);
  assert.match(c.why, /idle edge is normal/);
});

check('an edge serving about what it pulls is not caching', () => {
  const c = cacheFromInside({ OutBytes: 105, InBytes: 100, RamCacheSize: 10, MaxRamCacheSize: 500 });
  assert.equal(c.measured, true);
  assert.equal(c.caching, false);
});

check('occupancy survives when traffic cannot be measured', () => {
  // How full the cache is comes from different fields than how well it works,
  // and losing both because one is absent would throw away a real reading.
  const c = cacheFromInside({ RamCacheSize: 200, MaxRamCacheSize: 500 });
  assert.equal(c.measured, false);
  assert.equal(c.occupancy.percent, 40);
});

check('nothing at all is refused rather than reported as zero', () => {
  assert.equal(cacheFromInside(null).measured, false);
  assert.equal(cacheFromInside({}).occupancy, null);
});

console.log('\nTHE INSIDE VIEW IS ASKED PROPERLY:');

const agent = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');
const probe = readFileSync(new URL('../src/services/channelProbe.js', import.meta.url), 'utf8');

check('the agent reads the playlist twice before calling it live', () => {
  // One fetch cannot tell a live stream from a file left behind by a dead one.
  const body = agent.slice(agent.indexOf("'POST /nimble/delivery'"), agent.indexOf("'POST /nimble/delivery'") + 4000);
  assert.ok(/out\.second = await read\(\)/.test(body), 'it reads once and calls it served');
  assert.ok(/EXT-X-MEDIA-SEQUENCE/.test(body), 'it compares something other than the media sequence');
});

check('it asks Nimble over loopback, which is the whole point', () => {
  const body = agent.slice(agent.indexOf("'POST /nimble/delivery'"), agent.indexOf("'POST /nimble/delivery'") + 4000);
  assert.ok(/127\.0\.0\.1/.test(body), 'it dials the machine by its public address');
});

check('the probe only asks agents that can answer', () => {
  // The route arrived in v29. Asking an older agent produces a task it will
  // never claim and a timeout that reads as a broken edge.
  assert.ok(/version \?\? 0\) >= 29/.test(probe), 'it asks agents that have no such route');
  assert.ok(/agentIsLive\(srv\)/.test(probe), 'it asks machines that are not answering');
});

check('a failed inside check does not fail the outside one', () => {
  // The panel's own reading is what it has always had, and losing it because
  // an agent stumbled would be a step backwards.
  assert.ok(/\.catch\(e => \(\{ first: \{ status: null/.test(probe),
    'an agent error throws out of the whole probe');
});

console.log('\nRECONNAISSANCE SCRIPTS FOLLOW THEIR OWN RULES:');

// Applied to every script in tools/, not to the one being written at the time.
// Both of these have already failed on their first run, for different reasons,
// and each rule below is one of those reasons.
const { readdirSync } = await import('node:fs');
const toolDir = new URL('../tools/', import.meta.url);
// Only the ones meant to leave this machine.
//
// `join-report.mjs` and `pipeline-check.mjs` are run inside the API container
// on purpose, where the database and the credentials already are — they may
// import what they like and read what they like. The rules here are about
// scripts copied somewhere else, and applying them to a tool that says it
// belongs in the container would be a check firing on correct code.
//
// Read from the file's own statement of where it runs, not from a list of
// names: a new script declares its own kind, and a list is a thing to forget
// to update.
const tools = readdirSync(toolDir).filter((f) => {
  if (!f.endsWith('.mjs')) return false;
  const head = readFileSync(new URL(f, toolDir), 'utf8').slice(0, 2000);
  // The explicit declaration wins. `wms-recon.mjs` says STANDALONE at the top
  // and mentions the container further down, while explaining why it no longer
  // reads from it — and "mentions a word" lost to "declares its kind", which
  // is the wrong way round.
  if (/\bSTANDALONE\b/.test(head)) return true;
  if (/Run inside the (API )?container/i.test(head)) return false;
  return /copied to a machine|runs anywhere/i.test(head);
});
assert.ok(tools.length >= 2, `only ${tools.length} standalone tools found; this check has lost its subject`);

for (const name of tools) {
  const raw = readFileSync(new URL(name, toolDir), 'utf8');
  const src = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  check(`${name}: imports nothing that has to be installed`, () => {
    // The first version imported mongoose and the panel's models to read
    // credentials from the database. Those exist together only inside the
    // container, which is not where anybody runs a one-off script — it died
    // on its import line.
    for (const m of src.matchAll(/^import .*? from '([^']+)'/gm)) {
      assert.ok(m[1].startsWith('node:'),
        `imports ${m[1]}, so it only runs where that resolves`);
    }
  });

  check(`${name}: takes its inputs on the command line`, () => {
    assert.ok(/process\.argv/.test(src), 'it finds its inputs somewhere else');
  });

  check(`${name}: writes its report beside itself`, () => {
    // Not to a path derived from the current directory, and not to stdout
    // alone: an earlier instruction sent output to `../docs/`, which exists in
    // a clone and nowhere else, and the shell answered "No such file or
    // directory".
    assert.ok(/fileURLToPath\(import\.meta\.url\)/.test(src), 'it does not know where it is');
    assert.ok(/writeFileSync/.test(src), 'it writes no file');
    assert.ok(!/process\.cwd\(\)/.test(src), 'it writes relative to wherever it was run from');
  });

  check(`${name}: keeps its report when the run fails`, () => {
    // `process.exit` before the write skipped the report entirely, so a run
    // that failed at the first request left nothing behind — not even the
    // record of why.
    // Inside the catch, not merely somewhere in the file. Declaring the
    // function and calling it only on success passes a check that greps —
    // which is exactly what the first version of this did.
    const tail = src.slice(src.lastIndexOf('.catch('));
    assert.ok(/writeReport\(\)/.test(tail),
      'a failed run loses everything it had learned');
    const beforeMain = src.slice(0, src.indexOf('main()'));
    assert.ok(!/process\.exit\(1\)/.test(beforeMain.slice(beforeMain.indexOf('async function main'))),
      'an early exit skips the report');
  });

  check(`${name}: never sends DELETE`, () => {
    // There is no body that makes a DELETE harmless. Against a real id it
    // either fails or removes somebody's group, rule or recording — and a
    // reconnaissance script that deletes things is one nobody may run.
    // Discovering that a family accepts DELETE is what the vendor's
    // documentation is for.
    const sends = [...src.matchAll(/(?:method|ask\([^,]+,)\s*['"]DELETE['"]/g)];
    assert.equal(sends.length, 0, 'the script can send DELETE');
  });

  check(`${name}: cannot write to the API by accident`, () => {
    // Read-only unless a flag is typed. This check used to name
    // `--probe-writes` literally, which made it a check on one script rather
    // than on the rule, and it fired on the first new tool that spelled its
    // flag differently. The rule is: a constant derived from the command line
    // decides, and something branches on it.
    const sendsWrites = /'(POST|PUT|DELETE|PATCH)'/.test(src);
    if (!sendsWrites) return;

    const flag = src.match(/const ([A-Z_]+) = (?:args|argv|process\.argv[^\n]*)\.includes\('(--[a-z-]+)'\)/);
    assert.ok(flag, 'no write flag is read from the command line');
    const [, name_, spelling] = flag;
    // The flag must decide, not merely exist. `const WRITE = true` would leave
    // the string in the file and send writes unasked.
    assert.ok(new RegExp(`(?:if \\(!?${name_}\\b|${name_}\\s*\\?)`).test(src),
      `nothing branches on ${name_}`);
    assert.ok(new RegExp(`${spelling}`).test(src.slice(src.indexOf('usage'))) ||
              new RegExp(`${spelling}`).test(src),
      `${spelling} is never mentioned where somebody would read about it`);

    // And the payload must be one that cannot quietly do something. Two
    // shapes qualify: a body designed to be rejected, or a guard naming the
    // one object the script may touch. `PUT {}` returned 200 here once, which
    // means it executed — safe only because every field is optional, and a
    // safety argument that depends on luck is not one.
    const throwaway = /body: [^\n]*'\{\}'/.test(src);
    const guarded = /GUARD_NAME/.test(src);
    assert.ok(throwaway || guarded,
      'it writes a real body to an object it has not been restricted to');
  });

  check(`${name}: its paths cite where they came from`, () => {
    // The first WMSPanel inventory was invented. It tried `/settings` and
    // never `/global` — the spelling Softvelum's own RTSP article uses — so an
    // entire family read as absent because of a word. A list nobody can check
    // is a list that will be wrong again.
    const at = raw.search(/const (ROUTES|PROBES) = \[/);
    if (at < 0) return;
    // In the comment block immediately above the list, not anywhere in the
    // file: a URL in the usage text says nothing about where the paths came
    // from, and the first version of this passed on exactly that.
    const preamble = raw.slice(Math.max(0, at - 2000), at);
    assert.ok(/wmspanel\.com|softvelum\.com|blog\.wmspanel/.test(preamble),
      'nothing next to the route list says where the paths came from');
  });

  check(`${name}: carries a control probe`, () => {
    // Without one, a blanket failure is indistinguishable from a missing
    // feature — a mistake made here more than once.
    assert.ok(/control probe|control/i.test(raw), 'a total failure would read as an absent feature');
  });
}


console.log(failures ? `\n${failures} inside/outside check(s) failed` : '\nall inside/outside checks passed');
process.exit(failures ? 1 : 0);
