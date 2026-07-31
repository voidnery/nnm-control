import mongoose from 'mongoose';

// iter14 — what happened to an agent, kept so an operator can be told.
//
// Written by the watchdog on a TRANSITION, never on a reading. The distinction
// is the difference between a useful notification and a stream of noise: an
// agent that has been down for an hour should have produced one event, not
// three hundred and sixty.
const agentEventSchema = new mongoose.Schema({
  serverId: { type: mongoose.Schema.Types.ObjectId, ref: 'NimbleServer', required: true, index: true },
  serverName: { type: String, default: '' },
  // The diagnosis code that was entered or left.
  code: { type: String, required: true },
  kind: { type: String, enum: ['fault', 'recovered', 'action'], default: 'fault' },
  severity: { type: String, enum: ['info', 'warn', 'error'], default: 'error' },
  message: { type: String, default: '' },
  evidence: { type: String, default: '' },
  detail: { type: mongoose.Schema.Types.Mixed, default: null },
  acknowledgedAt: { type: Date, default: null },
  acknowledgedBy: { type: String, default: '' },
}, { timestamps: true });

agentEventSchema.index({ createdAt: -1 });
// A month is long enough to look back at a bad week and short enough that the
// collection never becomes a problem of its own.
agentEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400 });

export const AgentEvent = mongoose.model('AgentEvent', agentEventSchema);
