// iter12 m1 — the inverted transport.
//
// The property under test is not "a task can be created" but the one the whole
// change exists for: an agent that accepts NO inbound connection can still be
// asked to do things. So the agent side here is a real outbound poller talking
// to a real gateway over real HTTP, with no listening socket on the agent at
// all.
import assert from 'node:assert/strict';
import express from 'express';
import { waitForTask, deliverResult, busStats, wake } from '../src/services/agentBus.js';

// The bus unrefs its timers so a parked agent never holds up a shutdown. That
// is right in production, where a live socket keeps the loop alive, and means
// a test with nothing else running would exit before the deadline fires.
const anchor = setInterval(() => {}, 1000);

let pass = 0, fail = 0;
const acheck = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
};

console.log('LONG-POLL WAITERS:');

await acheck('a parked agent is released the moment work appears for it', async () => {
  const t0 = Date.now();
  const parked = waitForTask('S1', 5000);
  setTimeout(() => wake('S1'), 20);
  await parked;
  const dt = Date.now() - t0;
  assert.ok(dt < 1000, `released after ${dt}ms — it waited for the deadline instead of the wake`);
});

await acheck('work for another server does not release it', async () => {
  const parked = waitForTask('S2', 300);
  wake('S-somebody-else');
  const early = await Promise.race([parked.then(() => 'released'), new Promise(r => setTimeout(() => r('still parked'), 120))]);
  assert.equal(early, 'still parked');
  await parked;
});

await acheck('a waiter with nothing to do releases at its deadline, not never', async () => {
  const t0 = Date.now();
  await waitForTask('S-idle', 60);
  const dt = Date.now() - t0;
  assert.ok(dt >= 50 && dt < 1000, `released after ${dt}ms`);
});

await acheck('a result for an unknown task is dropped, not thrown', async () => {
  deliverResult('no-such-task', { result: 1 });
  assert.equal(busStats().pendingResults, 0);
});

console.log('\nROUND TRIP (agent has no listening socket):');

// A minimal stand-in for the gateway: same contract, no database.
function gateway() {
  const app = express();
  app.use(express.json());
  const queue = [];
  const results = new Map();
  const contacts = [];
  const state = { down: false };

  app.post('/api/agent-gw/poll', async (req, res) => {
    if (state.down) return res.status(503).json({ error: 'panel is down' });
    if (req.headers.authorization !== 'Bearer good-token') return res.status(401).json({ error: 'unauthorized' });
    contacts.push({ at: Date.now(), instanceId: req.body.instanceId, health: req.body.health });
    const t0 = Date.now();
    while (!queue.length && Date.now() - t0 < 800) await new Promise(r => setTimeout(r, 10));
    res.json({ task: queue.shift() || null });
  });
  app.post('/api/agent-gw/task/:id/result', (req, res) => {
    if (req.headers.authorization !== 'Bearer good-token') return res.status(401).json({ error: 'unauthorized' });
    results.set(req.params.id, req.body);
    res.json({ ok: true });
  });
  return { app, queue, results, contacts, get down() { return state.down; }, set down(v) { state.down = v; } };
}

// The agent side, written the way the real one is: outbound only.
function poller(base, token, handlers) {
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        const r = await fetch(`${base}/api/agent-gw/poll`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ instanceId: 'inst-1', version: 3, health: { ok: true } }),
        });
        if (!r.ok) { await new Promise(x => setTimeout(x, 20)); continue; }
        const { task } = await r.json();
        if (!task) continue;
        let payload;
        try { payload = { ok: true, result: await handlers[task.route](task) }; }
        catch (e) { payload = { ok: false, error: e.message }; }
        await fetch(`${base}/api/agent-gw/task/${task.id}/result`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        });
      } catch { await new Promise(x => setTimeout(x, 20)); }
    }
  })();
  return { stop: async () => { stop = true; await loop; } };
}

const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('timed out waiting for the condition');
};

await acheck('a task queued by the panel is executed and answered', async () => {
  const gw = gateway();
  const srv = gw.app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const agent = poller(base, 'good-token', { 'GET /health': async () => ({ ok: true, version: 3 }) });
  try {
    gw.queue.push({ id: 't1', route: 'GET /health', query: null, body: null });
    const r = await waitFor(() => gw.results.get('t1'));
    assert.equal(r.ok, true);
    assert.deepEqual(r.result, { ok: true, version: 3 });
  } finally { await agent.stop(); srv.close(); }
});

await acheck('every poll doubles as a heartbeat', async () => {
  const gw = gateway();
  const srv = gw.app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const agent = poller(base, 'good-token', {});
  try {
    await waitFor(() => gw.contacts.length > 0);
    const c = gw.contacts[0];
    assert.equal(c.instanceId, 'inst-1');
    assert.deepEqual(c.health, { ok: true });
  } finally { await agent.stop(); srv.close(); }
});

