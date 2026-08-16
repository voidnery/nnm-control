import { NimbleServer } from '../models/NimbleServer.js';
import { nimble } from './nimbleClient.js';
import { playbackPath } from './protocols.js';
import { reconcile, cacheFromInside } from './insideOutside.js';
import { runTask } from './agentBus.js';
import { agentIsLive } from './nimbleClient.js';
import { parsePlaylist, movedOn, classifyProbe } from './playlistProbe.js';

// Being the viewer, for one channel, on every edge of its network.
//
// Lifted out of the route so the scheduled monitor and the button run exactly
// the same code. Two implementations of "is it arriving" would drift, and the
// drift would show up as a history that disagrees with the page an operator is
// looking at — which is worse than having no history.
export async function probeChannel(network, channel) {
  const servers = await NimbleServer.find();
  const byId = new Map(servers.map(s => [String(s._id), s]));
  const path = playbackPath(channel.protocol, channel.application, channel.stream);

  const targets = (network.nodes || [])
    .filter(n => n.role === 'edge' && n.enabled !== false)
    .map(n => byId.get(String(n.server)))
    .filter(Boolean);

  const once = async (url) => {
    const started = Date.now();
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
      const text = r.status === 200 ? await r.text() : '';
      return { status: r.status, ms: Date.now() - started, playlist: r.status === 200 ? parsePlaylist(text) : null };
    } catch (e) {
      return { error: String(e?.message || e), ms: Date.now() - started };
    }
  };

  const results = await Promise.all(targets.map(async (srv) => {
    const url = `http://${srv.host}:${srv.httpPort || 8081}${path}`;

    // Asked of the machine as well as over the network, when it can answer.
    //
    // The panel's own fetch says whether a viewer could get this. It cannot
    // say why not: Nimble, the machine's firewall, the route between, and the
    // panel's own network all look the same from here. Loopback crosses none
    // of those, so the pair separates "not serving" from "not reachable" —
    // and that is a different repair.
    //
    // Attempted only where an agent is live, and its absence is a fact about
    // the fleet rather than a failure of the check.
    const inside = agentIsLive(srv) && (srv.agent?.version ?? 0) >= 29
      ? await runTask(srv, 'POST /nimble/delivery', {
          body: { app: channel.application, stream: channel.stream, path, httpPort: srv.httpPort || 8081 },
          timeoutMs: 30_000, createdBy: 'probe',
        }).catch(e => ({ first: { status: null, error: String(e?.message || e).slice(0, 160) } }))
      : null;

    const first = await once(url);
    // The second reading only when there is something to compare. A scheduled
    // check that always waits six seconds per edge spends most of its life
    // asleep, and on an edge that already failed there is nothing to learn.
    let advanced = null;
    if (first.status === 200 && first.playlist?.valid && first.playlist.kind === 'media') {
      await new Promise(r => setTimeout(r, Math.min(6000, (first.playlist.targetDuration || 4) * 1000 + 500)));
      const second = await once(url);
      advanced = movedOn(first.playlist, second.playlist);
    }
    const outside = { ok: first.status === 200, status: first.status ?? null };
    return {
      server: srv.name, url, status: first.status ?? null, ms: first.ms,
      verdict: classifyProbe({ ...first, advanced }),
      // What the machine says of itself, and what the two views together mean.
      // Null where no agent could answer — an unasked question, not a failed
      // one.
      inside: inside ? {
        served: inside.first?.status === 200,
        status: inside.first?.status ?? null,
        ms: inside.first?.ms ?? null,
        moving: inside.moving ?? null,
        error: inside.first?.error || null,
      } : null,
      reconciled: reconcile({ inside, outside }),
      cache: inside ? cacheFromInside(inside.status) : null,
    };
  }));

  return { results, path };
}
