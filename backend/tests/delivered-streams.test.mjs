// What a network delivers, asked of the function that answers it.
//
// The page walked channel records — one row per pair somebody had typed —
// while a route is per application, so a stream appearing inside a carried
// application is delivered whether or not a record exists. On the fleet's one
// real network that is two streams in `test2` today and a third the moment
// somebody publishes one.

import assert from 'node:assert/strict';
import { deliveredStreams, applicationPackaging } from '../src/services/deliveredStreams.js';
import { carriedApplications } from '../src/services/carriedApplications.js';
import { pub } from '../src/routes/channels.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

const carried = (applications = [], channels = []) =>
  carriedApplications({ network: { applications }, channels });
const liveMap = (obj) => new Map(Object.entries(obj)
  .map(([a, streams]) => [a, streams.map(s => (typeof s === 'string' ? { stream: s, bandwidth: 0 } : s))]));

console.log('\nWHAT AN APPLICATION OFFERS IS READ, NOT ASSUMED:');

check('an unread application offers an unknown set, not an empty one', () => {
  // A discovered stream has no channel record and so no `protocol` field.
  // Defaulting one to `hls` would build a link out of a guess.
  const p = applicationPackaging(null);
  assert.equal(p.known, false);
  assert.deepEqual(p.protocols, []);
  assert.equal(p.llhls, null);
});

check('plain HLS with the checkbox off offers hls', () => {
  const p = applicationPackaging({ protocols: ['HLS', 'DASH', 'SLDP'], alhls_enabled: false });
  assert.deepEqual(p.protocols, ['hls', 'dash']);
  assert.equal(p.llhls, false);
  assert.deepEqual(p.other, ['SLDP']);
});

check('the checkbox on turns the HLS entry into llhls rather than adding one', () => {
  // MEASURED on `nnm-probe` 2026-09-03: protocols HLS_FMP4, DASH, SLDP with
  // `alhls_enabled` true. LL-HLS is HLS with parts on the same playlist, so
  // offering both would be two links to one file and a choice the server does
  // not have.
  const p = applicationPackaging({ protocols: ['HLS_FMP4', 'DASH', 'SLDP'], alhls_enabled: true });
  assert.deepEqual(p.protocols, ['llhls', 'dash']);
  assert.equal(p.container, 'fmp4');
});

check('an application with no HLS container at all says unknown, not off', () => {
  // The field is absent on this API when no HLS protocol is set, and absent is
  // not `false`: "the checkbox does not apply here" is a different statement
  // from "somebody switched it off".
  const p = applicationPackaging({ protocols: ['DASH', 'SLDP'] });
  assert.equal(p.llhls, null);
  assert.deepEqual(p.protocols, ['dash']);
});

console.log('\nEVERY LIVE STREAM IN A CARRIED APPLICATION IS A ROW:');

check('a stream nobody wrote down is delivered and shown', () => {
  const r = deliveredStreams({
    carried: carried([{ name: 'test2' }]),
    live: liveMap({ test2: ['test_stream', 'test_stream2', 'surprise'] }),
    channels: [{ application: 'test2', stream: 'test_stream' }],
  });
  assert.deepEqual(r.list.map(x => x.stream), ['surprise', 'test_stream', 'test_stream2']);
  assert.equal(r.discovered, 2);
  assert.equal(r.list.find(x => x.stream === 'surprise').live, true);
  assert.equal(r.list.find(x => x.stream === 'surprise').channel, null);
});

check('a live stream in an application the network does not carry is not a row', () => {
  // The origin publishes plenty this network has nothing to do with.
  const r = deliveredStreams({
    carried: carried([{ name: 'test2' }]),
    live: liveMap({ test2: ['a'], somebody_else: ['b'] }),
  });
  assert.deepEqual(r.list.map(x => x.application), ['test2']);
});

check('a record is an annotation on the stream, not the reason it is listed', () => {
  const r = deliveredStreams({
    carried: carried([{ name: 'test2' }]),
    live: liveMap({ test2: ['s1'] }),
    channels: [{ id: 'c1', application: 'test2', stream: 's1', name: 'Match', protocol: 'hls',
                 protection: { mode: 'open' } }],
  });
  assert.equal(r.list.length, 1);
  assert.equal(r.list[0].live, true);
  assert.equal(r.list[0].channel.name, 'Match');
});

console.log('\nNOT LIVE, NOT ASKED, AND NOT CARRIED ARE THREE ANSWERS:');

check('origins read and the stream absent is false', () => {
  // An event configured before it starts. Not an error, and worth seeing.
  const r = deliveredStreams({
    carried: carried([{ name: 'test2' }]),
    live: liveMap({ test2: [] }),
    channels: [{ application: 'test2', stream: 'tomorrow' }],
  });
  assert.equal(r.list[0].live, false);
  assert.equal(r.asked, true);
});

