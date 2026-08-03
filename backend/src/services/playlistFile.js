// Reading Nimble's server-playlist.json, as it actually is.
//
// Built against a file taken from a running server rather than from the shape
// I expected. Two things that would otherwise have been guessed wrong:
//
//   * a Task's playable items are nested one level deeper than they look —
//     Tasks[].Blocks[].Streams[], not Tasks[].Streams[];
//   * the same media file appears many times in one block. The working file
//     interleaves three adverts between every match, so 24 entries describe 8
//     matches. Counting distinct sources and counting entries give very
//     different numbers, and both are worth showing.
//
// Nothing here writes. Parsing is separated from deploying on purpose: reading
// a live broadcast config should not be able to damage it.

/**
 * Parse the file's text into something the panel can describe.
 *
 * Never throws on bad input: an unreadable playlist is a fact to report, not
 * an exception to swallow somewhere up the stack.
 */
export function parsePlaylistFile(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return { ok: false, reason: 'empty', bytes: 0 };

  let doc;
  try { doc = JSON.parse(raw); }
  catch (e) { return { ok: false, reason: 'invalid JSON', detail: String(e.message).slice(0, 160), bytes: raw.length }; }

  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.Tasks)) {
    return { ok: false, reason: 'no Tasks array — this is not a Nimble playlist', bytes: raw.length };
  }

  const tasks = doc.Tasks.map((task, ti) => {
    const blocks = Array.isArray(task.Blocks) ? task.Blocks : [];
    const items = blocks.flatMap((b, bi) => (Array.isArray(b.Streams) ? b.Streams : []).map((s, si) => ({
      blockIndex: bi,
      blockId: b.Id ?? null,
      index: si,
      type: s.Type ?? null,
      source: typeof s.Source === 'string' ? s.Source : null,
    })));
    return {
      index: ti,
      stream: typeof task.Stream === 'string' ? task.Stream : '',
      inactivityTimeout: Number.isFinite(task.InactivityTimeout) ? task.InactivityTimeout : null,
      blocks: blocks.map((b, bi) => ({
        index: bi,
        id: b.Id ?? null,
        // 0 means "forever" in this format, and an operator reading "0
        // iterations" would conclude the opposite.
        maxIterations: Number.isFinite(b.MaxIterations) ? b.MaxIterations : null,
        loops: b.MaxIterations === 0,
        count: Array.isArray(b.Streams) ? b.Streams.length : 0,
      })),
      items,
      // Entries and distinct files are different questions: 24 entries here
      // are 11 files, because the adverts repeat.
      count: items.length,
      distinct: new Set(items.map(i => i.source).filter(Boolean)).size,
    };
  });

  return {
    ok: true,
    bytes: raw.length,
    syncInterval: Number.isFinite(doc.SyncInterval) ? doc.SyncInterval : null,
    tasks,
    // Every path the file depends on, once each — this is what gets checked
    // against the filesystem.
    sources: [...new Set(tasks.flatMap(t => t.items.map(i => i.source)).filter(Boolean))],
    // Anything the panel does not model is kept so a deploy cannot quietly
    // drop it. Whatever else Nimble grows, we hand it back unchanged.
    unknownKeys: Object.keys(doc).filter(k => !['SyncInterval', 'Tasks'].includes(k)),
  };
}

/**
 * Is what the panel holds the same as what is on the server?
 *
 * Compared as parsed structure rather than as text: whitespace and key order
 * are not differences an operator cares about, and reporting them as such
 * would make the comparison useless the first time someone reformatted a file.
 */
export function comparePlaylists(serverText, panelModel) {
  const norm = (v) => JSON.stringify(v, (k, val) => {
    if (Array.isArray(val)) return val;
    if (val && typeof val === 'object') {
      return Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)));
    }
    return val;
  });

  let onServer = null;
  try { onServer = JSON.parse(String(serverText ?? '')); } catch { /* handled below */ }
  if (!onServer) return { comparable: false, reason: 'the file on the server could not be parsed' };
  if (!panelModel) return { comparable: false, reason: 'nothing in the panel to compare against' };

  return { comparable: true, same: norm(onServer) === norm(panelModel) };
}
