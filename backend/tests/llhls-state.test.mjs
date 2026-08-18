// What the panel tells an operator about LL-HLS on an edge.
//
// The distinction this file exists to protect: **not asked** is not **asked
// and failed**. The first version of the protocol readiness in this project
// collapsed the two, so an edge nobody had probed appeared as an edge that
// could not do LL-HLS — and the fix for one of those is a button and the fix
// for the other is a certificate.
//
// And the second: three of the four conditions is not "nearly working". A
// player gets ordinary HLS and nobody is told, which is the exact failure the
// whole feature exists to prevent.

import assert from 'node:assert/strict';
import { edgeState, channelPlan, CERT_WARN_DAYS } from '../src/services/llhlsState.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

console.log('LL-HLS state\n');

const CONF_OFF = `port = 8081
client_id = abc
api_key = def
`;
const CONF_ON = `port = 8081
ssl_port = 8443
ssl_certificate = /etc/letsencrypt/live/e/fullchain.pem
ssl_certificate_key = /etc/letsencrypt/live/e/privkey.pem
ssl_http2_enabled = true
`;
// `nimble-cdn`, because that is what a delivery edge is since v1.17.0, and
// `helper.seen`, because that is where the helper's own record lives — the
// field this used to set, `agent.privileged`, exists in no schema.
const edge = { name: 'RU-2', purpose: 'nimble-cdn', agent: { enabled: true, lastContactAt: new Date() },
               helper: { seen: true, lastContactAt: new Date() } };

// --- not asked is its own answer --------------------------------------------

check('an edge nobody has probed is unknown, not incapable', () => {
  const s = edgeState({ server: { name: 'x', purpose: 'nimble-cdn' } });
  assert.equal(s.ready, null, 'an unprobed edge was reported as not ready');
  assert.deepEqual(s.blockers, [], 'an unprobed edge was given blockers it has not been shown to have');
  assert.deepEqual(s.unknown.sort(), ['certificate', 'helper', 'nimble-conf', 'playlist', 'tls']);
});

check('a machine whose agent has never answered does not claim the helper is missing', () => {
  const s = edgeState({ server: { name: 'x', purpose: 'nimble-cdn', agent: {} } });
  assert.equal(s.helper.installed, null);
  assert.ok(!s.blockers.includes('helper-not-installed'));
  assert.ok(s.unknown.includes('helper'));
});

check('a machine that answered and has no helper is a blocker, not an unknown', () => {
  const s = edgeState({ server: { name: 'x', purpose: 'nimble-cdn',
                                  agent: { lastContactAt: new Date() } } });
  assert.ok(s.blockers.includes('helper-not-installed'));
  assert.ok(!s.unknown.includes('helper'));
});

// --- reading the configuration ----------------------------------------------

check('a configuration with no TLS reads as off, with the certificate named missing', () => {
  const s = edgeState({ server: edge, conf: { content: CONF_OFF } });
  assert.equal(s.transport.configured, false);
  assert.equal(s.transport.http2, false);
  assert.equal(s.transport.httpPort, '8081');
  assert.ok(s.blockers.includes('no-certificate-configured'));
  assert.ok(s.blockers.includes('http2-off'));
});

check('a configured edge reads its ports and paths back', () => {
  const s = edgeState({ server: edge, conf: { content: CONF_ON } });
  assert.equal(s.transport.configured, true);
  assert.equal(s.transport.sslPort, '8443');
  assert.equal(s.transport.certPath, '/etc/letsencrypt/live/e/fullchain.pem');
  assert.deepEqual(s.blockers, []);
});

check('a commented-out ssl_http2_enabled does not read as on', () => {
  const s = edgeState({ server: edge, conf: { content: CONF_ON.replace('ssl_http2_enabled', '# ssl_http2_enabled') } });
  assert.equal(s.transport.http2, false,
    'a comment was read as configuration and the edge would be reported ready');
  assert.ok(s.blockers.includes('http2-off'));
});

// --- the wire ---------------------------------------------------------------

check('everything configured and no parts on the wire is not ready', () => {
  const s = edgeState({
    server: edge, conf: { content: CONF_ON },
    tls: { tls: true, http2: true, certTrusted: true },
    playlist: { lowLatency: { confirmed: false } },
  });
  assert.equal(s.ready, false, 'three of four was reported as working');
  assert.deepEqual(s.wire.missing, ['parts']);
  assert.match(s.wire.silentFallback, /WMSPanel half is off/);
});

check('all four together is the only pass', () => {
  const s = edgeState({
    server: edge, conf: { content: CONF_ON },
    tls: { tls: true, http2: true, certTrusted: true },
    playlist: { lowLatency: { confirmed: true } },
  });
  assert.equal(s.ready, true);
  assert.deepEqual(s.blockers, []);
});

check('a handshake that succeeded with an untrusted certificate is a blocker', () => {
  const s = edgeState({
    server: edge, conf: { content: CONF_ON },
    tls: { tls: true, http2: true, certTrusted: false },
    playlist: { lowLatency: { confirmed: true } },
  });
  assert.ok(s.blockers.includes('certificate-not-trusted'),
    'we pass rejectUnauthorized:false and a player does not');
  assert.equal(s.ready, false);
});

