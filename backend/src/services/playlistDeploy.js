// Putting a playlist onto a server, and being able to undo it.
//
// The file is a live broadcast config: writing it takes effect the moment it
// lands, because Nimble watches the directory. There is no staging step and no
// confirmation from the server that what it read was what was meant. So the
// checking happens here, before the write, and the previous version is kept so
// the answer to "put it back" is a single action rather than an archaeology
// exercise.
import crypto from 'node:crypto';
import { PlaylistDeploy } from '../models/PlaylistDeploy.js';
import { parsePlaylistFile } from './playlistFile.js';

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/**
 * Record what is on the server now, if this panel has never seen it.
 *
 * Called before every write. Without it the first rollback has nothing to go
 * back to — and the first deploy is the one most likely to need undoing.
 */
export async function captureCurrent({ serverId, filename, content }) {
  if (!content) return null;
  const hash = sha256(content);
  const seen = await PlaylistDeploy.findOne({ serverId, sha256: hash }).lean();
  if (seen) return null;
  return PlaylistDeploy.create({
    serverId, filename, content, sha256: hash, bytes: content.length,
    origin: 'captured',
    note: 'found on the server before the panel wrote to it',
  });
}

/**
 * Is this content safe to put on that server?
 *
 * Returns what is wrong rather than throwing, because the caller decides
 * whether a given fault is fatal — a malformed file always is, a missing media
 * file is unless someone explicitly overrides it.
 */
export function inspect(content, presentPaths) {
  const parsed = parsePlaylistFile(content);
  if (!parsed.ok) return { fatal: `the playlist is not valid: ${parsed.reason}`, parsed };

  const missing = presentPaths
    ? parsed.sources.filter(src => !presentPaths.has(src))
    : [];

  // An empty playlist is legal JSON and stops every stream on the server. It
  // is a plausible accident — deleting the last task — and silent if not said.
  const entries = parsed.tasks.reduce((a, t) => a + t.count, 0);

  return {
    fatal: null,
    parsed,
    missing,
    empty: parsed.tasks.length === 0 || entries === 0,
    entries,
  };
}

/** The versions of this file, newest first. */
export function history(serverId, filename, limit = 30) {
  return PlaylistDeploy
    .find({ serverId, ...(filename ? { filename } : {}) })
    .sort({ createdAt: -1 })
    .limit(Math.min(100, Math.max(1, limit)))
    // The content of thirty versions is a lot to send to a browser that only
    // wants a list; it is fetched per version when one is actually opened.
    .select('-content')
    .lean();
}

// ---- Stopping and starting one output stream -------------------------------
//
// There is no pause in this format. The playlist is declarative: it says what
// to play and, per block, when to start — not where playback currently is.
// Softvelum's own grammar has Start, Offset, Duration, InactivityTimeout and
// MaxIterations, and nothing that means "resume".
//
// So stopping is removing the task, and starting is putting it back. Both are
// deploys, which means both go through the same checks as any other write —
// the alternative would be a second way to change a live config that skips
// them.
//
// What this does NOT give is resuming where it left off: a restored task
// begins at the top of its block. Saying so plainly beats a Play button that
// silently rewinds an hour of broadcast.

/** The file with one task removed. Returns null if it was not there. */
export function withoutTask(content, streamName) {
  let doc;
  try { doc = JSON.parse(String(content)); } catch { return null; }
  if (!Array.isArray(doc?.Tasks)) return null;
  const kept = doc.Tasks.filter(t => t?.Stream !== streamName);
  if (kept.length === doc.Tasks.length) return null;
  // Everything else in the file is preserved: another operator's tasks, keys
  // this panel does not model, the sync interval.
  return JSON.stringify({ ...doc, Tasks: kept }, null, 2);
}

/**
 * The file with a task put back, in the place it used to occupy.
 *
 * Order matters less to Nimble than to the person reading the file next, and a
 * task that reappears at the bottom looks like a new one.
 */
export function withTask(content, task, atIndex = null) {
  let doc;
  try { doc = JSON.parse(String(content || '{"SyncInterval":1000,"Tasks":[]}')); } catch { return null; }
  if (!Array.isArray(doc?.Tasks)) return null;
  if (doc.Tasks.some(t => t?.Stream === task?.Stream)) return null;   // already running
  const tasks = [...doc.Tasks];
  tasks.splice(atIndex == null || atIndex < 0 ? tasks.length : Math.min(atIndex, tasks.length), 0, task);
  return JSON.stringify({ ...doc, Tasks: tasks }, null, 2);
}

/**
 * Find a task by output stream name in the newest version that still had it.
 *
 * Starting a stopped stream means recovering its definition, and the panel
 * already keeps every version — so there is nothing extra to store and no
 * chance of the stored copy drifting from what was really running.
 */
export function findTaskInVersions(versions, streamName) {
  for (const v of versions) {
    try {
      const doc = JSON.parse(v.content);
      const found = (doc?.Tasks || []).find(t => t?.Stream === streamName);
      if (found) return { task: found, from: v, index: doc.Tasks.indexOf(found) };
    } catch { /* a version that will not parse is not a source to restore from */ }
  }
  return null;
}
