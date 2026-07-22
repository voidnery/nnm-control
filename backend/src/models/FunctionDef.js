import mongoose from 'mongoose';

// An engineering function: an ordered list of transactional steps.
const stepSchema = new mongoose.Schema({
  label: { type: String, default: '' },
  // Step types:
  //  'patch'  — GET object, snapshot patched keys, PUT patch, verify by polling
  //             (objectKind: republish | udp | outgoing | hotswap)
  //  'action' — outgoing stream action: pause | resume | restart
  //             (rollback: pause<->resume inverse; restart has no rollback)
  //  'delay'  — wait N seconds (no rollback)
  type: { type: String, enum: ['patch', 'action', 'delay'], required: true },
  serverId: { type: mongoose.Schema.Types.ObjectId, ref: 'NimbleServer' },
  objectKind: { type: String, enum: ['republish', 'udp', 'outgoing', 'hotswap', 'live_pull', 'transcoder', 'abr', 'alias', ''], default: '' },
  targetId: { type: String, default: '' },      // WMSPanel object id
  targetLabel: { type: String, default: '' },   // human-readable app/stream of the picked object (UI aid)
  patch: { type: mongoose.Schema.Types.Mixed, default: {} },
  action: { type: String, enum: ['pause', 'resume', 'restart', ''], default: '' },
  waitSec: { type: Number, default: 0 },
}, { _id: false });

const functionSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  steps: { type: [stepSchema], default: [] },
  createdBy: { type: String, default: '' },
}, { timestamps: true });

export const FunctionDef = mongoose.model('FunctionDef', functionSchema);
