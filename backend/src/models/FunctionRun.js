import mongoose from 'mongoose';

const runStepSchema = new mongoose.Schema({
  index: Number,
  label: String,
  // pending -> applying -> verifying -> done | error; on failure earlier steps
  // go rolling_back -> rolled_back | rollback_failed
  status: { type: String, default: 'pending' },
  detail: { type: String, default: '' },
  snapshot: { type: mongoose.Schema.Types.Mixed, default: null },
}, { _id: false });

const runSchema = new mongoose.Schema({
  functionId: { type: mongoose.Schema.Types.ObjectId, ref: 'FunctionDef' },
  functionName: String,
  startedBy: String,
  // running -> success | rolled_back | rollback_failed
  status: { type: String, default: 'running' },
  cancelReason: { type: String, default: '' },
  steps: { type: [runStepSchema], default: [] },
  startedAt: { type: Date, default: Date.now },
  finishedAt: { type: Date, default: null },
}, { timestamps: true });

export const FunctionRun = mongoose.model('FunctionRun', runSchema);
