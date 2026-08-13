import { DeliveryNetwork } from '../models/DeliveryNetwork.js';
import { Channel } from '../models/Channel.js';
import { DeliveryCheck } from '../models/DeliveryCheck.js';

// Asking, on a schedule, rather than when somebody remembers.
//
// A check only run by hand answers "is it working" at the moment somebody was
// already worried. The useful answer — was it working at 3am, did it hold
// through the second half — needs the question asked when nobody is watching.
//
// Three things this deliberately does not do:
//
//   - It does not probe every channel at once. Being the viewer means fetching
//     a playlist from each edge, twice, and a fleet-wide sweep every minute is
//     the panel becoming the load it was built to measure.
//   - It does not run without being switched on. A panel that starts making
//     requests to production because it was installed is a panel nobody
//     installs twice.
//   - It does not treat its own failure as a channel's. A check that could not
//     run is recorded as not run, not as a channel that was down — otherwise
//     the history reports an outage every time the panel restarts.
//
// `probe` is injected: the whole schedule can be tested in milliseconds
// against a function, with no fleet and no clock.

export const DEFAULT_INTERVAL_MIN = 5;

export function dueChannels(channels, { now = new Date(), intervalMin = DEFAULT_INTERVAL_MIN, lastByChannel = new Map() } = {}) {
  const cutoff = now.getTime() - intervalMin * 60_000;
  return channels.filter(c => {
    const last = lastByChannel.get(String(c.id ?? c._id));
    return !last || new Date(last).getTime() <= cutoff;
  });
}

// One pass. Returns what it did rather than logging it, so the caller decides
// what is worth saying and the tests can read it.
export async function runOnce({ probe, now = new Date(), intervalMin = DEFAULT_INTERVAL_MIN, by = 'schedule' }) {
  const networks = await DeliveryNetwork.find({ 'monitor.enabled': true });
  const out = { networks: 0, checked: 0, skipped: 0, failed: 0 };

  for (const net of networks) {
    const channels = await Channel.find({ network: net._id, enabled: true });
    if (!channels.length) continue;
    out.networks++;

    // What each channel's last check was, so a channel checked a minute ago is
    // left alone. Without this a slow pass overlaps the next one and the fleet
    // gets asked twice as often as configured.
    const recent = await DeliveryCheck.find({ network: net._id })
      .sort({ at: -1 }).limit(channels.length * 3);
    const lastByChannel = new Map();
    for (const r of recent) {
      const k = String(r.channel);
      if (!lastByChannel.has(k)) lastByChannel.set(k, r.at);
    }

    const due = dueChannels(channels, { now, intervalMin: net.monitor?.intervalMin || intervalMin, lastByChannel });
    out.skipped += channels.length - due.length;

    for (const c of due) {
      let result;
      try {
        result = await probe(net, c);
      } catch {
        // The panel could not ask. That is not the channel being down, and
        // recording it as one would report an outage every restart.
        out.failed++;
        continue;
      }
      const results = result?.results || [];
      await DeliveryCheck.create({
        network: net._id, channel: c._id,
        application: c.application, stream: c.stream,
        at: now,
        ok: results.filter(r => r.verdict?.ok).length,
        total: results.length,
        codes: [...new Set(results.map(r => r.verdict?.code).filter(Boolean))],
        worstMs: results.reduce((m, r) => (r.ms != null && (m == null || r.ms > m) ? r.ms : m), null),
        by,
      });
      out.checked++;
    }
  }
  return out;
}

// The loop, kept apart from the pass so that starting and stopping is not
// entangled with what a pass does.
export function startMonitor({ probe, intervalMs = 60_000, onError = () => {} }) {
  let timer = null;
  let running = false;

  const tick = async () => {
    // Overlap protection. A pass slower than the interval would otherwise
    // start again on top of itself, and the fleet would be asked by two passes
    // at once — the panel becoming the load.
    if (running) return;
    running = true;
    try { await runOnce({ probe }); }
    catch (e) { onError(e); }
    finally { running = false; }
  };

  timer = setInterval(tick, intervalMs);
  // Not on a Node process's account: an interval that keeps the process alive
  // turns a graceful shutdown into a wait.
  timer.unref?.();
  return () => { clearInterval(timer); timer = null; };
}
