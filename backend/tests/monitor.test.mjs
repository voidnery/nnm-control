// Watching on a schedule, iter22 m4.
//
// A check only run by hand answers "is it working" at the moment somebody was
// already worried. The useful answer — did it hold through the second half —
// needs the question asked when nobody is watching.
//
// These checks are about restraint. Being the viewer means fetching a playlist
// from every edge, twice, so a monitor that asks too often is the panel
// becoming the load it was built to measure.
import assert from 'node:assert/strict';
import { dueChannels, DEFAULT_INTERVAL_MIN } from '../src/services/deliveryMonitor.js';
import { availability } from '../src/models/DeliveryCheck.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

const now = new Date('2026-08-12T12:00:00Z');
const ago = (min) => new Date(now.getTime() - min * 60_000);
const CH = (id) => ({ id, application: 'test2', stream: id });

console.log('\nASKING NO MORE OFTEN THAN AGREED:');

check('a channel checked a moment ago is left alone', () => {
  // Without this a slow pass overlaps the next and the fleet is asked twice as
  // often as configured.
  const due = dueChannels([CH('a')], { now, intervalMin: 5, lastByChannel: new Map([['a', ago(1)]]) });
  assert.equal(due.length, 0);
});

check('a channel checked longer ago than the interval is due', () => {
  const due = dueChannels([CH('a')], { now, intervalMin: 5, lastByChannel: new Map([['a', ago(6)]]) });
  assert.equal(due.length, 1);
});

check('a channel never checked is due', () => {
  assert.equal(dueChannels([CH('a')], { now, intervalMin: 5 }).length, 1);
});

check('the interval is a floor, exactly', () => {
  // At precisely the interval it is due; a second short of it, it is not.
  assert.equal(dueChannels([CH('a')], { now, intervalMin: 5, lastByChannel: new Map([['a', ago(5)]]) }).length, 1);
  assert.equal(dueChannels([CH('a')], { now, intervalMin: 5, lastByChannel: new Map([['a', ago(4)]]) }).length, 0);
});

console.log('\nWHAT THE HISTORY SAYS:');

const chk = (over) => ({ at: now, ok: 3, total: 3, codes: [], worstMs: 200, ...over });

check('untested is not perfect', () => {
  // The distinction the whole history exists for: 100% of nothing is not
  // availability, and reporting it as such is the most flattering lie
  // available.
  assert.equal(availability([]), null);
});

check('availability counts checks where every edge served', () => {
  const a = availability([chk({}), chk({}), chk({ ok: 0 })]);
  assert.equal(a.checks, 3);
  assert.equal(a.served, 2);
  assert.equal(a.failed, 1);
  assert.equal(a.pct, 66.7);
});

check('one edge down is partial, and counted apart from an outage', () => {
  // Averaging them into one percentage hides which of the two happened, and
  // they call for different work.
  const a = availability([chk({ ok: 2, total: 3 })]);
  assert.equal(a.partial, 1);
  assert.equal(a.failed, 0);
  assert.equal(a.served, 0);
});

check('the reasons for failing are kept, most common first', () => {
  // "It was down" and knowing why are different reports: a 404 all evening is
  // a missing route, a timeout all evening is a network.
  const a = availability([
    chk({ ok: 0, codes: ['route-missing'] }),
    chk({ ok: 0, codes: ['route-missing'] }),
    chk({ ok: 1, total: 3, codes: ['edge-timeout'] }),
  ]);
  assert.equal(a.reasons[0].code, 'route-missing');
  assert.equal(a.reasons[0].n, 2);
});

check('the slowest edge seen survives the averaging', () => {
  // A channel that serves everywhere in four seconds is technically fine and
  // practically broken, and a mean would bury it.
  const a = availability([chk({ worstMs: 120 }), chk({ worstMs: 4200 }), chk({ worstMs: 90 })]);
  assert.equal(a.worstMs, 4200);
});

check('a window can be asked for, and an empty one says nothing', () => {
  const rows = [chk({ at: ago(10) }), chk({ at: ago(400) })];
  assert.equal(availability(rows, { since: ago(60) }).checks, 1);
  assert.equal(availability(rows, { since: ago(1) }), null);
});

console.log('\nRESTRAINT BY DEFAULT:');

check('the interval has a sane floor', () => {
  assert.ok(DEFAULT_INTERVAL_MIN >= 5, 'a default under five minutes is the panel becoming the load');
});

console.log(failures ? `\n${failures} monitor check(s) failed` : '\nall monitor checks passed');
process.exit(failures ? 1 : 0);
