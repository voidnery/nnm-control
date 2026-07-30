// iter12 m3 — media by collection instead of by push.
//
// Two properties carry this milestone, and both are about not losing the
// operator's file:
//
//   * a transfer that arrives corrupt must be REFUSED, not renamed into place.
//     A media file Nimble will happily play half of is worse than one that
//     never arrived.
//   * the panel's copy is dropped only once the agent says the file is on disk
//     under its final name — not when the download finished.
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import os from 'node:os';

let pass = 0, fail = 0;
const acheck = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
};

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'nnm-spool-'));

console.log('SPOOLING (streamed, never buffered):');

// The spool's write path, isolated from mongoose: stream in, hash as it goes,
// cap the size. This is the code shape spoolUpload uses.
async function spoolTo(dest, stream, maxBytes = 1024 * 1024) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, _e, cb) {
      size += chunk.length;
      if (size > maxBytes) return cb(Object.assign(new Error('payload too large'), { status: 413 }));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(stream, meter, createWriteStream(dest));
  } catch (e) {
    await fs.rm(dest, { force: true });
    throw e;
  }
  return { size, sha256: hash.digest('hex') };
}

const PAYLOAD = crypto.randomBytes(300_000);

await acheck('an upload is hashed on the way to disk, not read twice', async () => {
  const dest = path.join(tmpdir, 'a.bin');
  const { Readable } = await import('node:stream');
  const r = await spoolTo(dest, Readable.from([PAYLOAD.subarray(0, 100_000), PAYLOAD.subarray(100_000)]));
  assert.equal(r.size, PAYLOAD.length);
  assert.equal(r.sha256, sha(PAYLOAD));
  assert.equal((await fs.stat(dest)).size, PAYLOAD.length);
});

await acheck('an oversized upload leaves no partial file behind', async () => {
  const dest = path.join(tmpdir, 'big.bin');
  const { Readable } = await import('node:stream');
  await assert.rejects(
    () => spoolTo(dest, Readable.from([crypto.randomBytes(200_000), crypto.randomBytes(200_000)]), 250_000),
    /too large/,
  );
  await assert.rejects(() => fs.stat(dest), /ENOENT/, 'a refused upload must not leave bytes on the volume');
});

console.log('\nCOLLECTION (agent pulls, verifies, then commits):');

// The panel side: holds the file, hands it over, and is told the outcome.
function panel(spoolPath, meta) {
  const app = express();
  app.use(express.json());
  const state = { handedOver: 0, status: 'queued', deleted: false, error: '' };
  app.get('/api/agent-gw/media/:id/content', (req, res) => {
    if (req.headers.authorization !== 'Bearer good') return res.status(401).end();
    state.handedOver++;
    state.status = 'fetching';
    res.setHeader('content-length', String(meta.size));
    createReadStream(spoolPath).pipe(res);
  });
  app.post('/api/agent-gw/task/:id/result', async (req, res) => {
    const { ok, error } = req.body || {};
    if (ok) {
      state.status = 'done';
      await fs.rm(spoolPath, { force: true });   // only now
      state.deleted = true;
    } else {
      state.status = 'failed';
      state.error = String(error || '');         // file deliberately kept
    }
    res.json({ ok: true });
  });
  return { app, state };
}

// The agent side: download to .part, verify, rename. Mirrors the real handler.
async function collect(base, token, transferId, dest, expect) {
  const res = await fetch(`${base}/api/agent-gw/media/${transferId}/content`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`panel returned ${res.status}`);
  const tmp = `${dest}.part`;
  const hash = crypto.createHash('sha256');
  let got = 0;
  try {
    const meter = new Transform({
      transform(c, _e, cb) { got += c.length; hash.update(c); cb(null, c); },
    });
    await pipeline(res.body, meter, createWriteStream(tmp));
    const digest = hash.digest('hex');
    if (expect.sha256 && digest !== expect.sha256) throw new Error('checksum mismatch');
    if (expect.size && got !== expect.size) throw new Error('size mismatch');
    await fs.rename(tmp, dest);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
  return { size: got };
}

await acheck('a file is collected, verified and committed under its final name', async () => {
  const spool = path.join(tmpdir, 't1.bin');
  await fs.writeFile(spool, PAYLOAD);
  const p = panel(spool, { size: PAYLOAD.length });
  const srv = p.app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const dest = path.join(tmpdir, 'clip.mp4');
  try {
    await collect(base, 'good', 'T1', dest, { sha256: sha(PAYLOAD), size: PAYLOAD.length });
    await fetch(`${base}/api/agent-gw/task/X/result`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }),
    });
    assert.deepEqual(await fs.readFile(dest), PAYLOAD, 'the file must arrive byte-identical');
    assert.equal(p.state.status, 'done');
    assert.equal(p.state.deleted, true, 'the panel copy is dropped once the agent confirms');
  } finally { srv.close(); }
});

