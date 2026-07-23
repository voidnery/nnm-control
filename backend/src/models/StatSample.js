import mongoose from 'mongoose';

// One sample per (server, subject) per tick. Metrics are stored as a free-form
// map because Nimble's SRT counters differ between versions and builds — the
// collector harvests whatever numeric fields the server reports instead of
// hardcoding a field list that would silently go stale.
const statSampleSchema = new mongoose.Schema({
  serverId: { type: String, required: true },
  subject: { type: String, required: true },   // e.g. "stream:live/cam1", "republish:<id>", "srt-receiver:<id>"
  group: { type: String, required: true },     // streams | republish | srt | server
  ts: { type: Date, required: true },
  metrics: { type: Map, of: Number, default: {} },
  label: { type: String, default: '' },        // human-readable subject name at sample time
}, { versionKey: false });

statSampleSchema.index({ serverId: 1, subject: 1, ts: -1 });
// Retention is enforced by Mongo itself; expireAfterSeconds is reconciled with
// the configured retention at startup (see statsCollector).
statSampleSchema.index({ ts: 1 }, { expireAfterSeconds: 3 * 24 * 3600, name: 'ts_ttl' });

export const StatSample = mongoose.model('StatSample', statSampleSchema);
