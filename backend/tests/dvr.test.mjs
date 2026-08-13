// Links to what was recorded, iter22 m5.
//
// DVR cannot be set up from the panel: WMSPanel exposes /v1/dvr_streams as GET
// and DELETE only, with no POST. Recording is configured on its own settings
// page, and saying otherwise would promise something there is no way to do.
//
// What the panel can do is the thing an operator asks for during a broadcast —
// "the goal at 19:42, thirty seconds" — because a DVR link is not an object,
// it is the live URL with a different filename. Which makes it arithmetic, and
// arithmetic can be got right without a fleet.
import assert from 'node:assert/strict';
import { dvrUrl, momentUrl, toEpochSeconds, recordingFor, CONTAINERS } from '../src/services/dvrLinks.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

const base = { host: '192.168.0.1', port: 8081, application: 'live', stream: 'music' };

console.log('\nTHE DOCUMENTED FORMS, EXACTLY:');

check('the whole archive is the live URL with another filename', () => {
  // Softvelum's own example, to the character.
  assert.equal(dvrUrl(base).url, 'http://192.168.0.1:8081/live/music/playlist_dvr.m3u8');
});

check('a range carries a UTC epoch start and a duration in seconds', () => {
  const u = dvrUrl({ ...base, mode: 'range', from: new Date(1447069728 * 1000), seconds: 120 });
  assert.equal(u.url, 'http://192.168.0.1:8081/live/music/playlist_dvr_range-1447069728-120.m3u8');
});

check('a timeshift carries a shift and an optional depth', () => {
  assert.equal(dvrUrl({ ...base, mode: 'timeshift', shiftSeconds: 7200, depthSeconds: 120 }).url,
    'http://192.168.0.1:8081/live/music/playlist_dvr_timeshift-7200-120.m3u8');
  assert.equal(dvrUrl({ ...base, mode: 'timeshift', shiftSeconds: 7200 }).url,
    'http://192.168.0.1:8081/live/music/playlist_dvr_timeshift-7200.m3u8');
});

check('fMP4 is the same URLs with another prefix', () => {
  // Both containers play simultaneously; which one a viewer needs is a
  // property of their player, not of the recording.
  assert.equal(CONTAINERS.fmp4, 'playlist_fmp4_dvr');
  assert.match(dvrUrl({ ...base, container: 'fmp4', mode: 'range', from: 0, seconds: 30 }).url,
    /playlist_fmp4_dvr_range-0-30\.m3u8$/);
});

console.log('\nSECONDS, NOT MILLISECONDS, AND UTC:');

check('the epoch is in seconds', () => {
  // Milliseconds put the request 46 years out, and the server answers with an
  // empty playlist rather than an error — the kind of wrong nobody debugs
  // quickly.
  assert.equal(toEpochSeconds(new Date('2026-08-12T19:42:00Z')), 1786563720);
});

check('the operator\'s timezone does not leak into the URL', () => {
  const tz = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Tokyo';
    assert.equal(toEpochSeconds(new Date('2026-08-12T19:42:00Z')), 1786563720);
  } finally { process.env.TZ = tz; }
});

console.log('\nA MOMENT, AS SOMEBODY WATCHING REMEMBERS IT:');

check('a moment becomes a range padded on both sides', () => {
  // Nobody watching a match remembers a start and an end. They remember when
  // it happened.
  const u = momentUrl({ ...base, at: new Date(1447069728 * 1000), beforeSeconds: 10, afterSeconds: 20 });
  assert.match(u.url, /playlist_dvr_range-1447069718-30\.m3u8$/);
});

check('the link says in words what it asks for', () => {
  // So it can be checked against what was meant before it is handed to
  // anybody — a fragment of the wrong minute looks exactly like a right one.
  const u = momentUrl({ ...base, at: new Date(1447069728 * 1000) });
  assert.equal(u.describes.seconds, 30);
  assert.match(u.describes.fromUtc, /^2015-11-09T/);
});

console.log('\nAN INCOMPLETE RANGE IS REFUSED, NOT COMPLETED:');

check('a range without a duration throws rather than guessing', () => {
  // Defaulting turns it into some other range, and the operator gets footage
  // of the wrong minute without anything having looked broken.
  assert.throws(() => dvrUrl({ ...base, mode: 'range', from: new Date() }), /duration/);
});

check('a range without a start throws', () => {
  assert.throws(() => dvrUrl({ ...base, mode: 'range', seconds: 30 }), /start/);
});

check('a timeshift without a shift throws', () => {
  assert.throws(() => dvrUrl({ ...base, mode: 'timeshift' }), /shift/);
});

console.log('\nWHETHER THERE IS ANYTHING TO REPLAY:');

check('a recording is matched on the pair that is the channel', () => {
  const streams = [
    { application: 'live', stream: 'other', size: 1 },
    { application: 'live', stream: 'music', size: 42 },
  ];
  assert.equal(recordingFor({ application: 'live', stream: 'music' }, streams).size, 42);
});

check('no recording is null, not an empty guess', () => {
  // A replay link for a stream nobody recorded plays nothing, and the operator
  // concludes the archive is broken.
  assert.equal(recordingFor({ application: 'live', stream: 'music' }, []), null);
});

console.log(failures ? `\n${failures} DVR check(s) failed` : '\nall DVR checks passed');
process.exit(failures ? 1 : 0);
