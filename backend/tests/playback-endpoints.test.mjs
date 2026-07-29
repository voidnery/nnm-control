// iter9 m2 — playback endpoint resolution.
//
// The point of these checks is not that a URL gets built (that is the
// frontend's audit) but that the panel never presents an assumption as a
// measurement. Every case that ends in a default must say so in `notes` and
// in the per-endpoint *Origin fields, because the operator's next action is
// to copy the URL somewhere it has to actually work.
import assert from 'node:assert/strict';
import {
  collectHosts, pickRtmpPort, resolveHttpPort,
  resolvePlaybackEndpoints, invalidatePlaybackCache,
  DEFAULT_HTTP_PORT, DEFAULT_RTMP_PORT,
} from '../src/services/playbackEndpoints.js';
import { wmspanel } from '../src/services/wmspanelClient.js';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
};
const acheck = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
};

console.log('HOST RANKING (what a viewer should be handed first):');

check('operator-declared custom_ips come before detected addresses', () => {
  const h = collectHosts({ custom_ips: ['cdn.example.com'], ip: ['10.0.0.5'] }, 'fallback');
  assert.equal(h[0], 'cdn.example.com');
});

check('IPv4 outranks IPv6 — v6 is present but unroutable on some fleets', () => {
  const h = collectHosts({ custom_ips: [], ip: ['2001:db8::1', '10.0.0.5'] }, '');
  assert.deepEqual(h, ['10.0.0.5', '2001:db8::1']);
});

check('the panel record is a fallback, not a duplicate', () => {
  const h = collectHosts({ custom_ips: ['a.example.com'], ip: [] }, 'a.example.com');
  assert.deepEqual(h, ['a.example.com']);
});

check('empty WMSPanel data still yields the panel record', () => {
  assert.deepEqual(collectHosts(null, '10.0.0.9'), ['10.0.0.9']);
});

console.log('\nRTMP PORT (read, not guessed):');

check('port is taken from the real interface list', () => {
  const r = pickRtmpPort([{ ip: '0.0.0.0', port: 1940, ssl: false }]);
  assert.equal(r.port, 1940);
  assert.equal(r.origin, 'api');
});

check('a plain interface is preferred over an SSL one', () => {
  const r = pickRtmpPort([{ port: 1936, ssl: true }, { port: 1935, ssl: false }]);
  assert.equal(r.port, 1935);
});

check('extra ports are reported rather than silently dropped', () => {
  const r = pickRtmpPort([{ port: 1935, ssl: false }, { port: 1940, ssl: false }]);
  assert.deepEqual(r.alternatives, [1940]);
});

check('no interfaces -> default, flagged as a default', () => {
  const r = pickRtmpPort([]);
  assert.equal(r.port, DEFAULT_RTMP_PORT);
  assert.equal(r.origin, 'default');
});

check('malformed entries do not become port 0', () => {
  const r = pickRtmpPort([{ ip: 'x' }, { port: 'nonsense' }]);
  assert.equal(r.port, DEFAULT_RTMP_PORT);
  assert.equal(r.origin, 'default');
});

console.log('\nHTTP PORT (the one value no API reports):');

check('operator-set port is marked configured', () => {
  assert.deepEqual(resolveHttpPort({ httpPort: 8090 }), { port: 8090, origin: 'configured' });
});

check('unset falls back to the documented default and admits it', () => {
  assert.deepEqual(resolveHttpPort({}), { port: DEFAULT_HTTP_PORT, origin: 'default' });
});

console.log('\nRESOLUTION:');

const cfg = { clientId: 'x', apiKey: 'y', baseUrl: 'https://api.wmspanel.com/v1' };
const srv = (extra = {}) => ({ id: 'S' + Math.random(), host: '10.0.0.1', wmspanelServerId: 'w1', playbackEndpoints: [], ...extra });

await acheck('a hand-entered endpoint overrides everything and costs no API call', async () => {
  invalidatePlaybackCache();
  const r = await resolvePlaybackEndpoints(
    srv({ playbackEndpoints: [{ host: 'manual.example.com', hlsPort: 9000, rtmpPort: 1999, ssl: true }] }), cfg);
  assert.equal(r.source, 'manual');
  assert.equal(r.apiCalls, 0);
  assert.equal(r.endpoints[0].host, 'manual.example.com');
  assert.equal(r.endpoints[0].httpPort, 9000);
  assert.equal(r.endpoints[0].httpPortOrigin, 'manual');
});

