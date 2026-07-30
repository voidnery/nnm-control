import mongoose from 'mongoose';

// iter12 m3 — a file the operator has handed to the panel for a server that
// the panel cannot reach.
//
// Media was the last operation still running panel → agent: the browser's
// bytes were streamed straight through to the server, which meant the server
// had to be reachable and nothing was ever stored here. Inverting it costs
// exactly one thing — the panel now has to hold the file until the agent comes
// for it — and that is what this record tracks.
//
// Retention, decided with the operator:
//   * collected and confirmed written  -> deleted immediately
//   * never collected                  -> deleted after 3 days
//
// The confirmation matters. Deleting on "the agent downloaded it" would throw
// the only copy away while the write on the far side could still fail; the
// panel keeps it until the agent says the file is on disk under its final
// name.
const mediaTransferSchema = new mongoose.Schema({
  serverId: { type: mongoose.Schema.Types.ObjectId, ref: 'NimbleServer', required: true, index: true },
  name: { type: String, required: true },          // final filename on the server
  size: { type: Number, default: 0 },
  // Computed while the browser's upload is written to the spool, and verified
  // by the agent after it downloads. A truncated 2 GB transfer must never
  // become a media file Nimble will happily play half of.
  sha256: { type: String, default: '' },
  spoolPath: { type: String, default: '' },

  // queued     -> on the panel's disk, waiting for an agent to ask
  // fetching   -> an agent has been handed the task
  // done       -> the agent confirmed the file is written; spool file removed
  // failed     -> the agent reported a problem; the file is kept for a retry
  // expired    -> nobody collected it within the retention window
  status: { type: String, enum: ['queued', 'fetching', 'done', 'failed', 'expired'], default: 'queued', index: true },
  error: { type: String, default: '' },
  attempts: { type: Number, default: 0 },

  createdBy: { type: String, default: '' },
  fetchedAt: { type: Date, default: null },
  confirmedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

mediaTransferSchema.index({ serverId: 1, status: 1, createdAt: 1 });

export const MediaTransfer = mongoose.model('MediaTransfer', mediaTransferSchema);
export const RETENTION_DAYS = 3;
