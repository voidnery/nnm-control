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

// One skeleton of steps, several sets of values.
//
// The case this exists for: the same streams, switched to different inputs.
// Without it each input needs its own copy of the whole function, and the
// copies drift — add a stream and you have to remember to add it everywhere.
//
// So the steps say WHAT is changed (which server, which object, which field)
// and a variant says TO WHAT. `overrides` is keyed by step index, and each
// value is merged over that step's own patch, so a variant only has to name
// the fields it differs in.
//
// A function with no variants runs exactly as before — the empty list is the
// implicit single variant. No migration, and nothing existing changes shape.
const variantSchema = new mongoose.Schema({
  id: { type: String, required: true },
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  // { "0": { src_strm: 'cam_a' }, "2": { video_source: { id: '…' } } }
  overrides: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { _id: false });

const functionSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  steps: { type: [stepSchema], default: [] },
  variants: { type: [variantSchema], default: [] },
  createdBy: { type: String, default: '' },
}, { timestamps: true });

export const FunctionDef = mongoose.model('FunctionDef', functionSchema);
