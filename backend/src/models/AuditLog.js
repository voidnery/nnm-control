import mongoose from 'mongoose';

const auditSchema = new mongoose.Schema({
  ts: { type: Date, default: Date.now },
  username: { type: String, default: '' },
  roleType: { type: String, default: '' },
  ip: { type: String, default: '' },
  // machine-readable action, e.g. "servers:POST /:id/test", "auth:login",
  // "functions:run_finished"
  action: { type: String, required: true },
  target: { type: String, default: '' },
  // sanitized request body / event payload (never contains secrets)
  detail: { type: mongoose.Schema.Types.Mixed, default: null },
  outcome: { type: String, enum: ['ok', 'error'], default: 'ok' },
  status: { type: Number, default: 0 },
});
// Retention: 90 days.
// Thirty days, not ninety.
//
// Ninety was chosen when this held operator actions only — a few hundred a
// month, and keeping a quarter of them cost nothing. It then held every agent
// poll as well and reached 50 GB. The machine traffic is gone now, so the size
// is back to what it was meant to be; the shorter window is the second line,
// because a retention that only works while nothing unexpected writes to the
// collection is not a retention.
auditSchema.index({ ts: 1 }, { expireAfterSeconds: 30 * 24 * 3600, name: 'ts_ttl' });
auditSchema.index({ username: 1, ts: -1 });

export const AuditLog = mongoose.model('AuditLog', auditSchema);
