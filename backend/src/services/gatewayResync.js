import { NimbleServer } from '../models/NimbleServer.js';
import { gatewayPlan } from './gatewayPlan.js';
import { runTask } from './agentBus.js';

// Keeping an edge-proxy's nginx in step with the network it serves.
//
// The config names the edges, and it was written once — during preparation,
// which happens *before* a machine joins a network. So it pointed at
// `edge.invalid` and the gateway accepted viewers and forwarded them nowhere.
// The panel knew, said so, and left the operator to press a button on another
// page. That is a fact the panel holds and a change only the panel can make:
// leaving it to be noticed and re-applied by hand is the panel declining to do
// its job.
//
// It needs no new access. The privileged helper installed nginx and issued the
// certificate on that machine; rewriting a file it already owns and reloading
// a service it already manages is less than it has done. No credentials are
// stored, and none need to be.
//
// What this deliberately does not do:
//
//   Install anything    Only a machine already prepared is resynced. A machine
//                       that has never been prepared is not quietly turned into
//                       a gateway because somebody added an edge.
//
//   Touch a redirect    A redirect gateway hands out edge addresses computed
//                       per viewer by the arbiter, which reads the network
//                       live. Its config does not name edges, so there is
//                       nothing to go stale.
//
//   Fail the save       The network is saved either way. A machine that cannot
//                       be reached is a fact to report, not a reason to refuse
//                       an operator's edit.

// Steps that only rewrite the configuration and reload.
//
// Taken from the same plan that prepares a machine rather than composed here,
// so the config a resync writes is the config a preparation would write —
// there is exactly one description of what an edge-proxy's nginx looks like.
export function resyncSteps(plan) {
  const KEEP = new Set(['write-conf', 'enable-site', 'test-conf', 'reload']);
  return plan.steps.filter(s => KEEP.has(s.id));
}

export async function resyncGateway({ network, actor = '' } = {}) {
  const gw = network?.gateway;
  // Both modes that put a config on a machine.
  //
  // This refused anything but proxy, on the reasoning — written here, by me —
  // that a redirect config names no edges and so cannot go stale. That is
  // wrong twice: it names them in the map it redirects into, and refusing to
  // resync meant switching the mode in the panel left the machine serving the
  // previous one. An operator selected redirect, saw the stream keep working,
  // and was watching proxy.
  if (!gw || !gw.node) return { skipped: 'no-gateway-machine' };
  if (!['proxy', 'redirect'].includes(gw.mode)) return { skipped: 'direct-mode' };

  const server = await NimbleServer.findById(gw.node).catch(() => null);
  if (!server) return { skipped: 'machine-not-found' };

  // Only a machine that has already been prepared. Adding an edge must not
  // turn an untouched machine into a gateway.
  if (server.gateway?.state !== 'applied') return { skipped: 'never-prepared' };
  if (!server.helper?.seen) return { skipped: 'no-privileged-helper' };

  // A network node holds a reference to a machine and nothing else — no name,
  // no host, no port. Reading `n.host` off it produced undefined for every
  // edge, so the filter dropped them all and the config was rewritten with
  // none: "edge in the config — 0", which is what the panel truthfully
  // reported while the gateway forwarded viewers nowhere.
  //
  // The addresses live on the machine, resolved in the same order the delivery
  // page uses: the Host field the operator typed, then a playback endpoint,
  // then a name synced from WMSPanel.
  const edgeIds = (network.nodes || [])
    .filter(n => n.role === 'edge' && n.enabled !== false)
    .map(n => String(n.server));
  const machines = edgeIds.length
    ? await NimbleServer.find({ _id: { $in: edgeIds } }).catch(() => [])
    : [];
  const edges = machines
    .map(m => ({
      name: m.name,
      host: m.playbackEndpoints?.[0]?.host || m.host || m.wmspanelDomains?.[0] || '',
      httpPort: m.httpPort || 8081,
    }))
    .filter(e => e.host);

  // An edge whose address nobody can resolve is worth naming rather than
  // silently leaving out of the config.
  const addressless = machines.filter(m => !(m.playbackEndpoints?.[0]?.host || m.host || m.wmspanelDomains?.[0]));
  if (!edges.length) {
    return {
      skipped: 'no-edge-addresses',
      machine: server.name,
      edgeCount: edgeIds.length,
      addressless: addressless.map(m => m.name),
    };
  }

  // Ports are not re-read: this changes a file and reloads a service that is
  // already running on them, so who holds them is not in question. Passing an
  // empty reading would make the plan block on `ports-not-checked`.
  const plan = gatewayPlan({
    server,
    domain: gw.domain || server.gateway.domain,
    // The mode the operator chose, not the one this was written against.
    // Hard-coded to proxy, it wrote a proxy config whichever mode was
    // selected — and the difference is invisible in a player, which follows a
    // 302 without saying so. Only the HTTP response tells them apart.
    mode: gw.mode,
    edges,
    ports: { 80: { taken: false, holders: [] }, 443: { taken: false, holders: [] } },
  });
  if (plan.blocking.length) {
    return { skipped: 'plan-blocked', problems: plan.blocking };
  }

  const steps = resyncSteps(plan);
  if (!steps.length) return { skipped: 'nothing-to-write' };

  try {
    const r = await runTask(server, 'POST /host/apply', {
      body: { steps }, timeoutMs: 3 * 60_000, createdBy: actor,
    });
    if (r?.ok) {
      server.gateway.at = new Date();
      server.gateway.edges = edges.length;
      await server.save().catch(() => { /* the machine is written either way */ });
    }
    // The failing step's own output, not just its name. "test-conf" says which
    // step refused and nothing about why — and nginx had put the reason in the
    // very message this discarded.
    const failed = (r?.steps || []).find(x => x.ok === false);
    return {
      ok: Boolean(r?.ok), machine: server.name, edges: edges.length,
      steps: r?.steps || [], haltedAt: r?.halted || null,
      error: failed?.error || null,
    };
  } catch (e) {
    // Reported, not thrown: the operator's edit is saved and this is a fact
    // about a machine, which they can act on.
    return { ok: false, machine: server.name, error: String(e?.message || e).slice(0, 200) };
  }
}
