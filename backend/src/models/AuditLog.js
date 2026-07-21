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
auditSchema.index({ ts: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });
auditSchema.index({ username: 1, ts: -1 });

export const AuditLog = mongoose.model('AuditLog', auditSchema);
