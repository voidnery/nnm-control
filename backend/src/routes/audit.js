import { Router } from 'express';
import { machineTrafficFilter, logEvent } from '../services/audit.js';
import { createJob, appendJob, finishJob, getJob } from '../services/sshInstaller.js';
import { AuditLog } from '../models/AuditLog.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';

export const auditRouter = Router();
auditRouter.use(requireAuth, requirePerm('audit.view'));

// Filters: username, action substring, outcome, before (ts cursor). Max 200.
auditRouter.get('/', async (req, res) => {
  const { username, action, outcome, before } = req.query;
  const q = {};
  if (username) q.username = username;
  if (action) q.action = { $regex: String(action).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  if (outcome === 'ok' || outcome === 'error') q.outcome = outcome;
  if (before) q.ts = { $lt: new Date(String(before)) };
  const items = await AuditLog.find(q).sort({ ts: -1 }).limit(200).lean();
  res.json({ items });
});


// What a sweep would remove, before removing it.
//
// Counted rather than estimated, and shown before the button does anything:
// deleting millions of rows from a log people rely on is not something to
// discover the size of afterwards.
// How much disk the collection occupies.
//
// `collection.stats()` was removed from the driver that Mongoose 8 carries, so
// the call threw — and the panel's `catch` swallowed it, leaving the button
// absent with nothing said. A number that cannot be read is worth a null and a
// working page; an exception is worth neither.
// The database handle a command can actually be sent to.
//
// `Model.db` is a Mongoose Connection, and it has no `.command()` — the calls
// went straight to a TypeError, which two `catch` blocks swallowed. The size
// came back as "? MB" and the compaction reported failure, both for the same
// reason and neither saying it.
function nativeDb() {
  return AuditLog.db.getClient().db(AuditLog.db.name);
}

async function collectionSize() {
  try {
    // Through the aggregation stage rather than the collStats command: it is
    // the supported way in MongoDB 7 and needs no admin rights.
    const [row] = await AuditLog.collection
      .aggregate([{ $collStats: { storageStats: {} } }]).toArray();
    const bytes = row?.storageStats?.storageSize;
    return Number.isFinite(bytes) ? Math.round(bytes / 1048576) : null;
  } catch {
    return null;
  }
}

auditRouter.get('/sweepable', requireAuth, requirePerm('audit.view'), async (req, res) => {
  const filter = machineTrafficFilter();

  // Estimated, not counted.
  //
  // `countDocuments` with a regular expression walks every document — 8.6
  // million of them, minutes of work, and whatever proxies the panel gives up
  // long before that. The page then showed HTTP 504 where a number belonged.
  //
  // The total is metadata and free. The machine share is sampled: a few
  // thousand of the newest rows, scaled. That is exact enough for the only
  // question being asked — is there a great deal of machine traffic in here,
  // and roughly how much — and a sweep does not need a number to be right, it
  // needs to delete what matches.
  const total = await AuditLog.estimatedDocumentCount();
  const SAMPLE = 5000;
  const sample = await AuditLog.find({}, { action: 1 })
    .sort({ ts: -1 }).limit(SAMPLE).lean();
  const re = new RegExp(filter.action.$regex);
  const inSample = sample.filter(d => re.test(d.action || '')).length;
  const machine = sample.length
    ? Math.round((inSample / sample.length) * total)
    : 0;
  const stats = await collectionSize();
  res.json({
    machine,
    total,
    // Said plainly, because a number shown to somebody about to delete
    // millions of rows should not pretend to a precision it does not have.
    estimated: true,
    // What people did, which is what an audit log is for and what stays.
    keeping: Math.max(0, total - machine),
    // Bytes are what the operator is actually short of. Storage size rather
    // than data size, since that is the file on the disk.
    storageMb: stats,
    // Removing rows does not shrink a WiredTiger file. Said here rather than
    // discovered after a sweep that appears to free nothing.
    needsCompact: true,
  });
});

// Remove them.
//
// Confirmed by naming the count the operator was shown: a sweep is
// irreversible, and agreeing to "delete 8,598,036 rows" is a different act
// from clicking a button whose label happened to be under the cursor.
auditRouter.post('/sweep', requireAuth, requirePerm('audit.manage'), async (req, res) => {
  const filter = machineTrafficFilter();
  const expected = Number(req.body?.expect);

  if (!Number.isFinite(expected)) {
    return res.status(400).json({ error: 'confirm-count-required', code: 'confirm-count-required' });
  }
  // Compared against the estimate, not a fresh exact count — counting is what
  // made this time out in the first place. The confirmation exists so that the
  // operator agrees to a number of the right magnitude, and an estimate serves
  // that: what it must not do is silently sweep when the figure has moved by
  // an order of magnitude.
  const actual = await AuditLog.estimatedDocumentCount();
  if (expected > actual * 1.5 + 1000) {
    return res.status(409).json({ error: 'count-changed', code: 'count-changed', expected, actual });
  }

  // Answered at once, then polled — the same shape as the gateway apply.
  //
  // Deleting 8.6 million rows and compacting the file takes minutes, and an
  // HTTP request held open that long is at the mercy of whatever proxies the
  // panel. Counting them already timed out once; doing the work in a request
  // would time out again, with the difference that the work would carry on
  // underneath and the operator would not know it had.
  const jobId = createJob({ what: 'audit-sweep', expected });
  appendJob(jobId, `removing machine traffic from the audit log (about ${expected} rows)\n`);
  (async () => {
    try {
      const r = await AuditLog.deleteMany(filter);
      appendJob(jobId, `removed ${r.deletedCount} rows\n`);

      // Compaction, because deleting rows returns no disk. Attempted and
      // reported: it takes a lock, and a panel that silently stalls is worse
      // than one that says it is compacting.
      let compacted = null;
      try {
        appendJob(jobId, 'compacting the collection — this holds a lock and takes a few minutes\n');
        const out = await nativeDb().command({ compact: AuditLog.collection.collectionName });
        compacted = Boolean(out?.ok);
      } catch (e) {
        compacted = false;
        appendJob(jobId, `the file could not be compacted: ${String(e?.message || e).slice(0, 160)}\n`);
        appendJob(jobId, 'the rows are gone regardless; the space returns on the next compaction or restart\n');
      }

      const mb = await collectionSize();
      appendJob(jobId, `the collection is now ${mb ?? '?'} MB\n`);
      logEvent({ req, action: 'audit:sweep', outcome: 'ok', status: 200,
                 detail: { removed: r.deletedCount, compacted } });
      finishJob(jobId, { status: 'done', result: { removed: r.deletedCount, compacted, storageMb: mb } });
    } catch (e) {
      appendJob(jobId, `${String(e?.message || e)}\n`);
      finishJob(jobId, { status: 'failed', error: String(e?.message || e).slice(0, 200) });
    }
  })();

  res.status(202).json({ jobId, expected });
});


// How a sweep is going.
auditRouter.get('/sweep/jobs/:jobId', requireAuth, requirePerm('audit.manage'), (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job-not-found', code: 'job-not-found' });
  res.json(job);
});