// --- the certificate clock --------------------------------------------------

check('an expiring certificate warns outside certbot\'s own renewal window', () => {
  const now = new Date('2026-08-17T00:00:00Z');
  const soon = new Date(now.getTime() + 10 * 86400000).toISOString();
  const later = new Date(now.getTime() + 60 * 86400000).toISOString();
  assert.equal(edgeState({ server: edge, certificate: { validTo: soon }, now }).certificate.expiring, true);
  assert.equal(edgeState({ server: edge, certificate: { validTo: later }, now }).certificate.expiring, false);
  // certbot renews at 30 days; warning at 30 would fire on every healthy
  // machine for a month and be ignored by the second week.
  assert.ok(CERT_WARN_DAYS < 30);
});

check('an expired certificate is a blocker and not merely expiring', () => {
  const now = new Date('2026-08-17T00:00:00Z');
  const past = new Date(now.getTime() - 86400000).toISOString();
  const s = edgeState({ server: edge, certificate: { validTo: past }, now });
  assert.equal(s.certificate.expired, true);
  assert.equal(s.certificate.expiring, false);
  assert.ok(s.blockers.includes('certificate-expired'));
});

// --- a gateway asked about LL-HLS -------------------------------------------

check('a gateway is told it is the wrong kind of machine', () => {
  const s = edgeState({ server: { name: 'gw', purpose: 'gateway', agent: { privileged: true } } });
  assert.equal(s.helper.appropriate, false);
  assert.ok(s.blockers.includes('not-an-edge'));
});

// --- the channel half -------------------------------------------------------

const app6 = { application: 'live', chunk_duration: 6, protocols: ['HLS', 'RTMP'] };

check('the recommended part at the fleet\'s chunk is accepted', () => {
  const p = channelPlan({ channel: {}, application: app6, partMs: 2000, transportReady: true });
  assert.equal(p.ok, true, JSON.stringify(p.problems));
  assert.deepEqual(p.partRange, { min: 500, max: 3000 });
  assert.equal(p.latency.seconds, '~6');
});

check('a part outside the range is refused rather than clamped', () => {
  // Clamping would apply something the operator did not ask for and report
  // success, which is the shape this project keeps finding.
  assert.ok(channelPlan({ channel: {}, application: app6, partMs: 4000 }).problems.includes('part-outside-range'));
  assert.ok(channelPlan({ channel: {}, application: app6, partMs: 100 }).problems.includes('part-outside-range'));
});

check('a sub-second chunk is named as the reason, not reported as a bad part', () => {
  const p = channelPlan({ channel: {}, application: { ...app6, chunk_duration: 0.5 }, partMs: 500 });
  assert.ok(p.problems.includes('chunk-below-one-second'));
});

check('an application with no HLS cannot carry LL-HLS at all', () => {
  const p = channelPlan({ channel: {}, application: { ...app6, protocols: ['RTMP'] }, partMs: 2000 });
  assert.ok(p.problems.includes('container-cannot-carry-llhls'));
});

check('switching to fMP4 is warned about as a removal, because that is what it is', () => {
  const p = channelPlan({ channel: {}, application: app6, partMs: 2000, transportReady: true });
  assert.ok(p.warnings.some(w => /removes plain HLS/.test(w)),
    'the container switch was presented as an addition');
  const already = channelPlan({ channel: {}, application: { ...app6, protocols: ['HLS_FMP4'] },
                                partMs: 2000, transportReady: true });
  assert.ok(!already.warnings.some(w => /removes plain HLS/.test(w)),
    'an application already on fMP4 was warned about a switch it does not need');
});

check('the restart nothing can do for us is stated every time', () => {
  const p = channelPlan({ channel: {}, application: app6, partMs: 2000, transportReady: true });
  assert.equal(p.halves.application.restartRequired, true);
});

check('turning this on with the transport not ready is warned about', () => {
  const p = channelPlan({ channel: {}, application: app6, partMs: 2000, transportReady: false });
  assert.ok(p.warnings.some(w => /viewer who sees ordinary HLS/.test(w)));
  const ready = channelPlan({ channel: {}, application: app6, partMs: 2000, transportReady: true });
  assert.ok(!ready.warnings.some(w => /viewer who sees ordinary HLS/.test(w)));
});

check('the shortest legal part carries its cost rather than looking like the best choice', () => {
  const p = channelPlan({ channel: {}, application: app6, partMs: 500, transportReady: true });
  assert.ok(p.warnings.some(w => /bandwidth and CPU/.test(w)));
});

check('a missing application is a problem, not an empty plan', () => {
  const p = channelPlan({ channel: {}, application: null, partMs: 2000 });
  assert.equal(p.ok, false);
  assert.ok(p.problems.includes('application-not-found'));
  assert.equal(p.halves.application.write, null);
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall LL-HLS state checks passed');
process.exit(failures ? 1 : 0);
