// Which URL a viewer is given, iter21 m5.
//
// The panel had HLS hard-coded in three places and called it "the playlist".
// The fleet's own log shows Nimble emitting HLS *and* DASH from one input at
// the same moment, so the choice was always available and simply not offered.
//
// LL-HLS is the case worth being careful about: it needs HTTP/2 over TLS, and
// without them a player silently falls back to ordinary HLS. It plays. The
// operator sees video and believes they have low latency while watching
// 6-second segments — which is why the check refuses rather than warns.
import assert from 'node:assert/strict';
import { PROTOCOLS, playbackPath, protocolReadiness } from '../src/services/protocols.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

console.log('\nEACH PACKAGING HAS ITS OWN URL:');

check('HLS is the playlist the panel has always probed', () => {
  assert.equal(playbackPath('hls', 'test2', 'main'), '/test2/main/playlist.m3u8');
});

check('DASH is a manifest, not a playlist', () => {
  assert.equal(playbackPath('dash', 'test2', 'main'), '/test2/main/manifest.mpd');
});

check('LL-HLS shares the HLS path and differs in transport', () => {
  // Same file, different scheme. Getting this backwards would produce a URL
  // that 404s instead of one that falls back.
  assert.equal(playbackPath('llhls', 'test2', 'main'), '/test2/main/playlist.m3u8');
  assert.equal(PROTOCOLS.llhls.scheme, 'https');
  assert.equal(PROTOCOLS.hls.scheme, 'http');
});

check('an unknown protocol falls back to HLS rather than producing nothing', () => {
  assert.equal(playbackPath('quic-magic', 'a', 'b'), '/a/b/playlist.m3u8');
});

check('paths taken from documentation are marked as unconfirmed', () => {
  // The `to` field of a route was built from documentation and rejected by the
  // live API. A shape nobody has seen a response for gets said so.
  assert.equal(PROTOCOLS.dash.pathUnverified, true);
  assert.notEqual(PROTOCOLS.hls.pathUnverified, true, 'HLS is confirmed by every probe run so far');
});

console.log('\nLL-HLS IS REFUSED, NOT WARNED ABOUT:');

check('an edge nobody has asked is "not checked", not "cannot"', () => {
  // Two different sentences and two different next actions: one is fixed by
  // pressing check, the other by configuring a server.
  const r = protocolReadiness('llhls', { host: '10.0.0.2', httpPort: 8081 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['not-checked']);
  assert.equal(r.notChecked, true);
});

check('an edge checked and found without TLS cannot serve LL-HLS', () => {
  const checked = { tls: { checkedAt: new Date(), tls: false, http2: false } };
  const r = protocolReadiness('llhls', checked);
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes('tls'));
});

check('TLS alone is not enough, and the panel knows because it asked', () => {
  // The configuration that produces the silent fallback: a working https URL,
  // a playing video, and no low latency anywhere.
  const tlsOnly = { tls: { checkedAt: new Date(), tls: true, http2: false, certTrusted: true } };
  assert.deepEqual(protocolReadiness('llhls', tlsOnly).missing, ['http2']);
});

check('a certificate a browser would refuse is a delivery failure', () => {
  // The probe passes rejectUnauthorized: false to learn the ALPN answer; a
  // player does not, and would simply not play.
  const untrusted = { tls: { checkedAt: new Date(), tls: true, http2: true, certTrusted: false } };
  assert.deepEqual(protocolReadiness('llhls', untrusted).missing, ['cert']);
});

check('with everything confirmed it is allowed', () => {
  const ready = { tls: { checkedAt: new Date(), tls: true, http2: true, certTrusted: true } };
  assert.deepEqual(protocolReadiness('llhls', ready), { ok: true, missing: [] });
});

check('HLS and DASH need nothing and are always allowed', () => {
  const plain = { host: '10.0.0.2', httpPort: 8081 };
  assert.equal(protocolReadiness('hls', plain).ok, true);
  assert.equal(protocolReadiness('dash', plain).ok, true);
});

console.log('\nWHAT THE FLEET LOG ALREADY PROVES:');

check('both cacheable containers are offered, because both already exist', () => {
  // add_dash_segment and add HLS chunk, on one stream, in the same second,
  // with no configuration for either in nimble.conf. Choosing between them
  // costs nothing on the server.
  assert.equal(PROTOCOLS.hls.cacheable, true);
  assert.equal(PROTOCOLS.dash.cacheable, true);
  assert.deepEqual(PROTOCOLS.dash.requires, []);
});

console.log(failures ? `\n${failures} protocol check(s) failed` : '\nall protocol checks passed');
process.exit(failures ? 1 : 0);
