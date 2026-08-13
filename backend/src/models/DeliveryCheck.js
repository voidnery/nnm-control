import mongoose from 'mongoose';

// A history of "did it actually arrive", rather than the last answer only.
//
// One reading tells you about one moment. An operator asking whether a channel
// held up during a match is asking about a stretch of time, and the panel has
// been throwing that away: the probe ran, the page showed it, the next request
// forgot it.
//
// Deliberately small. One row per channel per check — not per edge — because
// the question is about the channel, and an edge that was serving while
// another was not is already visible in the check itself. Storing every edge
// of every check would grow this by the size of the fleet for an answer nobody
// asks at that granularity.
const checkSchema = new mongoose.Schema({
  network: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryNetwork', required: true, index: true },
  channel: { type: mongoose.Schema.Types.ObjectId, ref: 'Channel', default: null },
  application: { type: String, default: '' },
  stream: { type: String, default: '' },

  at: { type: Date, default: Date.now, index: true },
  // How many edges answered with something playable, out of how many were
  // asked. Both, because 2 of 2 and 2 of 5 are different sentences.
  ok: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  // The verdict codes the probe produced, kept so a run of failures can be
  // read without guessing which kind they were: a 404 for a whole evening is a
  // missing route, a timeout for a whole evening is a network.
  codes: { type: [String], default: [] },
  // Slowest edge in this check. A channel that serves everywhere in 4 seconds
  // is technically fine and practically broken.
  worstMs: { type: Number, default: null },
  // Who or what asked. A scheduled check and somebody pressing a button are
  // different evidence: the first says the channel was fine at 3am, the second
  // says somebody was worried.
  by: { type: String, default: '' },
}, { timestamps: false });

// Old checks stop being interesting long before they stop taking up space.
// Thirty days covers "how did last month's tournament go" and keeps a busy
// fleet from accumulating forever without anybody deciding to.
checkSchema.index({ at: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
checkSchema.index({ network: 1, at: -1 });

export const DeliveryCheck = mongoose.model('DeliveryCheck', checkSchema);

// Availability over a window, computed from checks rather than from the last
// one. Returns null rather than 100% when nothing was checked: an untested
// channel is not a perfect one, and that distinction is the whole point of
// keeping the history.
export function availability(checks, { since = null } = {}) {
  const rows = since ? checks.filter(c => new Date(c.at) >= since) : checks;
  if (!rows.length) return null;

  const served = rows.filter(c => c.total > 0 && c.ok === c.total).length;
  const partial = rows.filter(c => c.total > 0 && c.ok > 0 && c.ok < c.total).length;
  const failed = rows.filter(c => c.total > 0 && c.ok === 0).length;

  // Partial counts as neither: an edge down while others serve is a real
  // problem and not an outage, and averaging it into a percentage hides which
  // of the two happened.
  return {
    checks: rows.length,
    served, partial, failed,
    pct: Math.round((served / rows.length) * 1000) / 10,
    firstAt: rows[rows.length - 1]?.at || null,
    lastAt: rows[0]?.at || null,
    // The codes seen while failing, most common first — the difference between
    // "it was down" and knowing why.
    reasons: topCodes(rows.filter(c => c.ok < c.total)),
    worstMs: rows.reduce((m, c) => (c.worstMs != null && (m == null || c.worstMs > m) ? c.worstMs : m), null),
  };
}

function topCodes(rows) {
  const count = new Map();
  for (const r of rows) {
    for (const c of r.codes || []) count.set(c, (count.get(c) || 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([code, n]) => ({ code, n }));
}
