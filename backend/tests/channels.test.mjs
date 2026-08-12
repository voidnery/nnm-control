// Channels and their links, iter21 m1.
//
// The panel had no object for "this stream is delivered by this network", so
// the question could not be answered about its own configuration and a link
// had nothing to hang on. These checks are mostly about what the two kinds of
// link are *for*: a production link goes through the policy and can move, a
// test link goes at one machine and must not.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { channelLinks } from '../src/services/channelLinks.js';
import { channelPath, channelName } from '../src/models/Channel.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

const CH = { application: 'test2', stream: 'test_stream', kind: 'production' };
const E = (name, over = {}) => ({
  name, host: `10.0.0.${name.length}`, httpPort: 8081, weight: 100,
  enabled: true, healthy: true, routes: ['test2'], lat: 55, lon: 37, ...over,
});
const RU2 = E('RU-2'), RU3 = E('RU-3'), FIN = E('FIN-1', { lat: 60, lon: 25 });
const net = (gateway = {}) => ({ name: 'prod', gateway: { mode: 'direct', policy: 'weighted', ...gateway } });

console.log('\nTHE PAIR IS THE IDENTITY:');

check('the path is application and stream', () => {
  assert.equal(channelPath(CH), '/test2/test_stream');
  assert.equal(channelPath({ application: '/a/', stream: '/b/' }), '/a/b');
});

check('a channel with no label is named by its path, not by nothing', () => {
  // A row with no name is a row nobody can act on.
  assert.equal(channelName(CH), 'test2/test_stream');
  assert.equal(channelName({ ...CH, label: 'Шахматы, корт 1' }), 'Шахматы, корт 1');
});

console.log('\nA TEST LINK GOES AT ONE MACHINE:');

check('there is one test link per edge, whatever the policy says', () => {
  // The question "does RU-3 serve this" cannot be asked of a link that might
  // resolve to RU-2.
  const l = channelLinks({ channel: CH, network: net({ policy: 'nearest' }), edges: [RU2, RU3, FIN] });
  assert.deepEqual(l.tests.map(t => t.edge), ['RU-2', 'RU-3', 'FIN-1']);
  assert.ok(l.tests.every(t => t.url.includes('/test2/test_stream/playlist.m3u8')));
});

