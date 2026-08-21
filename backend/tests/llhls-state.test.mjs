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
  assert.equal(s.wire.silentFallback, 'parts-only');
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

// --- the run itself, which used to be a held-open request -------------------
//
// These were appended to the end of this file and therefore sat *after*
// `process.exit`, so they never ran at all — and two diversions aimed at them
// changed nothing, which read as "the checks hold". A check that does not run
// is the purest form of a check that cannot fail.

import { readFileSync as rf } from 'node:fs';
import { fileURLToPath as fu } from 'node:url';
import { dirname as dn, join as jn } from 'node:path';
const routesSrc = rf(jn(dn(fu(import.meta.url)), '..', 'src', 'routes', 'llhls.js'), 'utf8');
const pageSrc = rf(jn(dn(fu(import.meta.url)), '..', '..', 'frontend', 'src', 'pages', 'LlhlsPage.jsx'), 'utf8');

check('applying starts a job instead of holding the request open', () => {
  // Installing certbot and issuing a certificate takes minutes. Held open,
  // whatever proxies the panel answered 504 at sixty seconds while the work
  // carried on underneath — the fourth time this project has done that.
  assert.match(routesSrc, /const jobId = createJob\(/);
  assert.match(routesSrc, /res\.json\(\{ jobId/);
  assert.match(routesSrc, /llhlsRouter\.get\('\/edges\/:id\/jobs\/:jobId'/,
    'nothing can be polled, so the job is as invisible as the held request was');
});

check('the browser follows the job rather than awaiting the work', () => {
  assert.match(pageSrc, /jobs\/\$\{started\.jobId\}/);
  assert.match(pageSrc, /if \(!started\.jobId\)/,
    'a response with no job would leave the screen waiting forever');
});

check('the bar counts answered steps, not elapsed time', () => {
  // A bar driven by a timer lies whenever the work is faster or slower than
  // whoever wrote the timer guessed.
  assert.match(pageSrc, /function progressOf/);
  assert.ok(!/setInterval|Date\.now\(\)/.test(pageSrc.slice(pageSrc.indexOf('function progressOf'),
                                                              pageSrc.indexOf('function progressOf') + 600)),
    'the progress bar is driven by a clock');
  assert.match(pageSrc, /Math\.min\(95/,
    'the bar reaches 100% while still running, which is worse than no bar');
});

check('a TLS port that refused a connection is a blocker, not an unknown', () => {
  // The probe threw, the route caught it, and `tls = null` drew the same `?`
  // as "nobody looked". A refused port and an unasked question have different
  // fixes.
  const s = edgeState({
    server: edge, conf: { content: CONF_ON },
    tls: { tls: false, http2: false, certTrusted: false, reached: false },
  });
  assert.ok(s.blockers.includes('tls-down'));
  assert.ok(!s.unknown.includes('tls'), 'a failed probe was filed as an unasked question');
  assert.equal(s.ready, false);
});

check('a port nobody probed is still unknown', () => {
  const s = edgeState({ server: edge, conf: { content: CONF_ON } });
  assert.ok(s.unknown.includes('tls'));
  assert.ok(!s.blockers.includes('tls-down'), 'not looking was reported as not working');
});

check('the detail route asks for a playlist when told what to watch', () => {
  assert.match(routesSrc, /req\.query\.stream/,
    'nothing ever fetches a playlist, so the parts column can only ever be `?`');
  assert.match(routesSrc, /playlist\.m3u8/);
  assert.match(routesSrc, /reached: false/,
    'a failed TLS probe is still handed in as silence');
});

check('probeTls is called the way it is declared', () => {
  // `probeTls(host, port)`, positional. Called as `probeTls({ host, port })`
  // the whole object landed in `options.host`, node threw before opening a
  // socket, and **every HTTP/2 probe this feature ever made failed without
  // touching the network** — on every machine, for four versions. The screen
  // showed `?`, then `✗`, and neither ever meant what it said.
  //
  // Fifth instance of the project's oldest failure class: a value used against
  // a shape it does not have.
  assert.ok(!/probeTls\(\s*\{/.test(routesSrc),
    'probeTls is being handed an object again; it takes (host, port)');
  assert.match(routesSrc, /probeTls\(host, sslPort\)/);
});

check('the certificate is read from the handshake, not from a path in a file', () => {
  // "путь задан" was all the panel could say: it read `ssl_certificate` out of
  // nimble.conf, which says where one should be — not whether it is there,
  // covers the name, or has time left.
  assert.match(routesSrc, /const certificate = tls\?\.tls \?/);
  assert.match(routesSrc, /certExpiresAt/);
  assert.match(routesSrc, /trusted: tls\.certTrusted === true/);
});

check('a playlist nobody fetched is not a playlist without parts', () => {
  // The sweep probes TLS and does not fetch a playlist unless a stream is
  // known. `verdict` counted the missing playlist as missing parts, so every
  // edge the sweep touched drew `✗` — "no parts" about a question nobody had
  // asked.
  const s = edgeState({
    server: edge, conf: { content: CONF_ON },
    tls: { tls: true, http2: true, certTrusted: true },
  });
  assert.equal(s.wire.partsUnknown, true);
  assert.ok(!s.wire.missing.includes('parts'), 'an unasked question was reported as a failure');
  assert.equal(s.ready, false, 'three of four became ready');
  assert.equal(s.wire.silentFallback, null,
    'the silent-fallback case was declared without a playlist to declare it from');
});

check('a playlist that was fetched and has no parts still fails', () => {
  const s = edgeState({
    server: edge, conf: { content: CONF_ON },
    tls: { tls: true, http2: true, certTrusted: true },
    playlist: { lowLatency: { confirmed: false } },
  });
  assert.notEqual(s.wire.partsUnknown, true);
  assert.ok(s.wire.missing.includes('parts'));
  assert.equal(s.wire.silentFallback, 'parts-only');
});

check('the panel finds a live stream instead of asking for one', () => {
  assert.match(routesSrc, /liveStreams\(cfg, server\.wmspanelServerId\)/);
  assert.match(routesSrc, /if \(!watch && server\.wmspanelServerId\)/,
    'an explicit choice must still win over the automatic one');
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall LL-HLS state checks passed');
process.exit(failures ? 1 : 0);
