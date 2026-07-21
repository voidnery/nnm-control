import { Settings } from '../models/Settings.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { FunctionRun } from '../models/FunctionRun.js';
import { wmspanel } from './wmspanelClient.js';
import { logEvent } from './audit.js';

// Transactional executor for engineering functions.
//
// Per-step primitive for 'patch' steps:
//   1. GET the object; snapshot ONLY the keys present in the patch
//   2. PUT the patch
//   3. VERIFY: poll GET until all patched keys equal desired values.
//      WMSPanel delivers settings to Nimble on its ~30s sync-up, so the
//      verify window is generous (default 120s, poll every 5s).
//   4. On any step failure: roll back all previously completed steps in
//      reverse order by PUTting their snapshots (actions: pause<->resume
//      inverse; restart/delay: nothing to roll back).
//
// All state transitions are persisted immediately so the UI can poll the run
// and animate step progress live.

const VERIFY_TIMEOUT_MS = 180_000;
const VERIFY_POLL_MS = 5_000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const KIND_OPS = {
  republish: { get: 'republishList', put: 'republishUpdate', pickList: d => d.rules || d.republish_rules || [] },
  udp:       { get: 'udpList',       put: 'udpUpdate',       pickList: d => d.settings || [] },
  outgoing:  { get: 'outgoingList',  put: 'outgoingUpdate',  pickList: d => d.streams || d.settings || [] },
  hotswap:   { get: 'hotswapList',   put: 'hotswapUpdate',   pickList: d => d.settings || [] },
  live_pull: { get: 'livePullList',  put: 'livePullUpdate',  pickList: d => d.settings || [] },
  // account-level: sid is ignored by the client methods
  transcoder: { get: 'transcoderList', put: 'transcoderUpdate', pickList: d => d.transcoders || [] },
};

async function getObject(cfg, kind, sid, targetId) {
  // List-then-find: single-object GET shapes vary; list shapes are confirmed.
  const ops = KIND_OPS[kind];
  const data = await wmspanel[ops.get](cfg, sid);
  const obj = ops.pickList(data).find(o => String(o.id) === String(targetId));
  if (!obj) throw new Error(`${kind} object ${targetId} not found on WMSPanel server ${sid}`);
  return obj;
}

// Deep-tolerant comparison: primitives via String() (WMSPanel mixes "false"
// and false), objects/arrays via canonical JSON (source_streams is an array
// of objects — String() would falsely equal '[object Object]').
function valueEq(a, b) {
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return String(a) === String(b);
}
function valuesMatch(obj, patch) {
  return Object.keys(patch).every(k => valueEq(obj[k], patch[k]));
}

// Poll until the object's patched keys reflect desired values. Transient GET
// errors do not abort the step — only the deadline does. On timeout the error
// carries the LAST SEEN values of the patched keys: if WMSPanel names a field
// differently than the patch, this makes it immediately visible in the trace.
async function verifyPatched(cfg, kind, sid, targetId, want) {
  // Outgoing streams expose their own delivery confirmation: status becomes
  // 'synced' once WMSPanel has delivered the config to the Nimble instance —
  // stronger than field comparison alone, so we require it for that kind.
  const requireSynced = kind === 'outgoing';
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  let lastSeen = null, lastErr = null;
  for (;;) {
    try {
      const obj = await getObject(cfg, kind, sid, targetId);
      lastSeen = {};
      for (const k of Object.keys(want)) lastSeen[k] = obj[k] ?? null;
      if (requireSynced && 'status' in obj) lastSeen.status = obj.status;
      lastErr = null;
      const synced = !requireSynced || !('status' in obj) || obj.status === 'synced';
      if (valuesMatch(obj, want) && synced) return;
    } catch (e) {
      lastErr = e.message;
    }
    if (Date.now() > deadline) {
      const seen = lastSeen ? ` Last seen: ${JSON.stringify(lastSeen)} (expected ${JSON.stringify(want)}).` : '';
      const err = lastErr ? ` Last GET error: ${lastErr}.` : '';
      throw new Error(`Verify timeout for ${kind} ${targetId}.${seen}${err}`);
    }
    await sleep(VERIFY_POLL_MS);
  }
}

