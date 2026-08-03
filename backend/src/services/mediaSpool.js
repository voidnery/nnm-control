// iter12 m3 — the panel's media spool.
//
// Location: a directory of its own, `/var/lib/nnm-control/media-spool` by
// default, backed by a named volume in docker-compose. Deliberately NOT inside
// the image and not next to anything else: a 2 GB upload landing on the same
// filesystem as the database is how a panel takes its own Mongo down, and a
// separate volume is the one place an operator can look, measure and cap.
//
// Nothing here is served to a browser and nothing is executed. Files are
// written under a generated id, never under the operator's filename, so a
// name like `../../nimble.conf` is a string in the database and not a path.
import fs from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import crypto from 'node:crypto';
import path from 'node:path';
import { MediaTransfer, RETENTION_DAYS } from '../models/MediaTransfer.js';

export const SPOOL_DIR = path.resolve(process.env.MEDIA_SPOOL_DIR || '/var/lib/nnm-control/media-spool');
// 100 GB. Large enough for the material this handles, and bounded on purpose:
// an unlimited upload is one that fills a disk, and a panel with no disk left
// stops answering for every server rather than failing one transfer.
const MAX_BYTES = Number(process.env.MEDIA_MAX_MB || 102_400) * 1024 * 1024;

// Refuse before starting rather than fail part-way.
//
// At this size the limit that bites is not the configured maximum but the
// spool's own free space. Discovering that at 90 GB means 90 GB of someone's
// time and bandwidth already spent, a half-written file to clean up, and — if
// the disk is shared with the database, which it is by default — a panel that
// has stopped working for reasons nobody will connect to an upload.
//
// The margin exists because a disk filled exactly to zero is a disk that
// cannot be recovered from without shell access.
const FREE_MARGIN_BYTES = 2 * 1024 * 1024 * 1024;

export async function spoolFreeBytes() {
  const st = await fs.statfs(SPOOL_DIR);
  return st.bavail * st.bsize;
}

/**
 * Whether a file of this size can be taken, and why not if it cannot.
 *
 * `declared` is what the browser said. It is not trusted for the write — the
 * meter still counts — but it is exactly what is needed to say no early.
 */
export async function canAccept(declared) {
  const bytes = Number(declared) || 0;
  if (bytes > MAX_BYTES) {
    return { ok: false, status: 413,
      reason: `the file is ${(bytes / 1e9).toFixed(1)} GB and the limit is ${(MAX_BYTES / 1e9).toFixed(0)} GB` };
  }
  try {
    await fs.mkdir(SPOOL_DIR, { recursive: true });
    const free = await spoolFreeBytes();
    if (bytes && bytes + FREE_MARGIN_BYTES > free) {
      return { ok: false, status: 507,
        reason: `the panel has ${(free / 1e9).toFixed(1)} GB free and this needs `
          + `${(bytes / 1e9).toFixed(1)} GB plus a ${(FREE_MARGIN_BYTES / 1e9).toFixed(0)} GB margin` };
    }
  } catch {
    // Unable to measure is not a reason to refuse: the meter still stops an
    // overlong write, and a filesystem that will not answer statfs is not
    // necessarily full.
    return { ok: true, unmeasured: true };
  }
  return { ok: true };
}

const spoolFile = (id) => path.join(SPOOL_DIR, `${id}.bin`);

/**
 * Stream an upload to disk, hashing as it goes.
 *
 * The request is piped, never buffered: a 2 GB file must not become 2 GB of
 * heap on the way past. The hash is computed here rather than afterwards so
 * the file is read once, not twice.
 */
export async function spoolUpload(server, name, stream, { createdBy = '' } = {}) {
  await fs.mkdir(SPOOL_DIR, { recursive: true });

  const doc = await MediaTransfer.create({
    serverId: server._id,
    name,
    createdBy,
    expiresAt: new Date(Date.now() + RETENTION_DAYS * 86400_000),
  });
  const dest = spoolFile(doc._id);

  const hash = crypto.createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_BYTES) return cb(Object.assign(new Error('payload too large'), { status: 413 }));
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  try {
    await pipeline(stream, meter, createWriteStream(dest));
  } catch (e) {
    await fs.rm(dest, { force: true });
    await MediaTransfer.deleteOne({ _id: doc._id });
    throw e;
  }

  doc.size = size;
  doc.sha256 = hash.digest('hex');
  doc.spoolPath = dest;
  await doc.save();
  return doc;
}

export function readSpooled(doc) {
  return createReadStream(doc.spoolPath || spoolFile(doc._id));
}

/** Called once the agent confirms the file is on the server's disk. */
export async function discardSpooled(doc) {
  await fs.rm(doc.spoolPath || spoolFile(doc._id), { force: true });
  doc.spoolPath = '';
  await doc.save();
}

/**
 * Delete what nobody came for, and reap orphans.
 *
 * Two directions on purpose: records whose window has passed lose their file,
 * and files with no record lose themselves. A spool that only ever cleans one
 * of the two grows quietly until the volume is full.
 */
export async function sweepSpool({ now = new Date() } = {}) {
  const out = { expired: 0, orphans: 0, bytes: 0 };

  const stale = await MediaTransfer.find({
    status: { $in: ['queued', 'fetching', 'failed'] },
    expiresAt: { $lt: now },
  });
  for (const doc of stale) {
    try { await fs.rm(doc.spoolPath || spoolFile(doc._id), { force: true }); } catch { /* already gone */ }
    doc.status = 'expired';
    doc.spoolPath = '';
    await doc.save();
    out.expired++;
  }

  let names = [];
  try { names = await fs.readdir(SPOOL_DIR); } catch { return out; }
  const live = new Set(
    (await MediaTransfer.find({ spoolPath: { $ne: '' } }, { _id: 1 }).lean())
      .map(d => `${d._id}.bin`),
  );
  for (const n of names) {
    if (live.has(n)) continue;
    const p = path.join(SPOOL_DIR, n);
    try {
      const st = await fs.stat(p);
      // A file younger than an hour may belong to an upload still in flight,
      // whose record is not saved until the stream finishes.
      if (now - st.mtime < 3600_000) continue;
      out.bytes += st.size;
      await fs.rm(p, { force: true });
      out.orphans++;
    } catch { /* vanished under us */ }
  }
  return out;
}

export async function spoolUsage() {
  let names = [];
  try { names = await fs.readdir(SPOOL_DIR); } catch { return { files: 0, bytes: 0, dir: SPOOL_DIR }; }
  let bytes = 0;
  for (const n of names) {
    try { bytes += (await fs.stat(path.join(SPOOL_DIR, n))).size; } catch { /* ignore */ }
  }
  return { files: names.length, bytes, dir: SPOOL_DIR };
}

let timer = null;
export function startSpoolSweeper(everyMs = 3600_000) {
  stopSpoolSweeper();
  const tick = () => sweepSpool().catch(e => console.error('[spool] sweep failed:', e.message));
  timer = setInterval(tick, everyMs);
  if (timer.unref) timer.unref();
  tick();
}
export function stopSpoolSweeper() { if (timer) { clearInterval(timer); timer = null; } }
