// Working out where a stopped playlist had got to.
//
// The file cannot say. Nimble knows the position and does not expose it, and
// the grammar has no field for it — so a resume has to be RECONSTRUCTED from
// three things the panel does know: when the task started playing, when it was
// stopped, and how long each file runs.
//
// That makes it an estimate, and it is treated as one throughout. Real
// playback drifts from arithmetic: a transcoder restart, a frame-rate
// conversion, a file whose container duration disagrees with its content. The
// answer is deliberately biased backwards — see REWIND_MS — because repeating
// a few seconds is a thing viewers forgive and skipping a goal is not.

// How far before the computed point to actually resume.
//
// Drift accumulates in both directions, and the two errors are not equal: land
// early and the audience sees a few seconds twice; land late and they miss
// content that will never be shown. Cheap insurance against arithmetic that
// cannot be exact.
const REWIND_MS = 3000;

/**
 * Which entry was playing, and how far into it.
 *
 * @param entries  [{ source, durationMs }] in play order
 * @param elapsedMs how long the block had been playing
 * @param loops     whether the block repeats (MaxIterations 0)
 * @returns { index, offsetMs, total, laps } or a reason it cannot be computed
 */
export function locate(entries, elapsedMs, loops) {
  const usable = entries.filter(e => Number.isFinite(e.durationMs) && e.durationMs > 0);
  if (usable.length !== entries.length) {
    // Guessing past an unknown duration would put the resume in the wrong
    // file, which is worse than not resuming at all.
    return { ok: false, reason: 'not every entry has a known duration' };
  }
  const total = entries.reduce((a, e) => a + e.durationMs, 0);
  if (!total) return { ok: false, reason: 'the entries have no length between them' };

  let t = Math.max(0, elapsedMs - REWIND_MS);
  let laps = 0;
  if (t >= total) {
    if (!loops) {
      // It reached the end and stopped there. Restarting from the top is the
      // only meaningful answer, and it is not a failure.
      return { ok: true, index: 0, offsetMs: 0, total, laps: 1, atEnd: true };
    }
    laps = Math.floor(t / total);
    t -= laps * total;
  }

  for (let i = 0; i < entries.length; i++) {
    if (t < entries[i].durationMs) return { ok: true, index: i, offsetMs: Math.round(t), total, laps };
    t -= entries[i].durationMs;
  }
  // Only reachable through floating-point dust at the very end of the last
  // entry; the last entry is the honest answer.
  return { ok: true, index: entries.length - 1, offsetMs: 0, total, laps };
}

/**
 * Rebuild a task so it resumes rather than restarts.
 *
 * The entries before the resume point are dropped from the first block and the
 * one being resumed carries an Offset — both are grammar Nimble already has,
 * so nothing here depends on a feature that does not exist.
 *
 * The dropped entries are NOT lost: a looping block plays them on its next
 * lap, which is what "resume" means for a playlist that repeats. For a block
 * that does not loop, they are content already shown.
 */
export function resumeTask(task, durations, elapsedMs) {
  const blocks = Array.isArray(task?.Blocks) ? task.Blocks : [];
  if (!blocks.length) return { ok: false, reason: 'the task has no blocks' };

  // Only the first block is resumed into. A task whose blocks have explicit
  // Start times is a schedule, not a queue, and rewriting it would move the
  // schedule.
  const block = blocks[0];
  if (block.Start) return { ok: false, reason: 'this block has a scheduled start time; resuming would move it' };

  const entries = (block.Streams || []).map(s => ({
    source: s.Source,
    durationMs: durations.get(s.Source),
  }));
  const at = locate(entries, elapsedMs, block.MaxIterations === 0);
  if (!at.ok) return at;

  const rest = (block.Streams || []).slice(at.index);
  if (!rest.length) return { ok: false, reason: 'nothing left to play from that point' };

  const first = { ...rest[0] };
  // Offset is in milliseconds in this grammar, same as Duration.
  if (at.offsetMs > 0) first.Offset = at.offsetMs;

  return {
    ok: true,
    task: { ...task, Blocks: [{ ...block, Streams: [first, ...rest.slice(1)] }, ...blocks.slice(1)] },
    at,
    // Said out loud so the caller cannot present this as exact.
    estimated: true,
    rewoundMs: REWIND_MS,
  };
}

export const __rewindMs = REWIND_MS;
