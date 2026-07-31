import mongoose from 'mongoose';
import { encryptField, decryptField } from '../services/fieldCrypto.js';

// Singleton system settings document.
const settingsSchema = new mongoose.Schema({
  singleton: { type: String, default: 'main', unique: true },
  wmspanel: {
    // Base URL is manageable: api.wmspanel.com and api.wmspanel.ru mirrors exist.
    baseUrl: { type: String, default: 'https://api.wmspanel.com/v1' },
    clientId: { type: String, default: '' },
    apiKey: { type: String, default: '', set: encryptField, get: decryptField },
  },
  // 'wmspanel' — persistent changes via WMSPanel Control API (primary mode).
  // 'native'   — backup mode via Nimble native API (ephemeral rules; limited).
  controlPlane: { type: String, enum: ['wmspanel', 'native'], default: 'native' },
  // How the panel is reachable from outside. Links the panel generates — the
  // agent installer command, a dashboard share link — are built from this when
  // set. Only the operator knows how their proxy publishes the panel, and a
  // reverse proxy that rewrites the Host header makes the request unreliable
  // as a source.
  publicUrl: { type: String, default: '' },
  // Show the SRT settings helper (latency/maxbw/buffers calculator) on SRT tabs.
  srtHelperEnabled: { type: Boolean, default: true },
  // Metric collection. Off by default: sampling every server every few seconds
  // is real storage, so the operator opts in and picks what is worth keeping.
  stats: {
    enabled: { type: Boolean, default: false },
    intervalSec: { type: Number, default: 10 },
    retentionDays: { type: Number, default: 3 },
    groups: {
      streams: { type: Boolean, default: true },     // live streams bandwidth (RTMP/SRT/HLS publishers)
      republish: { type: Boolean, default: true },   // RTMP Push rules
      srt: { type: Boolean, default: true },         // SRT sender/receiver socket stats
      server: { type: Boolean, default: true },      // server-level counters
    },
  },
  // iter10 m1 — Nimble log ingestion. Off by default: it needs the agent
  // installed, and on a fleet at debug level it moves ~14 GB/day, which is
  // not something to switch itself on after an upgrade.
  logs: {
    enabled: { type: Boolean, default: false },
    // Which files in the agent's log directory to follow. Rotated copies
    // (nimble.log.1 ...) are deliberately absent — the agent only serves
    // .log/.txt, so the panel follows the live file and reports any gap.
    files: { type: [String], default: ['nimble.log'] },
  },
}, { timestamps: true });

settingsSchema.statics.load = async function () {
  let doc = await this.findOne({ singleton: 'main' });
  if (!doc) doc = await this.create({ singleton: 'main' });
  return doc;
};

export const Settings = mongoose.model('Settings', settingsSchema);
