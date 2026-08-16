// Two views of the same edge, and what their disagreement means.
//
// Until now delivery was checked from the panel only: fetch the playlist over
// the network and see what comes back. That answers "can a viewer get this"
// and stops there — a failure could be Nimble, the machine's firewall, the
// route between, or the panel's own network, and those are four different
// repairs.
//
// With an agent on the edge the same question has a second half, asked over
// loopback where nothing can intervene. The pair is what carries the meaning:
//
//   inside ok, outside ok      serving, and reachable — nothing to do
//   inside ok, outside failed  Nimble is fine; the path to it is not
//   inside failed, outside ok  impossible unless they asked different things
//   inside failed, outside f.  Nimble is not serving this stream
//
// The third row is the one worth keeping: a combination that cannot happen
// means the check is comparing two different questions, and reporting it as a
// verdict about the machine would be worse than saying nothing.

export function reconcile({ inside, outside }) {
  const insideOk = inside?.first?.status === 200;
  const outsideOk = outside?.ok === true || outside?.status === 200;

  if (inside == null) {
    return {
      verdict: 'outside-only',
      // Not a fault: most machines have no agent, and this is what the panel
      // has always been able to say.
      why: 'no agent on this machine, so only the view from the panel is available',
      servedInside: null, servedOutside: outsideOk,
    };
  }

  const base = { servedInside: insideOk, servedOutside: outsideOk };

  if (insideOk && outsideOk) {
    // Both work — but a playlist that is not moving is a dead stream that
    // answers 200, and only the inside view watched it long enough to know.
    if (inside.moving === false) {
      return { ...base, verdict: 'stale', why: 'the playlist is served but its media sequence is not advancing' };
    }
    return { ...base, verdict: 'ok', why: 'served here and reachable from the panel' };
  }

  if (insideOk && !outsideOk) {
    return {
      ...base, verdict: 'unreachable',
      why: 'Nimble serves this on the machine itself; the panel cannot reach it — a firewall, a route, or the wrong address',
    };
  }

  if (!insideOk && outsideOk) {
    return {
      ...base, verdict: 'contradictory',
      why: 'the panel is served and the machine is not, which cannot both be true of one stream — the two checks are asking different things',
    };
  }

  return {
    ...base, verdict: 'not-served',
    why: inside?.first?.error || `Nimble answered ${inside?.first?.status ?? 'nothing'} on loopback`,
  };
}

// How well the cache is working, from figures read on the machine.
//
// Nimble exposes no hit counters — confirmed against a live fleet — so the
// only available measure is amplification: bytes out over bytes in. An edge
// pulling once and serving many is doing its job; an edge pulling as much as
// it serves is not caching at all.
//
// Refused rather than guessed when the preconditions are absent. "Not measured"
// and "measured as bad" are different answers, and the panel has said so
// everywhere else.
export function cacheFromInside(status) {
  if (!status) return { measured: false, why: 'the management API did not answer' };

  const out = Number(status.OutBytes);
  const inn = Number(status.InBytes);
  const used = Number(status.RamCacheSize) + Number(status.FileCacheSize || 0);
  const capacity = Number(status.MaxRamCacheSize) + Number(status.MaxFileCacheSize || 0);

  const occupancy = Number.isFinite(used) && Number.isFinite(capacity) && capacity > 0
    ? { usedMb: used, capacityMb: capacity, percent: Math.round((used / capacity) * 100) }
    : null;

  if (!Number.isFinite(out) || !Number.isFinite(inn) || inn <= 0) {
    return {
      measured: false,
      occupancy,
      // An idle edge pulls nothing and serves nothing, which is a healthy
      // state for a pull cache and not a measurement.
      why: 'no traffic counters, or nothing is being pulled — an idle edge is normal, not broken',
    };
  }

  const amplification = out / inn;
  return {
    measured: true,
    occupancy,
    amplification: Math.round(amplification * 100) / 100,
    // The doctrine figure: on live, request coalescing should make an edge
    // serve many times what it pulls. Around one means every viewer is costing
    // an upstream fetch.
    caching: amplification > 1.5,
  };
}