check('origins unreadable is null, and null is not false', () => {
  // Saying "nothing is streaming" about origins nobody could reach is the
  // exact failure this project keeps making: absence concluded from a probe
  // that did not run.
  const r = deliveredStreams({
    carried: carried([{ name: 'test2' }]),
    live: null,
    channels: [{ application: 'test2', stream: 'tomorrow' }],
  });
  assert.equal(r.list[0].live, null);
  assert.equal(r.asked, false);
  assert.equal(r.discovered, 0);
});

check('a record whose application the network does not carry is named', () => {
  const r = deliveredStreams({
    carried: carried([{ name: 'test2' }]),
    live: liveMap({ test2: [] }),
    channels: [{ application: 'orphan', stream: 's' }],
  });
  assert.deepEqual(r.notDelivered, ['orphan/s']);
  assert.equal(r.list.find(x => x.application === 'orphan').carried, false);
});

console.log('\nA RECORDED PACKAGING THAT THE APPLICATION DOES NOT OFFER:');

check('a channel asking for llhls where the application offers plain hls is reported', () => {
  // `live/app` carries one set of protocols, so two records in one application
  // cannot legitimately differ. This is where that shows up instead of being
  // averaged into a link that plays the wrong thing.
  const r = deliveredStreams({
    carried: carried([{ name: 'test2' }]),
    live: liveMap({ test2: ['s1'] }),
    channels: [{ application: 'test2', stream: 's1', protocol: 'llhls' }],
    apps: new Map([['test2', { protocols: ['HLS', 'DASH'], alhls_enabled: false }]]),
  });
  assert.deepEqual(r.packagingDisagrees, [
    { application: 'test2', stream: 's1', recorded: 'llhls', offers: ['hls', 'dash'] },
  ]);
});

check('nothing is reported when the application was not read', () => {
  // Disagreement needs two sides. Reporting one against an unknown would put a
  // warning on every row the moment WMSPanel is unreachable.
  const r = deliveredStreams({
    carried: carried([{ name: 'test2' }]),
    live: liveMap({ test2: ['s1'] }),
    channels: [{ application: 'test2', stream: 's1', protocol: 'llhls' }],
    apps: new Map(),
  });
  assert.deepEqual(r.packagingDisagrees, []);
  assert.equal(r.list[0].packaging.known, false);
});

check('agreement is not reported', () => {
  const r = deliveredStreams({
    carried: carried([{ name: 'test2' }]),
    live: liveMap({ test2: ['s1'] }),
    channels: [{ application: 'test2', stream: 's1', protocol: 'hls' }],
    apps: new Map([['test2', { protocols: ['HLS'], alhls_enabled: false }]]),
  });
  assert.deepEqual(r.packagingDisagrees, []);
});

console.log('\nTHE FLEET, AS IT IS TODAY:');

check('two streams in one application are two rows and one application', () => {
  // Read off the production database on 2026-09-03: `channels` holds two
  // documents, both `application: 'test2'`, streams `test_stream` and
  // `test_stream2`, both `hls`, both open, both on the one network.
  const r = deliveredStreams({
    carried: carried([{ name: 'test2' }], [
      { application: 'test2', stream: 'test_stream' },
      { application: 'test2', stream: 'test_stream2' },
    ]),
    live: liveMap({ test2: ['test_stream', 'test_stream2'] }),
    channels: [
      { application: 'test2', stream: 'test_stream', protocol: 'hls' },
      { application: 'test2', stream: 'test_stream2', protocol: 'hls' },
    ],
    apps: new Map([['test2', { protocols: ['HLS'], alhls_enabled: false }]]),
  });
  assert.equal(r.list.length, 2);
  assert.equal(new Set(r.list.map(x => x.application)).size, 1);
  assert.deepEqual(r.notDelivered, []);
  assert.deepEqual(r.packagingDisagrees, []);
});

console.log('\nA ROW NEVER INVENTS A PACKAGING:');

check('a synthesised row with no packaging stays without one', () => {
  // `pub()` used to read `c.protocol || 'hls'`. A stored record always carries
  // one, so that fallback only ever fired for a row the panel built itself —
  // a discovered stream whose application could not be read — and it put HLS
  // on a row where nobody had established anything.
  const r = pub({ application: 'test2', stream: 's1', discovered: true, live: true });
  assert.equal(r.protocol, null);
  assert.equal(r.discovered, true);
});

check('a stored record keeps the protocol it stores', () => {
  const r = pub({ id: 'c1', application: 'test2', stream: 's1', protocol: 'llhls' });
  assert.equal(r.protocol, 'llhls');
  // Not a synthesised row: `false` here would claim we had checked.
  assert.equal(r.discovered, null);
  assert.equal(r.live, null);
});

check('the signing key never leaves the panel', () => {
  // Unchanged rule, re-checked because `pub` was edited: whoever holds the key
  // can mint links for the channel.
  const r = pub({ application: 'a', stream: 'b', protection: { mode: 'token', tokenKey: 'SECRET' } });
  assert.equal(r.protection.hasKey, true);
  assert.equal(JSON.stringify(r).includes('SECRET'), false);
});

if (failures) { console.log(`\n${failures} delivered check(s) failed`); process.exit(1); }
console.log('\nall delivered checks passed');
