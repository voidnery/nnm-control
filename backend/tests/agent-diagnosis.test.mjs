// iter12 m4 — the diagnosis.
//
// This classifier decides what an operator is told to go and do, so the cases
// that matter most are the ones where two conditions are true at once and the
// wrong one wins. An inverted timestamp comparison here would send someone to
// restart a perfectly healthy agent while the real fault sat in the panel.
import assert from 'node:assert/strict';
import { diagnose, CODES, HINTS, STALE_AFTER_MS, RESTART_LIMIT, RESTART_WINDOW_MS } from '../src/services/agentDiagnosis.js';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
};

const NOW = new Date('2026-07-30T12:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms);
const ok = { enabled: true, hasToken: true };
const task = (o = {}) => ({
  id: 't1', route: 'GET /health', status: 'queued',
  createdAt: ago(30_000), claimedAt: null, deadlineAt: new Date(NOW.getTime() + 60_000), ...o,
});

console.log('THE STATES:');

check('no agent configured is idle, not a fault', () => {
  const d = diagnose({ now: NOW, agent: { enabled: false, hasToken: false } });
  assert.equal(d.code, CODES.NOT_CONFIGURED);
  assert.equal(d.severity, 'idle');
});

check('enabled but tokenless counts as not configured', () => {
  assert.equal(diagnose({ now: NOW, agent: { enabled: true, hasToken: false } }).code, CODES.NOT_CONFIGURED);
});

check('never called in -> no-contact', () => {
  const d = diagnose({ now: NOW, agent: { ...ok, lastContactAt: null } });
  assert.equal(d.code, CODES.NO_CONTACT);
  assert.equal(d.sinceContactMs, null);
});

check('silent for longer than two poll windows -> stopped-polling', () => {
  const d = diagnose({ now: NOW, agent: { ...ok, lastContactAt: ago(STALE_AFTER_MS + 1000) } });
  assert.equal(d.code, CODES.STOPPED_POLLING);
  assert.match(d.evidence, /not polling/);
});

check('a gap of one poll window is normal and says nothing', () => {
  // The agent parks for 25s. Calling that a fault would flag every healthy
  // agent between polls.
  const d = diagnose({ now: NOW, agent: { ...ok, lastContactAt: ago(26_000) } });
  assert.equal(d.code, CODES.HEALTHY);
});

check('polling but changing identity repeatedly -> restart-loop', () => {
  const d = diagnose({
    now: NOW,
    agent: { ...ok, lastContactAt: ago(5_000), restarts: RESTART_LIMIT, restartWindowStart: ago(120_000) },
  });
  assert.equal(d.code, CODES.RESTART_LOOP);
  assert.equal(d.restarts, RESTART_LIMIT);
});

check('an ordinary restart is not a crash loop', () => {
  const d = diagnose({
    now: NOW,
    agent: { ...ok, lastContactAt: ago(5_000), restarts: 1, restartWindowStart: ago(120_000) },
  });
  assert.equal(d.code, CODES.HEALTHY);
});

check('restarts long ago do not count against a healthy agent now', () => {
  const d = diagnose({
    now: NOW,
    agent: { ...ok, lastContactAt: ago(5_000), restarts: 9, restartWindowStart: ago(RESTART_WINDOW_MS + 60_000) },
  });
  assert.equal(d.code, CODES.HEALTHY, 'the window must roll, or one bad hour marks a server for ever');
});

check('claimed and never answered -> claimed-no-answer, naming the route', () => {
  const d = diagnose({
    now: NOW,
    agent: { ...ok, lastContactAt: ago(5_000) },
    tasks: [task({ status: 'claimed', claimedAt: ago(90_000), deadlineAt: ago(10_000), route: 'POST /media/fetch' })],
  });
  assert.equal(d.code, CODES.CLAIMED_NO_ANSWER);
  assert.equal(d.task.route, 'POST /media/fetch');
});

check('a claimed task still inside its deadline is not a fault', () => {
  const d = diagnose({
    now: NOW,
    agent: { ...ok, lastContactAt: ago(5_000) },
    tasks: [task({ status: 'claimed', claimedAt: ago(5_000), deadlineAt: new Date(NOW.getTime() + 60_000) })],
  });
  assert.equal(d.code, CODES.HEALTHY);
  assert.equal(d.pending, 1);
});

console.log('\nTHE CASE THAT USED TO GET BLAMED ON THE AGENT:');

check('queued, and the agent polled AFTER it was queued -> the panel did not hand it over', () => {
  const d = diagnose({
    now: NOW,
    agent: { ...ok, lastContactAt: ago(5_000) },          // contact AFTER creation
    tasks: [task({ createdAt: ago(40_000) })],
  });
  assert.equal(d.code, CODES.NOT_CLAIMED);
  assert.match(d.evidence, /the panel did not hand it over/);
});

check('queued, but the agent has not polled since -> not the panel', () => {
  const d = diagnose({
    now: NOW,
    agent: { ...ok, lastContactAt: ago(40_000) },         // contact BEFORE creation
    tasks: [task({ createdAt: ago(30_000) })],
  });
  assert.notEqual(d.code, CODES.NOT_CLAIMED, 'the panel cannot be blamed for a task nobody has asked for yet');
  assert.equal(d.code, CODES.HEALTHY);
});

check('the comparison is not accidentally inverted', () => {
  const queuedAt = ago(30_000);
  const before = diagnose({ now: NOW, agent: { ...ok, lastContactAt: ago(45_000) }, tasks: [task({ createdAt: queuedAt })] });
  const after = diagnose({ now: NOW, agent: { ...ok, lastContactAt: ago(15_000) }, tasks: [task({ createdAt: queuedAt })] });
  assert.equal(before.code, CODES.HEALTHY);
  assert.equal(after.code, CODES.NOT_CLAIMED);
});

console.log('\nPRECEDENCE (which answer wins when several are true):');

check('an absent agent outranks any stuck task', () => {
  // Both are true. Telling the operator to investigate a claim bug while the
  // agent is not running at all would send them to the wrong place.
  const d = diagnose({
    now: NOW,
    agent: { ...ok, lastContactAt: ago(STALE_AFTER_MS + 5_000) },
    tasks: [task({ status: 'claimed', deadlineAt: ago(10_000) }), task({ id: 't2', createdAt: ago(600_000) })],
  });
  assert.equal(d.code, CODES.STOPPED_POLLING);
});

check('never-contacted outranks stopped-polling', () => {
  const d = diagnose({ now: NOW, agent: { ...ok, lastContactAt: null }, tasks: [task()] });
  assert.equal(d.code, CODES.NO_CONTACT);
});

check('a crash loop outranks a task that is merely stuck behind it', () => {
  const d = diagnose({
    now: NOW,
    agent: { ...ok, lastContactAt: ago(3_000), restarts: RESTART_LIMIT + 2, restartWindowStart: ago(60_000) },
    tasks: [task({ createdAt: ago(120_000) })],
  });
  assert.equal(d.code, CODES.RESTART_LOOP);
});

check('an agent that took the work outranks one that has not been given it', () => {
  const d = diagnose({
    now: NOW,
    agent: { ...ok, lastContactAt: ago(3_000) },
    tasks: [
      task({ id: 'a', status: 'claimed', deadlineAt: ago(5_000) }),
      task({ id: 'b', status: 'queued', createdAt: ago(60_000) }),
    ],
  });
  assert.equal(d.code, CODES.CLAIMED_NO_ANSWER);
});

check('the oldest stuck task is the one reported', () => {
  const d = diagnose({
    now: NOW,
    agent: { ...ok, lastContactAt: ago(3_000) },
    tasks: [
      task({ id: 'new', createdAt: ago(20_000), route: 'GET /health' }),
      task({ id: 'old', createdAt: ago(300_000), route: 'PUT /config' }),
    ],
  });
  assert.equal(d.task.id, 'old');
  assert.equal(d.task.route, 'PUT /config');
});

console.log('\nNOISE:');

check('finished tasks never produce a fault', () => {
  const d = diagnose({
    now: NOW,
    agent: { ...ok, lastContactAt: ago(3_000) },
    tasks: [
      task({ id: 'a', status: 'done', createdAt: ago(300_000) }),
      task({ id: 'b', status: 'failed', createdAt: ago(200_000) }),
      task({ id: 'c', status: 'expired', createdAt: ago(100_000) }),
    ],
  });
  assert.equal(d.code, CODES.HEALTHY);
});

check('no tasks at all is healthy, not unknown', () => {
  const d = diagnose({ now: NOW, agent: { ...ok, lastContactAt: ago(3_000) }, tasks: [] });
  assert.equal(d.code, CODES.HEALTHY);
  assert.equal(d.pending, 0);
});

check('every code carries the time of last contact for the operator to read', () => {
  for (const agent of [
    { enabled: false, hasToken: false },
    { ...ok, lastContactAt: null },
    { ...ok, lastContactAt: ago(999_999) },
    { ...ok, lastContactAt: ago(1_000) },
  ]) {
    const d = diagnose({ now: NOW, agent });
    assert.ok('lastContactAt' in d && 'sinceContactMs' in d && d.evidence, d.code);
  }
});

check('every code has a decided hint — a new one cannot be added silently', () => {
  for (const code of Object.values(CODES)) {
    assert.ok(code in HINTS, `${code} has no hint`);
  }
});

check('called with nothing at all, it does not throw', () => {
  assert.equal(diagnose().code, CODES.NOT_CONFIGURED);
  assert.equal(diagnose({}).code, CODES.NOT_CONFIGURED);
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : '\nall agent-diagnosis checks passed');
process.exit(fail ? 1 : 0);
