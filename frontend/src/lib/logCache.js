// Leaving a log page and coming back meant waiting for the aggregation again,
// with an empty table in the meantime. During an incident that is the whole
// difference between a tool and an obstacle: an operator flips between the
// logs, a server and back several times a minute, and each hop cost seconds of
// blank screen.
//
// So results are kept for a short while and shown at once, while a fresh query
// runs behind them. The stale answer is on screen in the first frame; the
// fresh one replaces it when it lands.
//
// In memory on purpose. This is a view cache, not a store: it must not outlive
// the tab, it must never be what an operator is looking at after a reload, and
// nothing here is worth writing to disk.

const TTL_MS = 60_000;
// Bounded: each entry can hold a few hundred grouped rows, and an operator
// tuning filters produces a new key every keystroke.
const MAX_ENTRIES = 40;

const entries = new Map();   // key -> { at, data }
const filters = new Map();   // page -> last filter state

export function cacheGet(key, { maxAgeMs = TTL_MS } = {}) {
  const hit = entries.get(key);
  if (!hit) return null;
  // `>=`, not `>`: a caller passing maxAgeMs: 0 means "do not use the cache",
  // and a strict comparison served the entry anyway whenever no time had
  // passed since it was written.
  if (Date.now() - hit.at >= maxAgeMs) { entries.delete(key); return null; }
  // Re-inserting keeps the map in least-recently-used order.
  entries.delete(key);
  entries.set(key, hit);
  return { data: hit.data, ageMs: Date.now() - hit.at };
}

export function cacheSet(key, data) {
  entries.delete(key);
  entries.set(key, { at: Date.now(), data });
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
}

export function cacheClear() { entries.clear(); }

// The filters themselves are worth keeping too: coming back to a page that has
// forgotten which server and level you had chosen is the same annoyance in a
// different place.
export function rememberFilters(page, state) { filters.set(page, state); }
export function recallFilters(page, fallback) { return filters.get(page) ?? fallback; }
