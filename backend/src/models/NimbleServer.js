import mongoose from 'mongoose';
import { encryptField, decryptField } from '../services/fieldCrypto.js';

// A managed Nimble Streamer instance (its native management API endpoint).
// SECURITY NOTE: management token is stored as-is in Mongo (needed to sign
// every request). Mitigations: Mongo is not published outside the docker
// network; restrict management_listen_interfaces on the Nimble side to the
// panel's IP / VPN subnet. Encrypted-at-rest storage is an Iter2+ candidate.
const serverSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  host: { type: String, required: true, trim: true },   // IP or hostname
  port: { type: Number, default: 8082 },                // management_port
  token: { type: String, default: '', set: encryptField, get: decryptField },                 // management_token ('' = no auth)
  useSsl: { type: Boolean, default: false },
  tags: { type: [String], default: [] },
  notes: { type: String, default: '' },
  // WMSPanel server id (from GET /v1/server) — required for WMSPanel control
  // plane operations on this instance.
  // Playback endpoints an operator can watch this server's streams through.
  // A box often answers on its IP plus several domain names, and each protocol
  // may sit on its own port, so this is a list rather than one address.
  playbackEndpoints: {
    type: [new mongoose.Schema({
      label: { type: String, default: '' },
      host: { type: String, required: true, trim: true },
      hlsPort: { type: Number, default: 8081 },
      rtmpPort: { type: Number, default: 1935 },
      ssl: { type: Boolean, default: false },
    }, { _id: false })],
    default: [],
  },
  // iter9 m2 — HTTP port Nimble serves its HTTP-based playback protocols on
  // (HLS, MPEG-DASH, SLDP, Icecast, WebRTC WHEP). It lives in nimble.conf and
  // is not exposed by any WMSPanel endpoint we have, so it cannot be derived
  // like the RTMP port can. 0 = not set by the operator, in which case the
  // resolver falls back to Nimble's documented default and says so.
  httpPort: { type: Number, default: 0 },
  // Optional file-access agent. Absent for servers where the operator has not
  // installed it; the panel works fully without it.
  // iter12 m5 — there is no address here on purpose. The agent connects to
  // the panel; the panel never connects to the agent, so how to reach the
  // server is not something this system needs to know or store.
  agent: {
    enabled: { type: Boolean, default: false },
    token: { type: String, default: '', set: encryptField, get: decryptField },
    // Filled in by the agent itself on every poll.
    lastContactAt: { type: Date, default: null },
    instanceId: { type: String, default: '' },   // changes when the agent restarts
    version: { type: Number, default: 0 },
    // iter12 m4 — a restarting agent still polls, so it looks alive. Counting
    // identity changes inside a window is what separates "running" from
    // "coming back".
    restarts: { type: Number, default: 0 },
    restartWindowStart: { type: Date, default: null },
    lastHealth: { type: mongoose.Schema.Types.Mixed, default: null },
    // iter15 m1 — which NICs to graph on this box. Per-server because the
    // machines differ; empty means every physical interface, which is what
    // /sys/class/net/<if>/device distinguishes from bridges and veth pairs.
    interfaces: { type: [String], default: [] },
  },
  // iter10 m1 — Nimble stamps log lines with local time and no zone marker.
  // Minutes east of UTC for this box, so a fleet spanning zones stays
  // comparable. 0 means "treat the stamps as UTC".
  logTzOffsetMinutes: { type: Number, default: 0 },
  // The names WMSPanel knows this box by. Read-only, refreshed on sync: they
  // are the operator's answer to "how is this server addressed publicly", and
  // a redirect gateway needs exactly that to stop revealing edge IPs.
  //
  // Their absence is why the panel used to ask for a playback endpoint before
  // it would admit an edge had a name.
  wmspanelDomains: { type: [String], default: [] },
  // What this machine is for.
  //
  // Until now every server was assumed to run Nimble, because every server
  // did. A CDN gateway does not: it terminates TLS, resolves a viewer to an
  // edge and forwards — there is no media server on it at all, and half of
  // what the panel checks about a server is meaningless there.
  //
  // Naming it means the panel can stop reporting a gateway as a broken Nimble
  // host, and can offer the right work on the right machine instead of the
  // union of everything.
  //
  //   nimble     — a media server, and nothing to do with a delivery network
  //   nimble-cdn — a media server that is also a node in a network
  //   gateway    — a machine for the network only: no Nimble on it
  //
  // Defaulting to `nimble` because that is what every existing server is, and
  // a migration that silently reclassifies a fleet is worse than a field that
  // starts conservative.
  purpose: { type: String, enum: ['nimble', 'nimble-cdn', 'gateway'], default: 'nimble' },

  // The machine's own last report about what it has. Kept so a fleet can be
  // shown at a glance without asking every box on every render — and stamped,
  // because a reading from last week is not a statement about now.
  lastReadiness: { type: Object, default: null },
  lastReadinessAt: { type: Date, default: null },

  // The TLS port this box answers playback on, and what was found there.
  //
  // `httpsPort` is the operator's answer to "where"; `tls` is the panel's
  // answer to "and what is actually there", filled by a handshake rather than
  // by a checkbox. LL-HLS needs HTTP/2 over TLS and falls back silently
  // without it, so a claim would be worse than nothing: everything would look
  // configured and the latency would not change.
  httpsPort: { type: Number, default: 0 },
  tls: {
    checkedAt: { type: Date, default: null },
    tls: { type: Boolean, default: false },
    http2: { type: Boolean, default: false },
    alpn: { type: String, default: '' },
    certTrusted: { type: Boolean, default: false },
    certExpiresAt: { type: Date, default: null },
    reason: { type: String, default: '' },
  },
  // iter20 m1 — where this box physically is, for delivery-network planning.
  //
  // Two provenances kept apart on purpose. `source` says whether the country
  // came from the offline DB-IP database or from a person; `coordsSource` says
  // the same about the coordinates, separately, because the two do not arrive
  // together: the Country edition resolves a country and carries no
  // coordinates at all. Collapsing them into one field is how a globe ends up
  // showing a marker nobody can account for.
  //
  // Neither is authoritative over the other — a manual entry always wins and
  // is never overwritten by a resolve, since the operator knows which rack the
  // machine is in and DB-IP is inferring it from a routing prefix.
  geo: {
    countryCode: { type: String, default: '' },     // ISO-3166 alpha-2
    countryName: { type: String, default: '' },
    city: { type: String, default: '' },
    lat: { type: Number, default: null },
    lon: { type: Number, default: null },
    source: { type: String, enum: ['', 'auto', 'manual'], default: '' },
    coordsSource: { type: String, enum: ['', 'auto', 'manual'], default: '' },
    // What was actually looked up. `host` may be a name, and which address it
    // resolved to is the difference between a useful answer and a puzzling one.
    resolvedIp: { type: String, default: '' },
    resolvedAt: { type: Date, default: null },
    edition: { type: String, default: '' },
    release: { type: String, default: '' },
  },
  // Operator-defined position in the servers list.
  order: { type: Number, default: 0 },
  wmspanelServerId: { type: String, default: '' },
  // Auto-sync metadata (WMSPanel control plane pulls the fleet automatically).
  syncedFromWmspanel: { type: Boolean, default: false },
  wmspanelStatus: { type: String, default: '' },   // online/offline/pending as reported by WMSPanel
  lastSyncAt: { type: Date, default: null },
}, { timestamps: true });

export const NimbleServer = mongoose.model('NimbleServer', serverSchema);
