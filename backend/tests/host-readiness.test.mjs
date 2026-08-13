// What a machine needs for the job it has, iter23 m1.
//
// The panel is about to start installing software and opening public ports —
// a class of action it has never taken. Everything written so far went into
// somebody else's API, where a wrong call is refused. A wrong apt-get is not
// refused; it happens.
//
// So finding out is separated from doing, and these checks are entirely about
// the finding out: what each purpose actually requires, and the difference
// between a machine that lacks something and one nobody has asked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readiness, requirementsFor, purposeChangeWarnings, PURPOSES, PREPARE_MIN_AGENT }
  from '../src/services/hostReadiness.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

console.log('\nA PURPOSE DECIDES WHAT IS ASKED:');

check('a gateway is not asked whether Nimble is running', () => {
  // There is no media server on it. Half of what the panel checks about a
  // server is meaningless there, and reporting a gateway as a broken Nimble
  // host is how a correct machine looks broken.
  const ids = requirementsFor('gateway').map(r => r.id);
  assert.ok(!ids.includes('nimble-running'));
});

check('a media server is not asked for nginx', () => {
  // Nginx on a Nimble box holding port 80 is a conflict, not a feature.
  assert.ok(!requirementsFor('nimble').map(r => r.id).includes('nginx-installed'));
});

check('ports are checked before anything is proposed for a gateway', () => {
  // Installing nginx where something already holds 80 produces a broken
  // service rather than an error, and finding that out afterwards means
  // having broken somebody else's machine.
  assert.equal(requirementsFor('gateway')[0].id, 'ports-free');
});

check('every requirement says what it is for', () => {
  // A checklist without reasons is a checklist somebody overrides.
  for (const p of PURPOSES) {
    for (const r of requirementsFor(p)) assert.ok(r.why, `${p}/${r.id} has no reason`);
  }
});

console.log('\nNOT ASKED IS NOT MISSING:');

check('a machine nobody has asked is "not checked"', () => {
  const r = readiness({ purpose: 'gateway' });
  assert.equal(r.ready, false);
  assert.equal(r.code, 'not-checked');
  assert.ok(r.items.every(i => i.state === 'unknown'));
});

check('an agent too old to be asked says so, and names the version', () => {
  // Otherwise the panel reports a machine as unready because it could not ask,
  // and somebody goes looking for a fault on a machine that has none.
  const r = readiness({ purpose: 'gateway', agentVersion: 20 });
  assert.equal(r.code, 'agent-too-old');
  assert.equal(r.need, PREPARE_MIN_AGENT);
  assert.equal(r.have, 20);
});

check('a value the agent could not determine stays unknown', () => {
  // `ss` not installed must not read as "the port is free" — that is the
  // difference between proposing an install and breaking a service.
  const r = readiness({ purpose: 'gateway', report: {
    'ports-free': null, 'nginx-installed': true, 'tls-cert': true, resolver: true,
  } });
  assert.equal(r.code, 'partly-unknown');
  assert.deepEqual(r.unknown, ['ports-free']);
  assert.equal(r.ready, false, 'unknown is not ready');
});

check('missing and unknown are reported apart', () => {
  const r = readiness({ purpose: 'gateway', report: {
    'ports-free': true, 'nginx-installed': false, 'tls-cert': null, resolver: false,
  } });
  assert.deepEqual(r.missing.sort(), ['nginx-installed', 'resolver']);
  assert.deepEqual(r.unknown, ['tls-cert']);
});

check('everything present is ready', () => {
  const r = readiness({ purpose: 'gateway', report: {
    'ports-free': true, 'nginx-installed': true, 'tls-cert': true, resolver: true,
  } });
  assert.equal(r.ready, true);
  assert.equal(r.code, 'ready');
});

console.log('\nCHANGING WHAT A MACHINE IS FOR:');