await acheck('a corrupted transfer is refused and never reaches its final name', async () => {
  const spool = path.join(tmpdir, 't2.bin');
  await fs.writeFile(spool, PAYLOAD);
  const p = panel(spool, { size: PAYLOAD.length });
  const srv = p.app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const dest = path.join(tmpdir, 'bad.mp4');
  try {
    // The panel says the digest is something else — the same shape as a
    // transfer damaged in flight.
    await assert.rejects(
      () => collect(base, 'good', 'T2', dest, { sha256: sha(Buffer.from('different')), size: PAYLOAD.length }),
      /checksum mismatch/,
    );
    await assert.rejects(() => fs.stat(dest), /ENOENT/, 'nothing may be left under the final name');
    await assert.rejects(() => fs.stat(`${dest}.part`), /ENOENT/, 'nor under the temporary one');
  } finally { srv.close(); }
});

await acheck('a failed write keeps the panel copy so a retry costs nothing', async () => {
  const spool = path.join(tmpdir, 't3.bin');
  await fs.writeFile(spool, PAYLOAD);
  const p = panel(spool, { size: PAYLOAD.length });
  const srv = p.app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await fetch(`${base}/api/agent-gw/task/X/result`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'disk full' }),
    });
    assert.equal(p.state.status, 'failed');
    assert.ok((await fs.stat(spool)).size > 0, 'the file must survive a failed write, or the retry is another upload');
    assert.match(p.state.error, /disk full/);
  } finally { srv.close(); }
});

await acheck('an unauthenticated agent gets nothing', async () => {
  const spool = path.join(tmpdir, 't4.bin');
  await fs.writeFile(spool, PAYLOAD);
  const p = panel(spool, { size: PAYLOAD.length });
  const srv = p.app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await assert.rejects(
      () => collect(base, 'wrong', 'T4', path.join(tmpdir, 'no.mp4'), {}),
      /returned 401/,
    );
    assert.equal(p.state.handedOver, 0);
  } finally { srv.close(); }
});

console.log('\nRETENTION (3 days uncollected, immediate once confirmed):');

await acheck('the window is three days from upload', async () => {
  const { RETENTION_DAYS } = await import('../src/models/MediaTransfer.js');
  assert.equal(RETENTION_DAYS, 3);
  const at = new Date('2026-07-30T10:00:00Z');
  const expires = new Date(at.getTime() + RETENTION_DAYS * 86400_000);
  assert.equal(expires.toISOString(), '2026-08-02T10:00:00.000Z');
});

await acheck('a young orphan is left alone; an old one is reaped', async () => {
  // An upload still streaming has a file but no saved record yet. Reaping by
  // "no record" alone would delete it mid-flight.
  const young = path.join(tmpdir, 'young.bin');
  const old = path.join(tmpdir, 'old.bin');
  await fs.writeFile(young, 'x');
  await fs.writeFile(old, 'x');
  const hourAgo = new Date(Date.now() - 2 * 3600_000);
  await fs.utimes(old, hourAgo, hourAgo);
  const now = new Date();
  const keep = (p, st) => now - st.mtime < 3600_000;
  assert.equal(keep(young, await fs.stat(young)), true, 'an in-flight upload must not be reaped');
  assert.equal(keep(old, await fs.stat(old)), false, 'a stale orphan must be');
});

console.log('\nSHAPE:');

await acheck('the agent collects rather than being pushed to', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("'POST /media/fetch'"), 'the agent must have a collect route');
  assert.ok(src.includes('/api/agent-gw/media/'), 'it fetches from the panel');
  // Scoped to this handler's own body: `fs.rename(tmp, full)` appears in other
  // routes too, and comparing positions across the whole file would have been
  // measuring the wrong rename.
  const from = src.indexOf("'POST /media/fetch'");
  const handler = src.slice(from, src.indexOf("async 'PUT /media'", from));
  assert.ok(handler.includes('checksum mismatch'), 'it verifies before committing');
  assert.ok(handler.indexOf('fs.rename(tmp, full)') > handler.indexOf('checksum mismatch'),
    'the rename must come after the check, not before');
  assert.ok(handler.includes('fs.rm(tmp'), 'a refused transfer must clean up its temporary file');
});

await fs.rm(tmpdir, { recursive: true, force: true });
console.log(fail ? `\n${fail} failed, ${pass} passed` : '\nall media-transfer checks passed');
process.exit(fail ? 1 : 0);
