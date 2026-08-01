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
  // Operator-defined position in the servers list.
  order: { type: Number, default: 0 },
  wmspanelServerId: { type: String, default: '' },
  // Auto-sync metadata (WMSPanel control plane pulls the fleet automatically).
  syncedFromWmspanel: { type: Boolean, default: false },
  wmspanelStatus: { type: String, default: '' },   // online/offline/pending as reported by WMSPanel
  lastSyncAt: { type: Date, default: null },
}, { timestamps: true });

export const NimbleServer = mongoose.model('NimbleServer', serverSchema);