check('a test link ignores the gateway entirely', () => {
  // Through a redirect gateway it would answer about the gateway, not the box.
  const l = channelLinks({
    channel: CH, network: net({ mode: 'redirect', domain: 'cdn.example.com' }),
    edges: [RU2], node: { host: 'gw.example.com' },
  });
  assert.match(l.tests[0].url, /^http:\/\/10\.0\.0\.4:8081\//);
  assert.ok(!l.tests[0].url.includes('cdn.example.com'));
});

check('an edge with no route for the channel is flagged, not silently offered', () => {
  // The link resolves and 404s, and the operator concludes the edge is broken.
  const l = channelLinks({ channel: CH, network: net(), edges: [RU2, E('X', { routes: ['other'] })] });
  assert.equal(l.tests[0].routed, true);
  assert.equal(l.tests[1].routed, false);
});

check('unknown routes are null, not false', () => {
  // "We did not read the routes" is not "there is no route".
  const l = channelLinks({ channel: CH, network: net(), edges: [E('Y', { routes: undefined })] });
  assert.equal(l.tests[0].routed, null);
});

console.log('\nA PRODUCTION LINK GOES THROUGH THE POLICY:');

check('it says which edge it resolved to, and why', () => {
  // A link under a policy is not a fixed address. Printing it as though it
  // were is how an operator debugs the wrong machine.
  const l = channelLinks({ channel: CH, network: net({ policy: 'nearest' }), edges: [RU2, FIN] });
  assert.ok(l.production.resolvedTo);
  assert.ok(l.production.reason);
  assert.equal(l.production.policy, 'nearest');
});

check('it carries what it reveals', () => {
  // Before pasting a URL into a chat with a partner, an operator should see
  // whether they are also pasting the address of their origin.
  const l = channelLinks({ channel: CH, network: net(), edges: [RU2] });
  assert.equal(l.production.exposes, 'edge-address');
  const named = channelLinks({
    channel: CH, network: net({ mode: 'proxy', domain: 'cdn.example.com' }),
    edges: [RU2], node: { host: 'gw' },
  });
  assert.equal(named.production.exposes, 'nothing');
});

check('a link that can move between viewers is marked as such', () => {
  const many = channelLinks({ channel: CH, network: net({ policy: 'nearest' }), edges: [RU2, RU3, FIN] });
  assert.equal(many.production.stable, false, 'three edges under a policy is not a fixed address');
  const one = channelLinks({ channel: CH, network: net(), edges: [RU2] });
  assert.equal(one.production.stable, true, 'one edge, direct mode: it cannot resolve elsewhere');
});

check('no healthy edge yields no link and the reason for it', () => {
  // Rather than an empty field the operator has to interpret.
  const l = channelLinks({ channel: CH, network: net(), edges: [E('D', { healthy: false })] });
  assert.equal(l.production, null);
  assert.equal(l.productionReason, 'no-healthy-edge');
  assert.equal(l.whenAllDown, 'fail');
});

check('the test links survive when the production link cannot be made', () => {
  // That is exactly the moment they are wanted: something is wrong and the
  // operator needs to ask each machine directly.
  const l = channelLinks({ channel: CH, network: net(), edges: [E('D', { healthy: false })] });
  assert.equal(l.tests.length, 1);
  assert.equal(l.tests[0].healthy, false);
});

console.log('\nTHE CHANNEL DECIDES THE URL:');

check('a DASH channel gets a manifest, not a playlist', () => {
  const l = channelLinks({ channel: { ...CH, protocol: 'dash' }, network: net(), edges: [RU2] });
  assert.match(l.production.url, /\/manifest\.mpd$/);
  assert.equal(l.production.protocol, 'dash');
});

check('an LL-HLS channel is addressed over TLS, on the TLS port', () => {
  // An http URL for LL-HLS is the silent-fallback trap; an https URL against
  // the plain port is a link that cannot connect at all.
  const tls = { ...RU2, httpsPort: 443,
                tls: { checkedAt: new Date(), tls: true, http2: true, certTrusted: true } };
  const l = channelLinks({ channel: { ...CH, protocol: 'llhls' }, network: net(), edges: [tls] });
  assert.match(l.production.url, /^https:\/\/[^:]+:443\//);
  assert.equal(l.production.protocolReady, true);
});

check('an edge that cannot carry the packaging says so on its own link', () => {
  // Rather than handing out a link that plays ordinary HLS while the operator
  // believes it is low latency.
  const l = channelLinks({ channel: { ...CH, protocol: 'llhls' }, network: net(), edges: [RU2] });
  // An edge nobody has probed: the panel says it has not asked, rather than
  // claiming the edge cannot do it.
  assert.equal(l.tests[0].protocolReady, false);
  assert.deepEqual(l.tests[0].protocolMissing, ['not-checked']);
});

check('an unverified path is flagged on the production link', () => {
  const l = channelLinks({ channel: { ...CH, protocol: 'dash' }, network: net(), edges: [RU2] });
  assert.equal(l.production.pathUnverified, true);
  const h = channelLinks({ channel: CH, network: net(), edges: [RU2] });
  assert.equal(h.production.pathUnverified, false);
});

console.log('\nNOTHING HERE TOUCHES A SERVER:');

check('links are computed from what was passed in', () => {
  // A link generator that reaches out mid-computation cannot be reasoned about
  // and cannot be tested without a fleet.
  const src = readFileSync(new URL('../src/services/channelLinks.js', import.meta.url), 'utf8');
  assert.ok(!/\bfetch\s*\(/.test(src));
  assert.ok(!/await /.test(src), 'the link generator awaits something');
});

console.log('\nTHE PANEL CAN ANSWER THE QUESTION NOW:');

const FRONT = new URL('../../frontend/src/', import.meta.url);
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const dash = strip(readFileSync(new URL('components/ChannelsPanel.jsx', FRONT), 'utf8'));
const deliv = strip(readFileSync(new URL('components/DeliveryRoutesPanel.jsx', FRONT), 'utf8'));
const dict = readFileSync(new URL('i18n.jsx', FRONT), 'utf8');

check('there is a row per channel showing its network', () => {
  // "Which streams go through which network" — the question that started this.
  assert.ok(/channels\/overview/.test(dash), 'the dashboard does not read the overview');
  assert.ok(/row\.network/.test(dash), 'the row does not show the network');
});

check('a channel delivered by nothing still gets a row', () => {
  // The state worth seeing before an event rather than during one.
  assert.ok(/not-delivered/.test(dash));
  assert.equal((dict.match(/'ch\.state\.not-delivered':/g) || []).length, 2);
});

check('every row state has a phrase, in both languages', () => {
  const states = [...new Set([...dash.matchAll(/'(serving|idle|partly-routed|no-edges|not-delivered)'/g)].map(m => m[1]))];
  assert.ok(states.length >= 4, `only ${states.length} states found`);
  for (const st of states) {
    assert.equal((dict.match(new RegExp(`'ch\\.state\\.${st}':`, 'g')) || []).length, 2, `ch.state.${st}`);
  }
});

check('a copy button tells the truth about whether it copied', () => {
  // navigator.clipboard is absent over plain HTTP. copyText reports what
  // happened; the toast has to follow it rather than assume.
  assert.ok(/await copyText\(url\)/.test(dash), 'the copy result is not awaited');
  assert.ok(/ch\.copyFailed/.test(dash), 'a failed copy is reported as a success');
});

check('a production link that can move says so', () => {
  assert.ok(/production\.stable/.test(dash), 'a policy result is presented as a fixed address');
  assert.ok(/ch\.resolvedTo/.test(dash), 'the row does not say which edge it currently resolves to');
});

console.log('\nTHE DELIVERY TAB STOPPED ASKING:');

check('applications come from stored channels, not a text box', () => {
  // They were typed in every visit and forgotten, which is why nothing could
  // list them and a link had nothing to hang on.
  assert.ok(!/setChannels/.test(deliv), 'the free-text application field is back');
  assert.ok(/api\('\/cdn\/channels'\)/.test(deliv), 'the tab does not read the channels');
});

check('the stream name is taken from the channel, not typed again', () => {
  // It was being asked for next to the place that already knew it.
  assert.ok(!/streamName/.test(deliv), 'the stream is still typed by hand');
  assert.ok(/\.find\(c => c\.application === application\)\?\.stream/.test(deliv),
    'the watch probe does not take the stream from the channel');
});

console.log(failures ? `\n${failures} channel check(s) failed` : '\nall channel checks passed');
process.exit(failures ? 1 : 0);
