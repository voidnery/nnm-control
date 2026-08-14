// iter12 m1 — the bus between a panel request and an agent that will never
// accept a connection.
//
// The browser still calls the panel synchronously ("show me this server's
// config") and still expects an answer in that response. So internally the
// panel enqueues a task and awaits its result, while the agent's outstanding
// long-poll is completed the instant the task appears. The round trip is one
// network hop each way, not one poll interval — which is why this is a bus
// with waiters and not a `setInterval` over the database.
//
// SCOPE: the waiter registries live in this process. The panel runs as a
// single api container (see docker-compose.yml), so that holds today. If it is
// ever scaled to more than one replica, an agent polling replica A while a
// request waits on replica B would fall back to the deadline instead of
// answering promptly — correct, but slow. Fixing that properly means Redis
// pub/sub, and it is not worth carrying before there is a second replica.
import { AgentTask } from '../models/AgentTask.js';

const DEFAULT_TIMEOUT_MS = 20_000;

// serverId -> Set<resolve>  : agents parked on a long-poll
const pollWaiters = new Map();
// taskId   -> resolve       : panel requests waiting for a result
const resultWaiters = new Map();

// Exported so the parking behaviour can be tested without a database: the
// property that matters is that a parked agent is released the instant work
// appears for IT, and not when work appears for someone else.
export function wake(serverId) {
  const set = pollWaiters.get(String(serverId));
  if (!set) return;
  for (const resolve of set) resolve();
  set.clear();
}

/**
 * Park an agent until a task appears for it, or until `ms` elapses.
 * Resolves either way — the caller re-checks the queue.
 */
export function waitForTask(serverId, ms) {
  const key = String(serverId);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); set.delete(finish); resolve(); } };
    const timer = setTimeout(finish, ms);
    if (timer.unref) timer.unref();
    let set = pollWaiters.get(key);
    if (!set) { set = new Set(); pollWaiters.set(key, set); }
    set.add(finish);
  });
}

/** Called by the gateway when an agent reports a result. */
export function deliverResult(taskId, payload) {
  const resolve = resultWaiters.get(String(taskId));
  if (resolve) { resultWaiters.delete(String(taskId)); resolve(payload); }
}

/**
 * Mark tasks whose deadline has passed.
 *
 * iter12 m4 — found while building the diagnosis. `runTask` expires its own
 * task when it gives up waiting, but `enqueueTask` has nobody waiting, so a
 * media transfer whose agent never appeared stayed `queued` for ever. The
 * classifier would then have read "queued, and the agent polled after it was
 * created" as a panel-side claim bug — a confident, wrong answer. A diagnosis
 * is only worth having if the states it reads are true.
 */
export async function reapExpiredTasks({ now = new Date() } = {}) {
  const r = await AgentTask.updateMany(
    { status: { $in: ['queued', 'claimed'] }, deadlineAt: { $lt: now } },
    { $set: { status: 'expired', finishedAt: now } },
  );
  return r.modifiedCount || 0;
}

let reaper = null;
export function startTaskReaper(everyMs = 60_000) {
  stopTaskReaper();
  const tick = () => reapExpiredTasks().catch(e => console.error('[tasks] reap failed:', e.message));
  reaper = setInterval(tick, everyMs);
  if (reaper.unref) reaper.unref();
  tick();
}
export function stopTaskReaper() { if (reaper) { clearInterval(reaper); reaper = null; } }

export function busStats() {
  return {
    parkedAgents: [...pollWaiters.values()].reduce((n, s) => n + s.size, 0),
    pendingResults: resultWaiters.size,
  };
}

/**
 * Enqueue a task without waiting for it.
 *
 * For work whose result nobody is holding an HTTP request open for — a media
 * transfer that may take half an hour over a slow link, and whose outcome is
 * recorded on the transfer rather than returned to a browser.
 */