async function resolveServer(step) {
  const server = await NimbleServer.findById(step.serverId);
  if (!server) throw new Error('Panel server not found');
  if (!server.wmspanelServerId) throw new Error(`Server "${server.name}" is not mapped to WMSPanel`);
  return server;
}

async function persistStep(run, idx, fields) {
  Object.assign(run.steps[idx], fields);
  run.markModified('steps');
  await run.save();
}

async function applyStep(cfg, run, idx, step) {
  if (step.type === 'delay') {
    await persistStep(run, idx, { status: 'applying', detail: `Waiting ${step.waitSec}s` });
    await sleep((step.waitSec || 0) * 1000);
    await persistStep(run, idx, { status: 'done' });
    return;
  }

  // Transcoders are account-level: no server mapping needed.
  if (step.type === 'action' && step.objectKind === 'transcoder') {
    if (!['pause', 'resume'].includes(step.action)) throw new Error('transcoder actions: pause/resume only');
    const before = await getObject(cfg, 'transcoder', null, step.targetId);
    const snapshot = { kind: 'transcoder', targetId: step.targetId, wasPaused: Boolean(before.paused) };
    await persistStep(run, idx, { status: 'applying', detail: `${step.action} transcoder ${step.targetId}`, snapshot });
    await (step.action === 'pause' ? wmspanel.transcoderPause : wmspanel.transcoderResume)(cfg, step.targetId);
    await persistStep(run, idx, { status: 'verifying', applied: true,
      detail: 'Applied; verifying (WMSPanel ~30s sync cycle; window 180s)' });
    await verifyPatched(cfg, 'transcoder', null, step.targetId, { paused: step.action === 'pause' });
    await persistStep(run, idx, { status: 'done', detail: '' });
    return;
  }
  if (step.type === 'patch' && step.objectKind === 'transcoder') {
    // generic patch path but without server mapping
    const patch = step.patch || {};
    if (Object.keys(patch).length === 0) throw new Error('Empty patch');
    await persistStep(run, idx, { status: 'applying', detail: `transcoder ${step.targetId}: ${JSON.stringify(patch)}` });
    const before = await getObject(cfg, 'transcoder', null, step.targetId);
    const snapshot = { sid: null, kind: 'transcoder', targetId: step.targetId, values: {} };
    for (const k of Object.keys(patch)) snapshot.values[k] = before[k] ?? null;
    await persistStep(run, idx, { snapshot });
    await wmspanel.transcoderUpdate(cfg, null, step.targetId, patch);
    await persistStep(run, idx, { applied: true, status: 'verifying',
      detail: 'Applied; verifying (WMSPanel ~30s sync cycle; window 180s)' });
    await verifyPatched(cfg, 'transcoder', null, step.targetId, patch);
    await persistStep(run, idx, { status: 'done', detail: '' });
    return;
  }

  const server = await resolveServer(step);
  const sid = server.wmspanelServerId;

  if (step.type === 'action') {
    // live_pull supports restart only (no synced field -> no verify, no rollback)
    if (step.objectKind === 'live_pull') {
      if (step.action !== 'restart') throw new Error('live_pull actions: only restart is supported');
      await persistStep(run, idx, { status: 'applying', detail: `restart live_pull ${step.targetId}` });
      await wmspanel.livePullRestart(cfg, sid, step.targetId);
      await persistStep(run, idx, { status: 'done', applied: true, detail: '' });
      return;
    }
    await persistStep(run, idx, { status: 'applying', detail: `${step.action} on outgoing ${step.targetId}` });
    // snapshot paused-state for pause/resume rollback
    let snapshot = null;
    if (step.action === 'pause' || step.action === 'resume') {
      const before = await getObject(cfg, 'outgoing', sid, step.targetId);
      snapshot = { sid, targetId: step.targetId, action: step.action, wasPaused: Boolean(before.paused) };
    }
    await wmspanel.outgoingAction(cfg, sid, step.targetId, step.action);
    await persistStep(run, idx, { status: 'verifying', snapshot, applied: true,
      detail: 'Applied; verifying (WMSPanel delivers to Nimble on its ~30s sync cycle; window 180s)' });
    if (step.action === 'pause' || step.action === 'resume') {
      await verifyPatched(cfg, 'outgoing', sid, step.targetId, { paused: step.action === 'pause' });
    }
    await persistStep(run, idx, { status: 'done', detail: '' });
    return;
  }

  // type === 'patch'
  const kind = step.objectKind;
  if (!KIND_OPS[kind]) throw new Error(`Unknown object kind: ${kind}`);
  const patch = step.patch || {};
  if (Object.keys(patch).length === 0) throw new Error('Empty patch');

  await persistStep(run, idx, { status: 'applying', detail: `${kind} ${step.targetId}: ${JSON.stringify(patch)}` });
  const before = await getObject(cfg, kind, sid, step.targetId);
  const snapshot = { sid, kind, targetId: step.targetId, values: {} };
  for (const k of Object.keys(patch)) snapshot.values[k] = before[k] ?? null;
  await persistStep(run, idx, { snapshot });

  await wmspanel[KIND_OPS[kind].put](cfg, sid, step.targetId, patch);
  await persistStep(run, idx, { applied: true, status: 'verifying',
    detail: 'Applied; verifying (WMSPanel delivers to Nimble on its ~30s sync cycle; window 180s)' });
  await verifyPatched(cfg, kind, sid, step.targetId, patch);
  await persistStep(run, idx, { status: 'done', detail: '' });
}

