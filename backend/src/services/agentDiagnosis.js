// iter12 m4 — telling apart the ways an agent can fail to do what was asked.
//
// "The agent isn't working" covers at least six different situations with six
// different fixes, and in NET-Control they were indistinguishable until the
// panel started comparing two timestamps: when the agent last called in, and
// when the task was created. That comparison is the whole idea here.
//
// This is a PURE function over facts. No database, no clock of its own, no
// network. Classification logic is exactly the kind that goes subtly wrong —
// an inverted comparison here would send an operator to restart a healthy
// agent — so it is written to be exhaustively testable without any of those
// things being present.

export const CODES = {
  NOT_CONFIGURED: 'not-configured',
  NO_CONTACT: 'no-contact',
  STOPPED_POLLING: 'stopped-polling',
  RESTART_LOOP: 'restart-loop',
  CLAIMED_NO_ANSWER: 'claimed-no-answer',
  NOT_CLAIMED: 'polling-not-claimed',
  HEALTHY: 'healthy',
};

// The agent parks for 25s at a time, so a gap of one poll window is normal and
// says nothing. Two windows plus a margin is the point at which silence means
// something.
export const STALE_AFTER_MS = 70_000;
// Restarts are normal; restarts every minute are a crash loop.
export const RESTART_WINDOW_MS = 10 * 60_000;
export const RESTART_LIMIT = 3;

const ms = (d) => (d ? new Date(d).getTime() : 0);

/**
 * @param {object} f                      facts, all optional except `now`
 * @param {Date}   f.now
 * @param {object} f.agent                { enabled, hasToken, lastContactAt, instanceId, version, restarts, restartWindowStart }
 * @param {array}  f.tasks                recent tasks: { id, route, status, createdAt, claimedAt, deadlineAt }
 * @returns {{code, severity, since, evidence, hint}}
 */
export function diagnose({ now = new Date(), agent = {}, tasks = [] } = {}) {
  const t = ms(now);
  const contact = ms(agent.lastContactAt);
  const sinceContact = contact ? t - contact : null;

  const out = (code, severity, extra = {}) => ({
    code, severity,
    lastContactAt: agent.lastContactAt || null,
    sinceContactMs: sinceContact,
    ...extra,
  });

  if (!agent.enabled || !agent.hasToken) {
    return out(CODES.NOT_CONFIGURED, 'idle', {
      evidence: 'no agent is configured for this server',
    });
  }

  if (!contact) {
    // The install ran or it did not; either way the agent has never spoken to
    // us, so nothing downstream can be diagnosed.
    return out(CODES.NO_CONTACT, 'error', {
      evidence: 'the agent has never called in',
    });
  }

  if (sinceContact > STALE_AFTER_MS) {
    // It called in once and then stopped. Everything else would be guesswork
    // on top of an absent agent, so this outranks any stuck task.
    return out(CODES.STOPPED_POLLING, 'error', {
      evidence: `last contact was ${Math.round(sinceContact / 1000)}s ago; the agent parks for at most 25s, so it is not polling`,
    });
  }

  // It is polling. A restart counter that keeps moving inside a short window
  // means it is polling because it keeps coming back, not because it is well.
  if (Number(agent.restarts) >= RESTART_LIMIT &&
      agent.restartWindowStart && t - ms(agent.restartWindowStart) <= RESTART_WINDOW_MS) {
    return out(CODES.RESTART_LOOP, 'error', {
      restarts: Number(agent.restarts),
      evidence: `the agent process changed identity ${agent.restarts} times in the last ${Math.round((t - ms(agent.restartWindowStart)) / 60000)} min — it is restarting, not running`,
    });
  }

  const live = tasks.filter(x => x.status === 'queued' || x.status === 'claimed');

  // Claimed and gone quiet: the agent took the work and did not come back with
  // an answer. That is the agent's problem, and it names the route so the
  // operator knows which one to look at.
  const stuck = live
    .filter(x => x.status === 'claimed' && ms(x.deadlineAt) < t)
    .sort((a, b) => ms(a.createdAt) - ms(b.createdAt))[0];
  if (stuck) {
    return out(CODES.CLAIMED_NO_ANSWER, 'error', {
      task: { id: stuck.id, route: stuck.route, claimedAt: stuck.claimedAt },
      evidence: `the agent claimed ${stuck.route} and never reported a result`,
    });
  }

  // Still queued although the agent has polled SINCE it was created. Every
  // poll claims the oldest live task, so this cannot be the agent's fault —
  // the panel failed to hand it over. This is the case that was invisible
  // before, and the one that used to get blamed on the agent.
  // "Survived a whole poll cycle", not "existed before the last contact".
  //
  // The original reading was written for a system where tasks were rare: a
  // queued task older than the last poll meant the agent had been offered work
  // and left it. Since iter16 the panel asks the agent for every native read,
  // so tasks arrive continuously — and at any instant there is a task queued a
  // moment ago and a contact a moment before that. The rule fired constantly
  // on a perfectly healthy agent, which is worse than not having it: it makes
  // the one signal that matters unreadable.
  //
  // A task that has outlived a full poll interval was genuinely passed over.
  const POLL_CYCLE_MS = 25_000;
  const unclaimed = live
    .filter(x => x.status === 'queued'
      && contact > ms(x.createdAt) + POLL_CYCLE_MS)
    .sort((a, b) => ms(a.createdAt) - ms(b.createdAt))[0];
  if (unclaimed) {
    return out(CODES.NOT_CLAIMED, 'error', {
      task: { id: unclaimed.id, route: unclaimed.route, createdAt: unclaimed.createdAt },
      evidence: `the agent called in after ${unclaimed.route} was queued but did not receive it — the panel did not hand it over`,
    });
  }

  return out(CODES.HEALTHY, 'ok', {
    pending: live.length,
    evidence: live.length
      ? `${live.length} task(s) in flight, agent polling normally`
      : 'agent polling normally',
  });
}

// What to actually do about it. Kept beside the classifier so a new code
// cannot be added without someone deciding what an operator should do.
export const HINTS = {
  [CODES.NOT_CONFIGURED]: 'agent.notConfigured',
  [CODES.NO_CONTACT]: 'agent.hint.noContact',
  [CODES.STOPPED_POLLING]: 'agent.hint.stoppedPolling',
  [CODES.RESTART_LOOP]: 'agent.hint.restartLoop',
  [CODES.CLAIMED_NO_ANSWER]: 'agent.hint.claimedNoAnswer',
  [CODES.NOT_CLAIMED]: 'agent.hint.notClaimed',
  [CODES.HEALTHY]: '',
};