await acheck('native plane / unmapped server degrades to the panel record, marked', async () => {
  invalidatePlaybackCache();
  const r = await resolvePlaybackEndpoints(srv({ wmspanelServerId: '' }), null);
  assert.equal(r.source, 'panel');
  assert.equal(r.endpoints[0].host, '10.0.0.1');
  assert.equal(r.endpoints[0].rtmpPortOrigin, 'default');
  assert.ok(r.notes.includes('rtmpPortAssumed'));
});

await acheck('a server with no address at all resolves to nothing, not to a broken URL', async () => {
  invalidatePlaybackCache();
  const r = await resolvePlaybackEndpoints(srv({ wmspanelServerId: '', host: '' }), null);
  assert.equal(r.endpoints.length, 0);
  assert.ok(r.notes.includes('noHost'));
});

await acheck('full WMSPanel path: hosts and RTMP port both come from the API', async () => {
  invalidatePlaybackCache();
  const orig = { getServer: wmspanel.getServer, rtmpInterfaceList: wmspanel.rtmpInterfaceList };
  wmspanel.getServer = async () => ({ custom_ips: ['edge1.bbesport.com'], ip: ['185.1.2.3'] });
  wmspanel.rtmpInterfaceList = async () => ({ interfaces: [{ ip: '0.0.0.0', port: 1940, ssl: false }] });
  try {
    const r = await resolvePlaybackEndpoints(srv({ httpPort: 8085 }), cfg);
    assert.equal(r.source, 'wmspanel');
    assert.equal(r.apiCalls, 2);
    assert.equal(r.endpoints[0].host, 'edge1.bbesport.com');
    assert.equal(r.endpoints[0].rtmpPort, 1940);
    assert.equal(r.endpoints[0].rtmpPortOrigin, 'api');
    assert.equal(r.endpoints[0].httpPort, 8085);
    assert.equal(r.endpoints[0].httpPortOrigin, 'configured');
    assert.deepEqual(r.notes, []);
  } finally { Object.assign(wmspanel, orig); }
});

await acheck('one failing upstream call does not sink the other', async () => {
  invalidatePlaybackCache();
  const orig = { getServer: wmspanel.getServer, rtmpInterfaceList: wmspanel.rtmpInterfaceList };
  wmspanel.getServer = async () => ({ custom_ips: ['edge1.bbesport.com'], ip: [] });
  wmspanel.rtmpInterfaceList = async () => { throw new Error('quota exceeded'); };
  try {
    const r = await resolvePlaybackEndpoints(srv(), cfg);
    assert.equal(r.endpoints[0].host, 'edge1.bbesport.com');
    assert.ok(r.notes.includes('interfaceLookupFailed'));
    assert.ok(r.notes.includes('rtmpPortAssumed'));
  } finally { Object.assign(wmspanel, orig); }
});

await acheck('an unset HTTP port is flagged even when everything else was read', async () => {
  invalidatePlaybackCache();
  const orig = { getServer: wmspanel.getServer, rtmpInterfaceList: wmspanel.rtmpInterfaceList };
  wmspanel.getServer = async () => ({ custom_ips: ['edge1'], ip: [] });
  wmspanel.rtmpInterfaceList = async () => ({ interfaces: [{ port: 1935, ssl: false }] });
  try {
    const r = await resolvePlaybackEndpoints(srv(), cfg);
    assert.equal(r.endpoints[0].httpPort, DEFAULT_HTTP_PORT);
    assert.ok(r.notes.includes('httpPortAssumed'));
  } finally { Object.assign(wmspanel, orig); }
});

await acheck('the cache spends the API budget once, not per screen paint', async () => {
  invalidatePlaybackCache();
  const orig = { getServer: wmspanel.getServer, rtmpInterfaceList: wmspanel.rtmpInterfaceList };
  let calls = 0;
  wmspanel.getServer = async () => { calls++; return { custom_ips: ['e'], ip: [] }; };
  wmspanel.rtmpInterfaceList = async () => { calls++; return { interfaces: [] }; };
  try {
    const s = srv();
    await resolvePlaybackEndpoints(s, cfg);
    const second = await resolvePlaybackEndpoints(s, cfg);
    assert.equal(calls, 2, 'second resolution must not hit the API');
    assert.equal(second.cached, true);
    await resolvePlaybackEndpoints(s, cfg, { fresh: true });
    assert.equal(calls, 4, 'fresh=1 must bypass the cache');
  } finally { Object.assign(wmspanel, orig); }
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : '\nall playback-endpoint checks passed');
process.exit(fail ? 1 : 0);
