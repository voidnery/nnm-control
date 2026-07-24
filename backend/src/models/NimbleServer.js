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
  // Optional file-access agent. Absent for servers where the operator has not
  // installed it; the panel works fully without it.
  agent: {
    enabled: { type: Boolean, default: false },
    baseUrl: { type: String, default: '' },                                  // http://host:8090
    token: { type: String, default: '', set: encryptField, get: decryptField },
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
