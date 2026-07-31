// iter14 — noticing that an agent has stopped working, and saying so once.
//
// Two rules, both learned the hard way in ServerMonitor:
//
//  1. DEBOUNCE. A fault has to persist for several consecutive readings before
//     it becomes an event, and a recovery likewise. Without that, an agent
//     that misses one poll during a panel restart raises an alarm, and an
//     agent flapping raises hundreds. The counter resets on any change of
//     state, so flapping produces nothing rather than a stream.
//
//  2. NOTHING IS DONE AUTOMATICALLY. The watchdog detects and records; it
//     never restarts, reinstalls or stops anything. An automatic action on a
//     false positive is more dangerous than the fault it was reacting to —
//     the panel would be reaching into thirteen live broadcast servers on the
//     strength of a missed heartbeat. Recovery is a button an operator presses,
//     with the evidence in front of them.
import { NimbleServer } from '../models/NimbleServer.js';
import { AgentTask } from '../models/AgentTask.js';
import { AgentEvent } from '../models/AgentEvent.js';
import { diagnose, CODES } from './agentDiagnosis.js';
import { reapExpiredTasks } from './agentBus.js';

const TICK_MS = Number(process.env.NNM_AGENT_WATCH_MS || 30_000);
// Consecutive readings before a state is believed. At a 30s tick that is a
// minute and a half — longer than a panel restart, shorter than an incident.
const CONFIRM = Number(process.env.NNM_AGENT_WATCH_CONFIRM || 3);

const HEALTHY = new Set([CODES.HEALTHY, CODES.NOT_CONFIGURED]);

// serverId -> { code, streak, announced }
const seen = new Map();
let timer = null;
const stats = { lastRunAt: null, checked: 0, events: 0 };

export function watchdogState() {
  return {
    ...stats,
    active: Boolean(timer),
    tickMs: TICK_MS,
    confirmAfter: CONFIRM,
    tracking: [...seen.entries()].map(([serverId, v]) => ({ serverId, ...v })),
  };
}

export async function evaluateOnce({ now = new Date() } = {}) {
  await reapExpiredTasks({ now });
  const servers = await NimbleServer.find({ 'agent.enabled': true });
  const out = { checked: 0, events: [] };

  for (const server of servers) {
    out.checked++;
    const a = server.agent || {};
    const tasks = await AgentTask.find({ serverId: server._id })
      .sort({ createdAt: -1 }).limit(25).lean();

    const d = diagnose({
      now,
      agent: {
        enabled: Boolean(a.enabled), hasToken: Boolean(a.token),
        lastContactAt: a.lastContactAt, instanceId: a.instanceId, version: a.version,
        restarts: a.restarts, restartWindowStart: a.restartWindowStart,
      },
      tasks: tasks.map(t => ({
        id: String(t._id), route: t.route, status: t.status,
        createdAt: t.createdAt, claimedAt: t.claimedAt, deadlineAt: t.deadlineAt,
      })),
    });

    const key = String(server._id);
    const prev = seen.get(key) || { code: null, streak: 0, announced: null };
    // Any change of verdict restarts the count. That is what makes a flapping
    // agent quiet instead of loud.
    const streak = prev.code === d.code ? prev.streak + 1 : 1;
    const next = { code: d.code, streak, announced: prev.announced };

    if (streak >= CONFIRM && prev.announced !== d.code) {
      const healthy = HEALTHY.has(d.code);
      // Recovery is only worth saying if something was said before.
      if (!healthy || (prev.announced && !HEALTHY.has(prev.announced))) {
        const ev = await AgentEvent.create({
          serverId: server._id,
          serverName: server.name,
          code: d.code,
          kind: healthy ? 'recovered' : 'fault',
          severity: healthy ? 'info' : (d.severity === 'error' ? 'error' : 'warn'),
          message: healthy ? 'agent is answering again' : d.code,
          evidence: d.evidence || '',
          detail: { sinceContactMs: d.sinceContactMs, task: d.task || null, restarts: d.restarts || 0 },
        });
        out.events.push(ev);
        stats.events++;
      }
      next.announced = d.code;
    }
    seen.set(key, next);
  }

  // A server that stops having an agent stops being tracked, or its last
  // verdict would keep a stale entry alive for ever.
  const live = new Set(servers.map(s => String(s._id)));
  for (const k of [...seen.keys()]) if (!live.has(k)) seen.delete(k);

  stats.lastRunAt = now;
  stats.checked = out.checked;
  return out;
}

export function startAgentWatchdog() {
  stopAgentWatchdog();
  const tick = () => evaluateOnce().catch(e => console.error('[agent-watchdog]', e.message));
  timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  tick();
}

export function stopAgentWatchdog() { if (timer) { clearInterval(timer); timer = null; } }

// Exposed so a test can drive the debounce without waiting on a timer.
export function _resetWatchdog() { seen.clear(); stats.events = 0; }