async function rollbackStep(cfg, run, idx, step) {
  const snap = run.steps[idx].snapshot;
  const prevDetail = run.steps[idx].detail;
  await persistStep(run, idx, { status: 'rolling_back' });
  try {
    if (step.type === 'patch' && snap?.values) {
      await wmspanel[KIND_OPS[snap.kind].put](cfg, snap.sid, snap.targetId, snap.values);
    } else if (step.type === 'action' && snap?.kind === 'transcoder') {
      await (snap.wasPaused ? wmspanel.transcoderPause : wmspanel.transcoderResume)(cfg, snap.targetId);
    } else if (step.type === 'action' && snap && (step.action === 'pause' || step.action === 'resume')) {
      const inverse = snap.wasPaused ? 'pause' : 'resume';
      await wmspanel.outgoingAction(cfg, snap.sid, snap.targetId, inverse);
    }
    // delay / restart: nothing to roll back
    await persistStep(run, idx, { status: 'rolled_back', detail: prevDetail });
    return true;
  } catch (e) {
    await persistStep(run, idx, { status: 'rollback_failed', detail: e.message });
    return false;
  }
}

// Preflight: validate EVERY step before sending any mutation. Predictable
// failures (unmapped server, missing object, patch keys that do not exist in
// the object's real schema) abort the run with ZERO changes applied — a
// doomed transaction must not touch production streams at all. What preflight
// cannot rule out: mid-run environment failures (network, WMSPanel outage
// between steps) — those are still handled by rollback.
async function preflight(cfg, fnDoc, run) {
  const problems = [];
  for (let i = 0; i < fnDoc.steps.length; i++) {
    const step = fnDoc.steps[i];
    if (step.type === 'delay') continue;
    try {
      let sid = null;
      const kind = step.objectKind === 'transcoder' ? 'transcoder'
        : step.type === 'action' ? (step.objectKind === 'live_pull' ? 'live_pull' : 'outgoing')
        : step.objectKind;
      if (kind !== 'transcoder') {
        const server = await resolveServer(step);
        sid = server.wmspanelServerId;
      }
      if (!KIND_OPS[kind]) throw new Error(`Unknown object kind: ${kind}`);
      const obj = await getObject(cfg, kind, sid, step.targetId);
      if (step.type === 'patch') {
        const keys = Object.keys(step.patch || {});
        if (keys.length === 0) throw new Error('Empty patch');
        const missing = keys.filter(k => !(k in obj));
        if (missing.length) {
          // Suggest canonical twins for common legacy/typo keys, e.g.
          // src_stream -> src_strm (functions are stored data: panel upgrades
          // never rewrite saved patches, so old keys can linger).
          const avail = Object.keys(obj);
          const hint = missing.map(m => {
            const twin = avail.find(k =>
              k === m.replace(/stream/g, 'strm') ||
              m === k.replace(/stream/g, 'strm') ||
              k.replace(/_/g, '') === m.replace(/_/g, ''));
            return twin ? `'${m}' → did you mean '${twin}'?` : null;
          }).filter(Boolean);
          throw new Error(
            `Field(s) not present on ${kind} object: [${missing.join(', ')}]. ` +
            (hint.length ? `${hint.join(' ')} ` : '') +
            `Available fields: [${avail.join(', ')}]`
          );
        }
      }
      await persistStep(run, i, { detail: 'Preflight OK' });
    } catch (e) {
      problems.push({ index: i, message: e.message });
      await persistStep(run, i, { status: 'error', detail: `Preflight: ${e.message}` });
    }
  }
  return problems;
}