export async function enqueueTask(server, route, { query = null, body = null, timeoutMs = 30 * 60_000, createdBy = '' } = {}) {
  if (!server?.agent?.enabled) {
    throw Object.assign(new Error('agent is not enabled for this server'), { status: 409 });
  }
  // A task nothing on that machine can claim would sit in the queue until it
  // timed out, thirty seconds later, and report as a timeout — which reads as
  // a network problem rather than a missing component.
  if (PRIVILEGED_ROUTES.test(route) && !server.helper?.seen) {
    throw Object.assign(
      new Error('this machine has no privileged helper, so it cannot make system changes'),
      { status: 409, code: 'no-privileged-helper' },
    );
  }
  const task = await AgentTask.create({
    serverId: server._id, route, query, body,
    deadlineAt: new Date(Date.now() + timeoutMs), createdBy,
  });
  wake(server._id);
  return task;
}

/**
 * Enqueue a task and wait for the agent's answer.
 *
 * Throws on timeout rather than returning a half-answer, so callers that used
 * to `await agent.health(server)` keep the same success/failure shape and the
 * routes above them did not have to learn about queues.
 */
// Routes that only the privileged helper can carry out. Derived from the route
// rather than passed by every caller: a flag somebody has to remember is a flag
// somebody forgets, and the consequence here is a task offered to an agent that
// will refuse it.
// Written out one route at a time, because the list is the contract and a
// regular expression hides what is missing. `acme-precheck` was absent, so it
// went to the ordinary agent — which is sandboxed, cannot write
// /var/www/html, and reported "no such file or directory" about a path the
// helper creates on install.
//
// The test for membership is what the route *does*, not what it is called:
// anything that writes outside Nimble's own directories or reads process
// tables needs the helper.
const PRIVILEGED_ROUTES_LIST = [
  'POST /host/apply',          // installs packages, writes /etc
  'POST /host/rollback',       // undoes the same
  'GET /host/ports',           // needs root to see which process holds a port
  'POST /host/acme-precheck',  // writes a file into /var/www/html
];
const PRIVILEGED_ROUTES = new RegExp(`^(${PRIVILEGED_ROUTES_LIST
  .map(r => r.replace(/[/]/g, '\\/')).join('|')})$`);

export async function runTask(server, route, { query = null, body = null, timeoutMs = DEFAULT_TIMEOUT_MS, createdBy = '' } = {}) {
  if (!server?.agent?.enabled) {
    throw Object.assign(new Error('agent is not enabled for this server'), { status: 409 });
  }
  // A task nothing on that machine can claim would sit in the queue until it
  // timed out, thirty seconds later, and report as a timeout — which reads as
  // a network problem rather than a missing component.
  if (PRIVILEGED_ROUTES.test(route) && !server.helper?.seen) {
    throw Object.assign(
      new Error('this machine has no privileged helper, so it cannot make system changes'),
      { status: 409, code: 'no-privileged-helper' },
    );
  }
  const deadlineAt = new Date(Date.now() + timeoutMs);
  const task = await AgentTask.create({
    serverId: server._id, route, query, body, deadlineAt, createdBy,
    needsPrivileged: PRIVILEGED_ROUTES.test(route),
  });

  const answer = new Promise((resolve) => resultWaiters.set(String(task._id), resolve));
  wake(server._id);

  const timer = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    if (t.unref) t.unref();
  });

  const outcome = await Promise.race([answer, timer]);
  if (outcome === null) {
    resultWaiters.delete(String(task._id));
    // Which of the two failures this was matters to the operator, so it is
    // recorded on the task rather than flattened into one message.
    const fresh = await AgentTask.findById(task._id);
    const neverClaimed = fresh && fresh.status === 'queued';
    if (fresh && fresh.status !== 'done' && fresh.status !== 'failed') {
      fresh.status = 'expired';
      fresh.finishedAt = new Date();
      await fresh.save();
    }
    // iter12 m4 — the two failures have different causes and different fixes,
    // and the operator sees this string, not the task record.
    throw Object.assign(
      new Error(neverClaimed
        ? 'the agent did not pick up the task — see Agents for whether it is polling at all'
        : 'the agent picked up the task but did not answer in time'),
      { status: 504, reason: neverClaimed ? 'not-claimed' : 'no-answer' },
    );
  }
  if (outcome.error) throw Object.assign(new Error(outcome.error), { status: outcome.status || 502 });
  return outcome.result;
}