check('turning a running media server into a gateway is blocked', () => {
  // Something is serving video on it. That is not a field edit.
  const w = purposeChangeWarnings('nimble', 'gateway', { nimbleRunning: true });
  assert.equal(w.find(x => x.code === 'nimble-still-running')?.severity, 'block');
});

check('the same change on a stopped server is allowed', () => {
  assert.deepEqual(purposeChangeWarnings('nimble', 'gateway', { nimbleRunning: false }), []);
});

check('leaving a network warns rather than refuses', () => {
  // The routes stay where they are; the panel simply stops managing them.
  assert.equal(purposeChangeWarnings('nimble-cdn', 'nimble')[0]?.severity, 'warn');
});

check('no change produces no warnings', () => {
  assert.deepEqual(purposeChangeWarnings('gateway', 'gateway'), []);
});

console.log('\nTHE AGENT ONLY LOOKS:');

const agent = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');
const handler = agent.slice(agent.indexOf("'GET /host/readiness'"), agent.indexOf("'GET /host/readiness'") + 2600);

check('the readiness endpoint installs nothing and writes nothing', () => {
  // The whole safety of this milestone: the cost of being wrong is a wrong
  // answer, not a broken machine.
  for (const forbidden of ['apt-get', 'apt ', 'yum', 'writeFile', 'systemctl start', 'systemctl restart', 'certbot']) {
    assert.ok(!handler.includes(forbidden), `the readiness handler runs "${forbidden}"`);
  }
});

check('the agent is new enough to be asked', () => {
  const m = /const AGENT_VERSION = (\d+)/.exec(agent);
  assert.ok(Number(m[1]) >= PREPARE_MIN_AGENT, `agent is v${m[1]}, the panel asks for v${PREPARE_MIN_AGENT}`);
});