export async function executeFunction(fnDoc, startedBy) {
  const settings = await Settings.load();
  if (settings.controlPlane !== 'wmspanel') {
    throw new Error('Functions require the WMSPanel control plane (see Settings)');
  }
  const cfg = settings.wmspanel;

  const run = await FunctionRun.create({
    functionId: fnDoc._id,
    functionName: fnDoc.name,
    startedBy,
    steps: fnDoc.steps.map((st, i) => ({
      index: i,
      label: st.label || `${st.type}${st.objectKind ? ':' + st.objectKind : ''}${st.action ? ':' + st.action : ''}`,
      status: 'pending',
    })),
  });

  // Fire-and-forget executor; UI polls the run document.
  (async () => {
    // Phase 0: preflight — zero mutations unless every step validates.
    const problems = await preflight(cfg, fnDoc, run);
    if (problems.length > 0) {
      run.status = 'preflight_failed';
      run.cancelReason = 'Preflight failed, nothing was changed: ' +
        problems.map(p => `step ${p.index + 1}: ${p.message}`).join(' | ');
      run.finishedAt = new Date();
      await run.save();
      return;
    }
    for (let i = 0; i < fnDoc.steps.length; i++) await persistStep(run, i, { detail: '' });

    let failedAt = -1;
    for (let i = 0; i < fnDoc.steps.length; i++) {
      try {
        await applyStep(cfg, run, i, fnDoc.steps[i]);
      } catch (e) {
        failedAt = i;
        await persistStep(run, i, { status: 'error', detail: e.message });
        break;
      }
    }
    if (failedAt === -1) {
      run.status = 'success';
    } else {
      // Transactional rollback in reverse order. The FAILED step itself is
      // rolled back too when its mutation was actually sent (applied=true):
      // e.g. a PUT that succeeded but whose verification timed out MUST be
      // reverted — otherwise the change silently stays applied.
      let allOk = true;
      for (let i = failedAt; i >= 0; i--) {
        if (i === failedAt && !run.steps[i].applied) continue;
        const ok = await rollbackStep(cfg, run, i, fnDoc.steps[i]);
        if (!ok) allOk = false;
      }
      run.status = allOk ? 'rolled_back' : 'rollback_failed';
      run.cancelReason = `Step ${failedAt + 1} (${run.steps[failedAt].label}) failed: ${run.steps[failedAt].detail}`;
    }
    run.finishedAt = new Date();
    await run.save();
    logEvent({
      username: startedBy,
      action: 'functions:run_finished',
      target: fnDoc.name,
      detail: { runId: String(run._id), status: run.status, cancelReason: run.cancelReason || null },
      outcome: run.status === 'success' ? 'ok' : 'error',
    });
  })().catch(async (e) => {
    run.status = 'rollback_failed';
    run.cancelReason = `Executor crashed: ${e.message}`;
    run.finishedAt = new Date();
    await run.save().catch(() => {});
  });

  return run;
}
