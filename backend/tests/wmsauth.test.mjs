// Signing a playback URL, iter22 m1.
//
// Creating a WMSAuth rule is easy; producing a link that satisfies it is where
// the work is. A link signed slightly wrong does not fail loudly — the server
// refuses, and the operator concludes the stream is broken. So these checks
// are about the three details that silently change the hash.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { serverTime, signUrl, readSignature, tokenPreconditions } from '../src/services/wmsAuth.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

const URL0 = 'http://video.example.com:8081/live/stream/playlist.m3u8';

console.log('\nTHE TIME FORMAT IS PART OF THE HASH:');

check("PHP's n/j/Y g:i:s A has no leading zeros and a 12-hour clock", () => {
  // `05/04/2012 08:33:05 AM` hashes to something different from
  // `5/4/2012 8:33:05 AM`, and the only symptom is a 403.
  assert.equal(serverTime(new Date(Date.UTC(2012, 4, 4, 8, 33, 5))), '5/4/2012 8:33:05 AM');
});

check('noon and midnight are 12, not 0', () => {
  assert.match(serverTime(new Date(Date.UTC(2026, 0, 1, 0, 5, 0))), /^1\/1\/2026 12:05:00 AM$/);
  assert.match(serverTime(new Date(Date.UTC(2026, 0, 1, 12, 5, 0))), /^1\/1\/2026 12:05:00 PM$/);
});

check('the afternoon is PM on a 12-hour clock', () => {
  assert.equal(serverTime(new Date(Date.UTC(2026, 7, 12, 15, 4, 9))), '8/12/2026 3:04:09 PM');
});

check('it is UTC, not the machine the panel happens to run on', () => {
  // A panel in Moscow and a server in UTC would otherwise disagree by three
  // hours, far outside any tolerance, and every link would 403.
  //
  // Checked under a forced timezone rather than by reading the source: this
  // suite runs in UTC, so local and UTC agree and an implementation using
  // getMonth() instead of getUTCMonth() passed the naive version of this
  // check. The contradiction proved it — the assertion did not.
  const tz = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Tokyo';   // UTC+9: the date itself rolls over
    const t = serverTime(new Date(Date.UTC(2026, 7, 12, 23, 30, 0)));
    assert.equal(t, '8/12/2026 11:30:00 PM', 'the local clock leaked into the signature');
  } finally {
    process.env.TZ = tz;
  }
});

console.log('\nTHE HASH IS RAW BYTES, THEN BASE64:');

check('base64 of the raw digest, not of the hex digest', () => {
  // Both are strings of plausible length. Only one is accepted.
  const at = new Date(Date.UTC(2026, 7, 12, 10, 0, 0));
  const r = signUrl(URL0, { key: 'secret', ip: '1.2.3.4', validMinutes: 20, at });
  const parts = readSignature(r.url);
  const expected = crypto.createHash('md5')
    .update(`1.2.3.4secret${serverTime(at)}20`, 'utf8').digest('base64');
  assert.equal(parts.hash_value, expected);
  const hexThenB64 = Buffer.from(crypto.createHash('md5')
    .update(`1.2.3.4secret${serverTime(at)}20`, 'utf8').digest('hex')).toString('base64');
  assert.notEqual(parts.hash_value, hexThenB64, 'the hex digest was base64d instead of the raw one');
});

console.log('\nTHE SIGNATURE ROUND-TRIPS:');

check('a signed URL decodes to the fields Nimble expects', () => {
  // Same shape as Softvelum's documented example, which decodes to
  // "server_time=…&hash_value=…&validminutes=…".
  const r = signUrl(URL0, { key: 'k', ip: '10.0.0.1' });
  const p = readSignature(r.url);
  assert.ok(p.server_time && p.hash_value && p.validminutes);
  assert.equal(p.validminutes, '20');
});

check('a URL that already has a query keeps it', () => {
  const r = signUrl(`${URL0}?foo=1`, { key: 'k' });
  assert.match(r.url, /\?foo=1&wmsAuthSign=/);
});

check('pay-per-view folds an id into the hash and names it', () => {
  // The id sits between the ip and the key. Order is not guessable from the
  // field names, and getting it wrong is another silent 403.
  const at = new Date(Date.UTC(2026, 7, 12, 10, 0, 0));
  const r = signUrl(URL0, { key: 'k', ip: '1.1.1.1', id: 'ID_7', checkIp: true, at });
  const p = readSignature(r.url);
  assert.equal(p.id, 'ID_7');
  assert.equal(p.checkip, 'true');
  assert.equal(p.hash_value, crypto.createHash('md5')
    .update(`1.1.1.1ID_7k${serverTime(at)}20`, 'utf8').digest('base64'));
});

check('reading a signature from somebody else\'s link works', () => {
  // So an operator handed a failing link can see whose it was and when it
  // expired, instead of guessing.
  const doc = 'http://x/y/playlist.m3u8?wmsAuthSign=' +
    Buffer.from('server_time=5/4/2012 8:33:05 AM&hash_value=abc==&validminutes=20').toString('base64');
  assert.equal(readSignature(doc).server_time, '5/4/2012 8:33:05 AM');
  assert.equal(readSignature('http://x/y/playlist.m3u8'), null);
});

console.log('\nWHAT A SIGNED LINK IS BOUND TO:');

check('a link is bound to an IP, and says which', () => {
  // The viewer's address is in the hash, so a signed link is not universal.
  // The panel must say so rather than issuing one that works only for whoever
  // asked for it.
  const r = signUrl(URL0, { key: 'k', ip: '203.0.113.9' });
  assert.equal(r.boundToIp, '203.0.113.9');
});

check('an unbound link says it is unbound', () => {
  assert.equal(signUrl(URL0, { key: 'k' }).boundToIp, null);
});

check('the expiry is returned, not left to be worked out', () => {
  const at = new Date(Date.UTC(2026, 7, 12, 10, 0, 0));
  const r = signUrl(URL0, { key: 'k', validMinutes: 45, at });
  assert.equal(r.expiresAt, new Date(Date.UTC(2026, 7, 12, 10, 45, 0)).toISOString());
});

check('signing without a key is refused rather than producing a useless URL', () => {
  assert.throws(() => signUrl(URL0, {}), /key/);
});

console.log('\nWHAT DEFEATS THE PROTECTION ENTIRELY:');

check('HTTP Origin mode defeats a signature, and blocks', () => {
  // Softvelum's own paywall FAQ: an application listed under HTTP origin
  // applications is not protected by a WMSAuth signature. The same shape as
  // the cache interaction — a mode elsewhere quietly disabling something the
  // operator believes is on — and it earns the same blocking treatment.
  const b = tokenPreconditions({ application: 'test2', originApps: [{ application: 'test2' }] });
  assert.ok(b.includes('http-origin-defeats-token'));
});

check('an unrelated origin application does not block', () => {
  const b = tokenPreconditions({ application: 'test2', originApps: [{ application: 'other' }] });
  assert.deepEqual(b, []);
});

check('a clock adrift on an edge is surfaced', () => {
  // The rule compares its own time against the signature's within a tolerance.
  // A server minutes out refuses every link, and the cause is not in the link.
  const b = tokenPreconditions({ application: 'a', edges: [{ clockSkewSeconds: 300 }] });
  assert.ok(b.includes('clock-skew'));
});

console.log(failures ? `\n${failures} wmsauth check(s) failed` : '\nall wmsauth checks passed');
process.exit(failures ? 1 : 0);
