// Cache effectiveness, asked in the form the data can answer.
//
// Nimble reports no hit or miss counters — confirmed twice now, empirically
// from three edges and from Softvelum's own documentation. So hit ratio is
// unobtainable, and pretending otherwise would mean inventing a number.
//
// But the question behind hit ratio is answerable. What an operator wants to
// know is whether the cache is absorbing load: do a thousand viewers cause one
// fetch upstream, or a thousand? That is a comparison of two traffic figures
// the server does report —
//
//   amplification = bytes served to viewers ÷ bytes pulled from the origin
//
// ≈ 1 means every viewer's request went upstream and the cache is doing
// nothing. ≈ the viewer count means it is doing everything. It is not hit
// ratio and is not called hit ratio; it answers the same question with
// arithmetic that holds.
//
// The preconditions matter more than the formula, and each one is checked
// rather than assumed, because a ratio computed outside them is confidently
// wrong:
//
//   - The box must be re-streaming only. An origin also ingests SRT, and that
//     ingest lands in the same "in" figure, which would make a working cache
//     look broken.
//   - Somebody must be watching. With no viewers both numbers approach zero
//     and their ratio is noise.
//   - The two figures must cover the same window. Comparing an instantaneous
//     rate against a lifetime counter is not a ratio of anything.

// Traffic fields, matched by meaning: the exact names are not in any document
// we have, and every name taken from documentation in this project has been
// wrong. What is certain is that `statsCollector` already flattens every
// number in the response, so whatever they are called, they are being kept.
// Matched on whole words within the name rather than by substring. `in` is a
// substring of half the English language — `Interfaces` is a field on this very
// endpoint — so a substring match would classify traffic that is not traffic.
// And a direction can sit at either end: `InRate` and `TotalBytesIn` are both
// real shapes.
const tokens = (key) => String(key)
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .split(/[^A-Za-z0-9]+/)
  .filter(Boolean)
  .map(t => t.toLowerCase());

const OUT_WORDS = new Set(['out', 'sent', 'tx', 'egress', 'upload', 'outgoing']);
const IN_WORDS = new Set(['in', 'recv', 'received', 'rx', 'ingress', 'download', 'incoming']);
const direction = (key) => {
  const t = tokens(key);
  if (t.some(x => OUT_WORDS.has(x))) return 'out';
  if (t.some(x => IN_WORDS.has(x))) return 'in';
  return null;
};
// Anything measured per second rather than accumulated. Mixing the two is the
// error the preconditions exist to prevent.
const RATE_KEY = /rate|bandwidth|bps|per_?sec/i;
export { direction, tokens };

const numeric = (v) => typeof v === 'number' && Number.isFinite(v);

export function findTrafficFields(payload, prefix = '', out = []) {
  if (!payload || typeof payload !== 'object') return out;
  for (const [k, v] of Object.entries(payload)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      findTrafficFields(v, path, out);
    } else if (numeric(v)) {
      const dir = direction(k);
      if (dir) out.push({ path, key: k, value: v, direction: dir, rate: RATE_KEY.test(k) });
    }
  }
  return out;
}

// Whether this reading can support the comparison at all. Returned as reasons
// rather than a boolean, because "we cannot tell you" is only useful with the
// because.
export function amplificationPreconditions({ node, viewers, fields }) {
  const blocking = [];
  // A box that ingests as well as serves mixes source traffic into the same
  // figure. Only a pure edge gives a clean comparison.
  if (node?.role && node.role !== 'edge') blocking.push('not-an-edge');
  if (!(Number(viewers) > 0)) blocking.push('no-viewers');
  const outs = fields.filter(f => f.direction === 'out');
  const ins = fields.filter(f => f.direction === 'in');
  if (!outs.length || !ins.length) blocking.push('no-traffic-fields');
  // Both must be the same kind of number.
  else if (outs[0].rate !== ins[0].rate) blocking.push('mismatched-units');
  return blocking;
}

export function amplification({ status, node, viewers = 0 }) {
  const fields = findTrafficFields(status);
  const blocking = amplificationPreconditions({ node, viewers, fields });
  const out = fields.find(f => f.direction === 'out');
  const inn = fields.find(f => f.direction === 'in');

  if (blocking.length) {
    return { ok: false, blocking, out: out || null, in: inn || null };
  }
  if (!(inn.value > 0)) {
    // Serving with nothing coming in is not infinite amplification — it is a
    // window in which the edge served entirely from cache, which is worth
    // saying in words rather than as a division by zero.
    return { ok: true, ratio: null, code: 'served-entirely-from-cache',
             out: out, in: inn, viewers };
  }
  const ratio = out.value / inn.value;
  return {
    ok: true,
    ratio: Math.round(ratio * 100) / 100,
    // Against the audience: with N viewers a working cache approaches N, and a
    // cache doing nothing sits near 1. The comparison is what makes the number
    // mean something.
    viewers,
    efficiency: viewers > 0 ? Math.round((ratio / viewers) * 1000) / 10 : null,
    code: ratio < 1.5 ? 'cache-not-absorbing' : ratio >= viewers * 0.8 ? 'cache-absorbing' : 'cache-partial',
    out, in: inn,
    from: [out.path, inn.path],
  };
}