check('the agent runs nothing through a shell', () => {
  // The oldest rule in the agent, and the first version of this milestone
  // broke it: a `sh -c` helper, with unit names and paths that arrive from a
  // panel over the network. Caught by the gate in the playlist suite; asserted
  // here too, beside the code that tempted it.
  assert.ok(/promisify\(execFile\)/.test(agent), 'the agent shells out');
  assert.ok(!/promisify\(exec\)\(/.test(agent), 'a shell helper is back');
});

check('a missing tool yields null rather than a confident false', () => {
  assert.ok(/return null;/.test(agent.slice(agent.indexOf('async function portListening'), agent.indexOf('async function certState'))),
    'portListening reports "free" when it could not look');
});

console.log('\nTHE DIALOG ASKS WHAT THE PURPOSE NEEDS:');

const dlg = readFileSync(new URL('../../frontend/src/pages/ServersPage.jsx', import.meta.url), 'utf8');
const dict = readFileSync(new URL('../../frontend/src/i18n.jsx', import.meta.url), 'utf8');

check('the purpose is asked before anything it decides', () => {
  // It decides what the rest of the dialog is even asking. Buried in the
  // middle, it read as one field among many and the form asked everything of
  // everyone — which is how a form teaches people to skip fields.
  assert.ok(dlg.indexOf("t('sp.purposeLabel')") < dlg.indexOf("t('sp.name')"),
    'the purpose is asked after the fields it governs');
});

check('a gateway is not asked for a WMSPanel mapping', () => {
  // It is not in WMSPanel and never will be: no media server runs on it, so
  // there is nothing there to manage.
  const i = dlg.indexOf("t('sp.wmspanelServer')");
  assert.ok(/\{isNimble && <>[\s\S]{0,400}$/.test(dlg.slice(Math.max(0, i - 400), i)),
    'the WMSPanel mapping is offered on a machine that has no Nimble');
});

check('a gateway is not asked for playback endpoints', () => {
  const i = dlg.indexOf("t('sp.playback')");
  assert.ok(/\{isNimble && <>[\s\S]{0,300}$/.test(dlg.slice(Math.max(0, i - 300), i)));
});

check('TLS is asked of every purpose', () => {
  // The one question that means the same on both: a gateway terminates it for
  // viewers, a media server needs it for LL-HLS.
  const tls = dlg.indexOf("t('sp.httpsPortHint')");
  const closes = dlg.lastIndexOf('</>}', tls);
  assert.ok(closes < tls, 'the TLS port is inside a Nimble-only block');
});

check('the dialog speaks the panel\'s language', () => {
  // "Add server" and "not mapped" sat in English inside a Russian dialog,
  // which is what an unfinished screen looks like from the outside.
  for (const k of ['sp.addTitle', 'sp.editTitle', 'sp.mgmtToken', 'sp.notMapped']) {
    assert.equal((dict.match(new RegExp(`'${k.replace('.', '\\.')}':`, 'g')) || []).length, 2, k);
    assert.ok(dlg.includes(`t('${k}')`), `${k} is declared and not used`);
  }
  assert.ok(!/>\+ Add server</.test(dlg), 'a hard-coded English label survived');
});

console.log('\nAN INSTALL REPORTS ITSELF, NOT ITS CONSOLE:');

const inst = readFileSync(new URL('../../frontend/src/components/AgentInstallModal.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../frontend/src/styles.css', import.meta.url), 'utf8');

check('there is a bar and named stages, not only a log', () => {
  // A wall of console output asks the operator to be the parser: to read apt's
  // noise and work out how far it got and whether that is normal.
  assert.ok(/INSTALL_STAGES/.test(inst), 'the install has no named stages');
  assert.ok(/progress-fill/.test(inst) && /\.progress-fill/.test(css), 'there is no progress bar');
});

check('the log is behind a fold, and still there', () => {
  // Evidence rather than interface — but removing it would take away the only
  // thing that answers "why" when a stage fails.
  assert.ok(/showLog/.test(inst), 'the log has no fold');
  // Inside the fold, not merely somewhere in the file: `job.output` is also
  // read to work out the stage, so its presence proved nothing about the log
  // still being shown. The first version of this check passed against a fold
  // that opened onto an ellipsis.
  const fold = inst.slice(inst.indexOf('{showLog && ('), inst.indexOf('</pre>'));
  assert.ok(/job\.output/.test(fold), 'the fold opens onto nothing — the log was removed, not folded');
});

check('a failed install never shows a full bar', () => {
  // A bar that fills to the end and then says it went wrong contradicts
  // itself, and people believe the bar.
  assert.ok(/job\.status === 'done' \? 100/.test(inst), 'the fill does not depend on success');
  assert.ok(/progress\.failed/.test(css), 'a failed bar looks like a finished one');
});

check('the failing line is lifted out of the log', () => {
  // Somebody whose install just failed should not have to scroll to find the
  // one line that says why.
  assert.ok(/lastErrorLine/.test(inst));
});

check('every stage has a sentence, in both languages', () => {
  const ids = [...new Set([...inst.matchAll(/\{ id: '([a-z]+)'/g)].map(m => m[1]))];
  assert.ok(ids.length >= 5, `only ${ids.length} stages`);
  for (const id of ids) {
    assert.equal((dict.match(new RegExp(`'inst\\.stage\\.${id}':`, 'g')) || []).length, 2, id);
  }
});

console.log('\nTHE PROJECT SAYS WHAT IT IS:');

check('there is a state document, and the readme points at it', () => {
  // Written after proposing to build a feature the panel already had. A
  // changelog says what changed; nothing said what exists.
  const state = readFileSync(new URL('../../docs/STATE.md', import.meta.url), 'utf8');
  assert.ok(state.length > 2000, 'the state document is a stub');
  for (const heading of ['What exists', 'deliberately absent', 'waiting on something other than code']) {
    assert.ok(state.includes(heading), `the state document has no "${heading}" section`);
  }
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('docs/STATE.md'), 'the readme does not point at it');
});

console.log(failures ? `\n${failures} readiness check(s) failed` : '\nall readiness checks passed');
process.exit(failures ? 1 : 0);
