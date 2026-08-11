// Measuring paths the panel is not on.
//
// Whether an edge in Amsterdam can reach an origin in Moscow is a fact about
// those two machines. The panel sits on neither, so it asks the agent on one
// of them — which is the whole reason agents exist, and the reason a node with
// no agent simply cannot be measured from. That is reported as a gap, not
// filled in from the panel's own vantage point, which would answer a different
// question and look identical.

export const PROBE_ROUTE = 'POST /probe';
// The agent build that first carried it. Older agents answer "no handler for
// POST /probe", and a fleet is never uniformly upgraded — so the node is
// reported as too old to measure from rather than as unreachable.
export const PROBE_MIN_AGENT = 20;

// One matrix cell, from the point of view of the node doing the asking.
const cell = (from, to, result) => ({
  from: from.name, to: to.name,
  host: to.host, port: to.port,
  ok: Boolean(result?.okCount),
  attempts: result?.attempts ?? null,
  okCount: result?.okCount ?? null,
  // Loss is only meaningful once something answered at least once; a target
  // that never answered is unreachable, which is a different word.
  lossPct: result && result.attempts ? Math.round(100 * (1 - result.okCount / result.attempts)) : null,
  minMs: result?.minMs ?? null,
  avgMs: result?.avgMs ?? null,
  maxMs: result?.maxMs ?? null,
  // A path answering in 12ms four times and 900ms once is not a 190ms path.
  // The spread is what an operator needs to see, so it is computed rather than
  // left for them to subtract.
  jitterMs: (result?.maxMs != null && result?.minMs != null)
    ? Math.round((result.maxMs - result.minMs) * 10) / 10 : null,
  error: result?.error ?? null,
});

// What each node should be asked to reach: every other node of the network, on
// the port that actually carries the stream between them.
export function matrixTargets(nodes) {
  const out = new Map();   // node id -> targets[]
  for (const from of nodes) {
    out.set(String(from.id), nodes
      .filter(to => String(to.id) !== String(from.id))
      .map(to => ({ id: `node:${to.id}`, host: to.host, port: to.port })));
  }
  return out;
}

// A reference point that fails from every node that could be asked is far more
// likely to be a stale entry in our own list than a region that has gone dark.
// Saying so is the difference between an operator editing a hostname and an
// operator investigating a network that is fine.
export function classifyReferenceResults(rows, { probedNodes }) {
  const byPoint = new Map();
  for (const r of rows) {
    const cur = byPoint.get(r.pointId) || { pointId: r.pointId, label: r.label, country: r.country, ok: 0, total: 0 };
    cur.total++;
    if (r.ok) cur.ok++;
    byPoint.set(r.pointId, cur);
  }
  const suspect = [];
  for (const p of byPoint.values()) {
    if (p.total >= Math.min(2, probedNodes) && p.ok === 0) {
      suspect.push({ ...p, code: 'reference-unreachable-everywhere' });
    }
  }
  return { perPoint: [...byPoint.values()], suspect };
}

// `ask` is injected so every rule above is testable without an agent, a
// network, or a server.
export async function runProbes({ nodes, targetsByNode, ask }) {
  const rows = [];
  const skipped = [];

  for (const from of nodes) {
    const targets = targetsByNode.get(String(from.id)) || [];
    if (!targets.length) continue;

    if (!from.agentLive) {
      // Deliberately not falling back to probing from the panel: the panel is
      // somewhere else, and a number labelled "from this edge" that was not
      // taken from it is worse than no number.
      skipped.push({ node: from.name, code: from.agentEnabled ? 'agent-not-answering' : 'no-agent' });
      continue;
    }
    if (from.agentVersion != null && from.agentVersion < PROBE_MIN_AGENT) {
      skipped.push({ node: from.name, code: 'agent-too-old', have: from.agentVersion, need: PROBE_MIN_AGENT });
      continue;
    }

    let answer;
    try { answer = await ask(from, targets); }
    catch (e) {
      skipped.push({ node: from.name, code: 'probe-failed', error: String(e?.message || e).slice(0, 200) });
      continue;
    }
    const byId = new Map((answer?.results || []).map(r => [String(r.id), r]));
    for (const t of targets) rows.push({ fromNode: from, target: t, result: byId.get(String(t.id)) || null });
  }
  return { rows, skipped };
}

export { cell };
