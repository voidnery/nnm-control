import { Settings } from '../models/Settings.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { FunctionRun } from '../models/FunctionRun.js';
import { wmspanel } from './wmspanelClient.js';

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

const VERIFY_TIMEOUT_MS = 120_000;
const VERIFY_POLL_MS = 5_000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const KIND_OPS = {
  republish: { get: 'republishList', put: 'republishUpdate', pickList: d => d.rules || d.republish_rules || [] },
  udp:       { get: 'udpList',       put: 'udpUpdate',       pickList: d => d.settings || [] },
  outgoing:  { get: 'outgoingList',  put: 'outgoingUpdate',  pickList: d => d.streams || d.settings || [] },
  hotswap:   { get: 'hotswapList',   put: 'hotswapUpdate',   pickList: d => d.settings || [] },
};

async function getObject(cfg, kind, sid, targetId) {
  // List-then-find: single-object GET shapes vary; list shapes are confirmed.
  const ops = KIND_OPS[kind];
  const data = await wmspanel[ops.get](cfg, sid);
  const obj = ops.pickList(data).find(o => String(o.id) === String(targetId));
  if (!obj) throw new Error(`${kind} object ${targetId} not found on WMSPanel server ${sid}`);
  return obj;
}

function valuesMatch(obj, patch) {
  return Object.keys(patch).every(k => String(obj[k]) === String(patch[k]));
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

  const server = await resolveServer(step);
  const sid = server.wmspanelServerId;

  if (step.type === 'action') {
    await persistStep(run, idx, { status: 'applying', detail: `${step.action} on outgoing ${step.targetId}` });
    // snapshot paused-state for pause/resume rollback
    let snapshot = null;
    if (step.action === 'pause' || step.action === 'resume') {
      const before = await getObject(cfg, 'outgoing', sid, step.targetId);
      snapshot = { sid, targetId: step.targetId, action: step.action, wasPaused: Boolean(before.paused) };
    }
    await wmspanel.outgoingAction(cfg, sid, step.targetId, step.action);
    await persistStep(run, idx, { status: 'verifying', snapshot });
    if (step.action === 'pause' || step.action === 'resume') {
      const want = { paused: step.action === 'pause' };
      const deadline = Date.now() + VERIFY_TIMEOUT_MS;
      for (;;) {
        const obj = await getObject(cfg, 'outgoing', sid, step.targetId);
        if (valuesMatch(obj, want)) break;
        if (Date.now() > deadline) throw new Error(`Verify timeout: outgoing ${step.targetId} did not become ${step.action}d`);
        await sleep(VERIFY_POLL_MS);
      }
    }
    await persistStep(run, idx, { status: 'done' });
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

  await persistStep(run, idx, { status: 'verifying', detail: 'Waiting for WMSPanel→Nimble sync (~30s cycle)' });
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  for (;;) {
    const obj = await getObject(cfg, kind, sid, step.targetId);
    if (valuesMatch(obj, patch)) break;
    if (Date.now() > deadline) throw new Error(`Verify timeout: ${kind} ${step.targetId} did not reflect the patch`);
    await sleep(VERIFY_POLL_MS);
  }
  await persistStep(run, idx, { status: 'done', detail: '' });
}

async function rollbackStep(cfg, run, idx, step) {
  const snap = run.steps[idx].snapshot;
  await persistStep(run, idx, { status: 'rolling_back' });
  try {
    if (step.type === 'patch' && snap?.values) {
      await wmspanel[KIND_OPS[snap.kind].put](cfg, snap.sid, snap.targetId, snap.values);
    } else if (step.type === 'action' && snap && (step.action === 'pause' || step.action === 'resume')) {
      const inverse = snap.wasPaused ? 'pause' : 'resume';
      await wmspanel.outgoingAction(cfg, snap.sid, snap.targetId, inverse);
    }
    // delay / restart: nothing to roll back
    await persistStep(run, idx, { status: 'rolled_back' });
    return true;
  } catch (e) {
    await persistStep(run, idx, { status: 'rollback_failed', detail: e.message });
    return false;
  }
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
      // Transactional rollback of completed steps, reverse order.
      let allOk = true;
      for (let i = failedAt - 1; i >= 0; i--) {
        const ok = await rollbackStep(cfg, run, i, fnDoc.steps[i]);
        if (!ok) allOk = false;
      }
      run.status = allOk ? 'rolled_back' : 'rollback_failed';
      run.cancelReason = `Step ${failedAt + 1} (${run.steps[failedAt].label}) failed: ${run.steps[failedAt].detail}`;
    }
    run.finishedAt = new Date();
    await run.save();
  })().catch(async (e) => {
    run.status = 'rollback_failed';
    run.cancelReason = `Executor crashed: ${e.message}`;
    run.finishedAt = new Date();
    await run.save().catch(() => {});
  });

  return run;
}
