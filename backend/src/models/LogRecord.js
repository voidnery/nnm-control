import mongoose from 'mongoose';

// iter10 m1 — ingested Nimble log records.
//
// SIZING, measured rather than assumed. The sample from srv-mediaserver2 ran
// at 12.8 KB/s (98 lines/s) with `logging` effectively at debug. That is
// 1.1 GB/day for one server and ~14.3 GB/day across the 13-server fleet. A
// collection with no ceiling would fill the panel's disk in well under a
// week, so m1 stores into a CAPPED collection: Mongo evicts the oldest
// records itself, the size is a hard bound, and there is no cleanup job to
// fall behind. Proper tiering (keep everything for hours, errors for weeks)
// is m2's job — this exists so the pipe can be proven without risking the
// host it runs on.
//
// The cap is read once at model creation. Changing it requires dropping the
// collection, which is stated in the docs rather than hidden.
const CAP_MB = Number(process.env.NNM_LOG_CAP_MB || 512);

const logRecordSchema = new mongoose.Schema({
  serverId: { type: mongoose.Schema.Types.ObjectId, ref: 'NimbleServer', required: true },
  file: { type: String, required: true },       // 'nimble.log'
  // Byte offset within the file. Nimble's timestamps have one-second
  // resolution while it emits ~98 lines/s, so ts alone cannot order records;
  // the offset is unique and monotonic within a file generation.
  offset: { type: Number, required: true },
  bytes: { type: Number, default: 0 },
  gen: { type: Number, default: 0 },            // rotation generation, see LogCursor
  ts: { type: Date, default: null },            // parsed timestamp, server-local
  raw: { type: String, default: '' },           // original 'YYYY-MM-DDTHH:MM:SS'
  pid: { type: Number, default: 0 },
  tid: { type: Number, default: 0 },
  tag: { type: String, default: '' },           // raw tag, e.g. 'srtpull0'
  sub: { type: String, default: '' },           // normalised, e.g. 'srtpull'
  level: { type: String, default: 'D' },        // E | W | I | V | D
  msg: { type: String, default: '' },
  cont: { type: String, default: '' },          // attached HTTP dump, if any
  contLines: { type: Number, default: 0 },
  orphan: { type: Boolean, default: false },
}, {
  timestamps: false,
  capped: { size: CAP_MB * 1024 * 1024 },
});

// Capped collections keep natural (insertion) order, which is already the
// order we want. These indexes serve the filtered views m3/m4 will build.
logRecordSchema.index({ serverId: 1, offset: -1 });
logRecordSchema.index({ ts: -1 });
logRecordSchema.index({ sub: 1, level: 1, ts: -1 });

export const LogRecord = mongoose.model('LogRecord', logRecordSchema);
export const LOG_CAP_MB = CAP_MB;

// Where the collector left off, per server and file.
const logCursorSchema = new mongoose.Schema({
  serverId: { type: mongoose.Schema.Types.ObjectId, ref: 'NimbleServer', required: true },
  file: { type: String, required: true },
  offset: { type: Number, default: 0 },
  // Inode identifies a file generation. Nimble rotates by size
  // (max_log_file_size, 128 MB by default), and after rotation the same name
  // is a different inode — that is how rotation is detected without guessing
  // from sizes.
  ino: { type: String, default: '' },
  gen: { type: Number, default: 0 },
  // A record whose continuation lines had not finished arriving when the
  // chunk ended. Carried across polls so an HTTP dump split by a poll
  // boundary is still stored as one record.
  pending: { type: mongoose.Schema.Types.Mixed, default: null },
  lastAt: { type: Date, default: null },
  lastError: { type: String, default: '' },
  // Diagnostics the operator actually needs when a tail looks wrong.
  bytesRead: { type: Number, default: 0 },
  recordsStored: { type: Number, default: 0 },
  rotations: { type: Number, default: 0 },
  bytesMissed: { type: Number, default: 0 },
}, { timestamps: true });

logCursorSchema.index({ serverId: 1, file: 1 }, { unique: true });

export const LogCursor = mongoose.model('LogCursor', logCursorSchema);