await acheck('a failing handler reports the error instead of going silent', async () => {
  const gw = gateway();
  const srv = gw.app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const agent = poller(base, 'good-token', {
    'GET /config': async () => { throw new Error('no such file'); },
  });
  try {
    gw.queue.push({ id: 't2', route: 'GET /config', query: { name: 'gone.json' }, body: null });
    const r = await waitFor(() => gw.results.get('t2'));
    assert.equal(r.ok, false);
    assert.match(r.error, /no such file/);
  } finally { await agent.stop(); srv.close(); }
});

await acheck('a wrong token gets no work, and the agent keeps trying', async () => {
  const gw = gateway();
  const srv = gw.app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const agent = poller(base, 'wrong-token', { 'GET /health': async () => ({ ok: true }) });
  try {
    gw.queue.push({ id: 't3', route: 'GET /health', query: null, body: null });
    await new Promise(r => setTimeout(r, 300));
    assert.equal(gw.results.has('t3'), false, 'an unauthenticated agent must not receive tasks');
    assert.equal(gw.queue.length, 1, 'the task must stay queued');
  } finally { await agent.stop(); srv.close(); }
});

await acheck('the panel going away does not kill the agent', async () => {
  // Simulated by the panel refusing service rather than by closing the socket:
  // the property under test is that the agent keeps trying and recovers on its
  // own, and reusing a TCP port mid-test would only be testing the test.
  const gw = gateway();
  gw.down = true;
  const srv = gw.app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const agent = poller(base, 'good-token', { 'GET /health': async () => ({ ok: true }) });
  try {
    await new Promise(r => setTimeout(r, 200));
    assert.equal(gw.contacts.length, 0, 'nothing should have got through while the panel was down');
    gw.down = false;
    gw.queue.push({ id: 't4', route: 'GET /health', query: null, body: null });
    const r = await waitFor(() => gw.results.get('t4'), 4000);
    assert.equal(r.ok, true, 'the agent must reconnect on its own, with no restart');
  } finally { await agent.stop(); srv.close(); }
});

console.log('\nAGENT SHAPE:');

await acheck('the agent needs no inbound reachability to be useful', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('NNM_AGENT_PANEL_URL'), 'must know where the panel is');
  assert.ok(src.includes('NNM_AGENT_SERVER_ID'), 'must know who it is');
  assert.ok(src.includes('pollLoop'), 'must have an outbound loop');
  // The dispatch surface must stay single: a task names a route the local
  // server already exposes, so there is no second list to drift.
  assert.ok(src.includes('routes[task.route]'), 'tasks must dispatch through the existing route table');
});

clearInterval(anchor);
// iter12 m5 — the pull path is gone, and must stay gone. Every one of these
// is a way the old direction could creep back: an address field on the server,
// a client that dials agents, or an agent listening on the network for a
// caller that no longer exists.
console.log('\nNO WAY BACK:');

const read = async (rel) => {
  const { readFileSync } = await import('node:fs');
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
};

await acheck('there is no client for dialling agents', async () => {
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(new URL('../src/services/agentClient.js', import.meta.url)), false,
    'agentClient.js is the pull path — it must not exist');
});

await acheck('the server record holds no address for its agent', async () => {
  const model = await read('../src/models/NimbleServer.js');
  const agentBlock = model.slice(model.indexOf('agent: {'), model.indexOf('logTzOffsetMinutes'));
  assert.ok(!/baseUrl/.test(agentBlock), 'an address field is how the panel starts dialling out again');
});

await acheck('nothing in the backend reaches for an agent address', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const roots = ['../src/routes', '../src/services'];
  const offenders = [];
  for (const r of roots) {
    const dir = new URL(r + '/', import.meta.url);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const src = readFileSync(new URL(f, dir), 'utf8');
      // wmspanel has its own baseUrl and express has req.baseUrl; neither is
      // an agent address.
      for (const line of src.split('\n')) {
        if (/agent\.baseUrl|agent\?\.baseUrl/.test(line)) offenders.push(`${r}/${f}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

await acheck('the agent listens on loopback, not on the network', async () => {
  const src = await read('../src/assets/nnm-agent.mjs');
  assert.match(src, /NNM_AGENT_BIND \|\| '127\.0\.0\.1'/,
    'nothing connects to the agent any more, so a socket on the network is surface with no purpose');
});

await acheck('the installer asks for no address of the server', async () => {
  const { installScript } = await import('../src/services/agentInstaller.js');
  const script = installScript({ panelUrl: 'https://p.example', ticket: 'a'.repeat(64) });
  assert.ok(!script.includes('BASE_URL'), 'the installer must not carry an agent address');
  assert.ok(!script.includes('hostname -I'), 'nor try to guess one from the box');
  assert.ok(script.includes('NNM_AGENT_PANEL_URL'), 'only the direction that is actually used');
});

clearInterval(anchor);
process.exit(fail ? 1 : 0);
