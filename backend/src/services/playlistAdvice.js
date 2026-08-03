// What the panel can tell an operator that Softvelum's tooling does not.
//
// All four of these answer questions that are currently answered by watching
// the stream: whether someone edited the file behind the panel's back, whether
// the files will play cleanly into each other, how long a block runs, and when
// a non-looping one will fall off air.
//
// Pure functions. Every one of them is a judgement about a live broadcast and
// a judgement that cannot be demonstrated is a judgement nobody should trust.

import { parsePlaylistFile } from './playlistFile.js';

// ---- 1. Changed behind our back --------------------------------------------

/**
 * Has the file on the server moved away from what the panel last wrote?
 *
 * Matters because the next deploy overwrites without asking. Someone editing
 * the file by hand — which is how it has always been done here — would lose
 * that work silently, and only notice when the change they made stopped being
 * in effect.
 */
export function detectDrift({ serverSha, lastDeploy }) {
  if (!serverSha) return { state: 'no-file' };
  if (!lastDeploy) return { state: 'never-deployed', note: 'this panel has not written this file' };
  if (serverSha === lastDeploy.sha256) return { state: 'in-sync', at: lastDeploy.createdAt };
  return {
    state: 'drifted',
    since: lastDeploy.createdAt,
    by: lastDeploy.by || null,
    // The consequence, not just the fact: an operator reading "differs" has to
    // work out why that is worth their attention.
    note: 'the file has been changed since the panel last wrote it — deploying now would overwrite that change',
  };
}

// ---- 2. Files that will not join cleanly -----------------------------------

const rateOf = (p) => p?.video?.fps ?? null;
const geomOf = (p) => (p?.video?.width && p?.video?.height ? `${p.video.width}x${p.video.height}` : null);

/**
 * Where consecutive entries disagree in a way that shows at the join.
 *
 * Reported per boundary rather than per file: it is the CHANGE that produces
 * the stutter, and a playlist of uniformly odd files is fine while one odd
 * file among twenty is not.
 */
export function checkJoins(sources, probes) {
  const issues = [];
  const unknown = [];
  for (let i = 0; i < sources.length; i++) {
    const p = probes.get(sources[i]);
    if (!p) { unknown.push(sources[i]); continue; }
    if (i === 0) continue;
    const q = probes.get(sources[i - 1]);
    if (!q) continue;

    const diffs = [];
    if (geomOf(p) && geomOf(q) && geomOf(p) !== geomOf(q)) diffs.push({ what: 'resolution', from: geomOf(q), to: geomOf(p) });
    // A frame-rate change is the one that shows most: 25 into 30 judders on
    // every join, every lap.
    if (rateOf(p) && rateOf(q) && Math.abs(rateOf(p) - rateOf(q)) > 0.01) {
      diffs.push({ what: 'frame rate', from: rateOf(q), to: rateOf(p) });
    }
    if (p.video?.codec && q.video?.codec && p.video.codec !== q.video.codec) {
      diffs.push({ what: 'video codec', from: q.video.codec, to: p.video.codec });
    }
    // Audio discontinuities are audible even when the picture is fine, and are
    // the usual cause of a "click" between items.
    if (p.audio?.sampleRate && q.audio?.sampleRate && p.audio.sampleRate !== q.audio.sampleRate) {
      diffs.push({ what: 'sample rate', from: q.audio.sampleRate, to: p.audio.sampleRate });
    }
    if (p.audio?.channels && q.audio?.channels && p.audio.channels !== q.audio.channels) {
      diffs.push({ what: 'audio channels', from: q.audio.channels, to: p.audio.channels });
    }
    // A file with no audio between files that have it is silence, not a join
    // artefact — worth its own mention.
    if (Boolean(p.audio) !== Boolean(q.audio)) diffs.push({ what: 'audio track', from: q.audio ? 'present' : 'none', to: p.audio ? 'present' : 'none' });

    if (diffs.length) issues.push({ at: i, after: sources[i - 1], before: sources[i], diffs });
  }
  return { issues, unknown, checked: sources.length - unknown.length };
}

// ---- 3 & 4. How long it runs, and when it ends -----------------------------

/**
 * Block-by-block timing for a parsed playlist.
 *
 * A looping block has no end; a non-looping one does, and that end is when the
 * output stream falls off air once InactivityTimeout expires. Both are things
 * an operator currently works out with a calculator.
 */
export function timings(parsed, durations, { startedAt = null, now = Date.now() } = {}) {
  return parsed.tasks.map((task) => {
    const blocks = task.blocks.map((b, bi) => {
      const items = task.items.filter(i => i.blockIndex === bi);
      const known = items.map(i => durations.get(i.source)).filter(d => Number.isFinite(d) && d > 0);
      const complete = known.length === items.length && items.length > 0;
      const totalMs = known.reduce((a, d) => a + d, 0);
      return {
        index: bi, id: b.id, loops: b.loops, count: items.length,
        // Partial totals are given, and marked partial: "at least 40 minutes"
        // is useful, and pretending it is the whole answer is not.
        totalMs, complete, missingDurations: items.length - known.length,
      };
    });

    const finite = blocks.filter(b => !b.loops);
    const loopsForever = blocks.some(b => b.loops);
    const totalMs = blocks.reduce((a, b) => a + b.totalMs, 0);

    // When it runs out, if it can. InactivityTimeout is the grace period after
    // the last block before Nimble drops the stream — 30s by default, and 0
    // means never.
    let endsAt = null;
    if (!loopsForever && startedAt && finite.every(b => b.complete)) {
      const grace = task.inactivityTimeout === 0 ? null : (task.inactivityTimeout ?? 30) * 1000;
      const playedOut = new Date(startedAt).getTime() + totalMs;
      endsAt = { contentEndsAt: playedOut, streamDropsAt: grace == null ? null : playedOut + grace };
    }

    return {
      stream: task.stream,
      blocks,
      totalMs,
      loopsForever,
      endsAt,
      endsInMs: endsAt ? endsAt.contentEndsAt - now : null,
    };
  });
}

/** Tasks whose content runs out within the window. */
export function endingSoon(timed, withinMs = 60 * 60 * 1000) {
  return timed
    .filter(t => t.endsInMs != null && t.endsInMs <= withinMs)
    // Already finished is more urgent than about to finish, so negatives sort
    // first rather than being filtered out as nonsense.
    .sort((a, b) => a.endsInMs - b.endsInMs);
}
