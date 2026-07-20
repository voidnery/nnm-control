import mongoose from 'mongoose';

// A managed Nimble Streamer instance (its native management API endpoint).
// SECURITY NOTE: management token is stored as-is in Mongo (needed to sign
// every request). Mitigations: Mongo is not published outside the docker
// network; restrict management_listen_interfaces on the Nimble side to the
// panel's IP / VPN subnet. Encrypted-at-rest storage is an Iter2+ candidate.
const serverSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  host: { type: String, required: true, trim: true },   // IP or hostname
  port: { type: Number, default: 8082 },                // management_port
  token: { type: String, default: '' },                 // management_token ('' = no auth)
  useSsl: { type: Boolean, default: false },
  tags: { type: [String], default: [] },
  notes: { type: String, default: '' },
  // WMSPanel server id (from GET /v1/server) — required for WMSPanel control
  // plane operations on this instance.
  wmspanelServerId: { type: String, default: '' },
  // Auto-sync metadata (WMSPanel control plane pulls the fleet automatically).
  syncedFromWmspanel: { type: Boolean, default: false },
  wmspanelStatus: { type: String, default: '' },   // online/offline/pending as reported by WMSPanel
  lastSyncAt: { type: Date, default: null },
}, { timestamps: true });

export const NimbleServer = mongoose.model('NimbleServer', serverSchema);
