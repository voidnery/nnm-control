#!/usr/bin/env node
// NNM Control agent — the only component that touches a Nimble box's filesystem.
//
// Deliberately dependency-free (node:http + node:fs) so the whole trust surface
// fits on a screen and can be audited by the operator who installs it.
//
// It can do exactly three things, inside two fixed directories:
//   * read/write playlist & config files under CONF_DIR
//   * list/upload/delete media under MEDIA_DIR
//   * read (never write) log files under LOG_DIR          [iter10 m1]
//   * report its own health
// There is no shell, no arbitrary path, no directory listing outside those.
import http from 'node:http';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const PORT = Number(process.env.NNM_AGENT_PORT || 8090);
// iter12 m5 — loopback by default. Nothing connects to the agent any more;
// this socket exists so an operator with a shell can ask it how it is.
const BIND = process.env.NNM_AGENT_BIND || '127.0.0.1';
const TOKEN = process.env.NNM_AGENT_TOKEN || '';
const CONF_DIR = path.resolve(process.env.NNM_AGENT_CONF_DIR || '/srv/nimble/conf');
const MEDIA_DIR = path.resolve(process.env.NNM_AGENT_MEDIA_DIR || '/srv/nimble/media/gallery');
// iter10 m1 — logs are read-only and live in their own root. Nimble's default
// on Linux is /var/log/nimble. This directory is never written to, and it is
// mounted read-only in the systemd unit, so a bug here cannot damage a log.
const LOG_DIR = path.resolve(process.env.NNM_AGENT_LOG_DIR || '/var/log/nimble');
const LOG_ENABLED = String(process.env.NNM_AGENT_LOGS || '1') !== '0';
// A single read is capped so one poll can never pull a whole rotated file into
// memory. At the measured ~13 KB/s per server a 1 MB window covers ~80s of
// output, so a 5s poll has ~16x headroom for bursts.
const MAX_LOG_CHUNK = Number(process.env.NNM_AGENT_LOG_CHUNK_KB || 1024) * 1024;
const LOG_EXT = (process.env.NNM_AGENT_LOG_EXT || 'log,txt').split(',').map(s => s.trim().toLowerCase());
const MAX_UPLOAD = Number(process.env.NNM_AGENT_MAX_UPLOAD_MB || 2048) * 1024 * 1024;

// iter12 m1 — the agent connects to the panel; the panel never connects here.
// That is what lets it run on a machine behind NAT with no port forwarding,
// no public address and no firewall hole. When these are set the agent parks
// on a long-poll and executes whatever the panel has queued for it.
const PANEL_URL = String(process.env.NNM_AGENT_PANEL_URL || '').replace(/\/+$/, '');
const SERVER_ID = String(process.env.NNM_AGENT_SERVER_ID || '');
const PANEL_ENABLED = Boolean(PANEL_URL && SERVER_ID);
// Survives for the life of the process. A new value tells the panel the agent
// restarted, which distinguishes "crash-looping" from "quietly wedged" —
// exactly the pair that was indistinguishable in NET-Control until the agent
// started reporting it.
const INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const AGENT_VERSION = 6;

// iter12 m2 — log shipping.
//
// The panel used to pull byte ranges out of this agent, which meant it held
// the cursor, guessed at rotation from whatever it could see between two
// polls, and had to walk all 13 servers on a timer. Now the tail lives here:
// the agent follows the file, keeps its own cursor, and pushes.
//
// The cursor survives a restart in this file. If the directory is not
// writable the agent still works — it just resumes at the end of the file
// after a restart rather than where it left off, and says so once.
const STATE_DIR = String(process.env.STATE_DIRECTORY || process.env.NNM_AGENT_STATE_DIR || '/var/lib/nnm-agent');
const LOG_BATCH_BYTES = Number(process.env.NNM_AGENT_LOG_BATCH_KB || 256) * 1024;
const LOG_BATCH_MS = Number(process.env.NNM_AGENT_LOG_BATCH_MS || 2000);
const MAX_CONFIG = 8 * 1024 * 1024;
const ALLOWED_MEDIA = (process.env.NNM_AGENT_MEDIA_EXT ||
  'mp4,mov,mkv,ts,mpg,mpeg,m4v,mp3,aac,wav,jpg,jpeg,png').split(',').map(s => s.trim().toLowerCase());

if (!TOKEN || TOKEN.length < 24) {
  console.error('NNM_AGENT_TOKEN must be set and at least 24 characters. Refusing to start.');
  process.exit(1);
}

// Constant-time compare: a fast string !== would leak the token byte by byte.
function tokenOk(header) {
  const given = String(header || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// A name is a single file inside the given root — never a path, never a parent.
function safeJoin(root, name) {
  const clean = String(name || '');
  if (!clean || clean.includes('\0')) throw new Error('invalid name');
  if (clean !== path.basename(clean)) throw new Error('name must not contain a path');
  const full = path.resolve(root, clean);
  // resolve() alone is not enough: a symlinked root could still escape, so the
  // prefix is re-checked after resolution.
  if (full !== path.join(root, clean) || !full.startsWith(root + path.sep)) throw new Error('path escapes the allowed directory');
  return full;
}

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('payload too large'), { code: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function ensureDir(dir) { await fs.mkdir(dir, { recursive: true }); }

// Config writes are atomic: a half-written playlist would be read by Nimble.
async function writeAtomic(full, data) {
  await ensureDir(path.dirname(full));
  const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, full);
}

const routes = {
  async 'GET /health'() {
    const disk = { confDir: CONF_DIR, mediaDir: MEDIA_DIR };
    for (const [k, dir] of [['conf', CONF_DIR], ['media', MEDIA_DIR]]) {
      try { await fs.access(dir); disk[`${k}Exists`] = true; }
      catch { disk[`${k}Exists`] = false; }
    }
    if (LOG_ENABLED) {
      disk.logDir = LOG_DIR;
      try { await fs.access(LOG_DIR); disk.logExists = true; }
      catch { disk.logExists = false; }
    }
    return { ok: true, agent: 'nnm-agent', version: 2, logs: LOG_ENABLED,
             maxLogChunk: MAX_LOG_CHUNK, maxUploadBytes: MAX_UPLOAD, ...disk };
  },

  async 'GET /config'(req, url) {
    const full = safeJoin(CONF_DIR, url.searchParams.get('name'));
    try {
      const [content, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
      return { name: path.basename(full), content, size: stat.size, mtime: stat.mtime };
    } catch (e) {
      if (e.code === 'ENOENT') return { name: path.basename(full), content: null, exists: false };
      throw e;
    }
  },

  async 'PUT /config'(req, url) {
    const full = safeJoin(CONF_DIR, url.searchParams.get('name'));
    const body = await readBody(req, MAX_CONFIG);
    // Keep one generation back: an operator who deploys a broken playlist can
    // restore without digging through backups.
    try { await fs.copyFile(full, `${full}.bak`); } catch { /* first write */ }
    await writeAtomic(full, body);
    const stat = await fs.stat(full);
    return { name: path.basename(full), size: stat.size, mtime: stat.mtime };
  },

  // ---- iter10 m1: logs (read-only) ------------------------------------
  //
  // Nimble writes ~13 KB/s at debug level and rotates by size, so the panel
  // cannot poll whole files. These two routes give it exactly what a tailer
  // needs and nothing else: what files exist with their identity, and a byte
  // range from one of them.

  async 'GET /logs'() {
    if (!LOG_ENABLED) throw Object.assign(new Error('logs are disabled on this agent'), { code: 404 });
    let names;
    try { names = await fs.readdir(LOG_DIR); }
    catch (e) { if (e.code === 'ENOENT') return { dir: LOG_DIR, exists: false, files: [] }; throw e; }
    const files = [];
    for (const n of names) {
      if (!LOG_EXT.includes(path.extname(n).slice(1).toLowerCase())) continue;
      try {
        const st = await fs.stat(path.join(LOG_DIR, n));
        if (!st.isFile()) continue;
        // inode + birth/change time is how the collector detects rotation:
        // a same-named file with a different inode is a different file.
        files.push({ name: n, size: st.size, mtime: st.mtime, ino: String(st.ino), dev: String(st.dev) });
      } catch { /* vanished between readdir and stat — rotation in flight */ }
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { dir: LOG_DIR, exists: true, files };
  },

  async 'GET /logs/read'(req, url) {
    if (!LOG_ENABLED) throw Object.assign(new Error('logs are disabled on this agent'), { code: 404 });
    const full = safeJoin(LOG_DIR, url.searchParams.get('name'));
    if (!LOG_EXT.includes(path.extname(full).slice(1).toLowerCase())) {
      throw Object.assign(new Error('not a log file'), { code: 400 });
    }
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0) | 0);
    const want = Math.min(MAX_LOG_CHUNK, Math.max(1, Number(url.searchParams.get('limit') || MAX_LOG_CHUNK) | 0));

    const st = await fs.stat(full);
    const ino = String(st.ino);

    // Truncation: the file is now shorter than where we left off. Either it
    // was rotated in place (copytruncate) or replaced. Say so rather than
    // returning nonsense from the middle of a new file.
    if (offset > st.size) {
      return { name: path.basename(full), ino, size: st.size, offset, nextOffset: 0,
               truncated: true, eof: true, data: '' };
    }

    const fh = await fs.open(full, 'r');
    try {
      const len = Math.min(want, st.size - offset);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, offset);
      let slice = buf.subarray(0, bytesRead);
      // Never hand back a partial line: the panel frames multi-line records
      // and a split in the middle of one would corrupt the framing. Trim to
      // the last newline and let the next poll resume from there.
      const lastNl = slice.lastIndexOf(0x0a);
      let consumed = bytesRead;
      if (lastNl === -1) {
        // A single line longer than the whole window. Refusing forever would
        // wedge the cursor, so the line is handed over as-is and marked.
        if (bytesRead >= want) return { name: path.basename(full), ino, size: st.size, offset,
          nextOffset: offset + bytesRead, eof: false, partialLine: true, data: slice.toString('utf8') };
        consumed = 0; slice = slice.subarray(0, 0);
      } else {
        consumed = lastNl + 1;
        slice = slice.subarray(0, consumed);
      }
      return {
        name: path.basename(full), ino, size: st.size, offset,
        nextOffset: offset + consumed,
        eof: offset + consumed >= st.size,
        data: slice.toString('utf8'),
      };
    } finally { await fh.close(); }
  },

  async 'GET /media'() {
    await ensureDir(MEDIA_DIR);
    const names = await fs.readdir(MEDIA_DIR);
    const files = [];
    for (const n of names) {
      try {
        const st = await fs.stat(path.join(MEDIA_DIR, n));
        if (st.isFile()) files.push({ name: n, size: st.size, mtime: st.mtime });
      } catch { /* vanished between readdir and stat */ }
    }
    return { dir: MEDIA_DIR, files };
  },

  // Raw-body upload keyed by name: no multipart parser to get wrong.
  // iter12 m3 — collect a file the panel is holding.
  //
  // The panel used to push media into this agent, which is the last thing that
  // required the server to be reachable. Now the panel says "there is a file",
  // and the agent comes and gets it.
  //
  // Downloaded to a .part file, hashed while it streams, and only renamed into
  // place once the digest matches what the panel said. A 2 GB transfer cut
  // short must never become a media file Nimble will play half of.
  async 'POST /media/fetch'(req, url, task) {
    const { transferId, name, sha256: expected, size } = task || {};
    if (!transferId || !name) throw new Error('transferId and name are required');
    const full = safeJoin(MEDIA_DIR, name);
    const ext = path.extname(full).slice(1).toLowerCase();
    if (!ALLOWED_MEDIA.includes(ext)) {
      throw Object.assign(new Error(`extension .${ext || '?'} is not allowed`), { code: 415 });
    }
    if (Number(size) > MAX_UPLOAD) {
      throw Object.assign(new Error(`file is larger than the ${(MAX_UPLOAD / 1e6).toFixed(0)}MB limit`), { code: 413 });
    }
    await ensureDir(MEDIA_DIR);

    const res = await fetch(`${PANEL_URL}/api/agent-gw/media/${transferId}/content`, {
      headers: { authorization: `Bearer ${TOKEN}`, 'x-nnm-server': SERVER_ID },
    });
    if (!res.ok) throw new Error(`panel returned ${res.status} for the file`);

    const tmp = `${full}.part-${process.pid}`;
    const hash = crypto.createHash('sha256');
    let got = 0;
    try {
      const meter = new (await import('node:stream')).Transform({
        transform(chunk, _e, cb) {
          got += chunk.length;
          if (got > MAX_UPLOAD) return cb(Object.assign(new Error('payload too large'), { code: 413 }));
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      await pipeline(res.body, meter, createWriteStream(tmp));
      const digest = hash.digest('hex');
      if (expected && digest !== expected) {
        throw new Error(`checksum mismatch: got ${digest.slice(0, 12)}…, expected ${String(expected).slice(0, 12)}…`);
      }
      if (size && got !== Number(size)) {
        throw new Error(`size mismatch: got ${got} bytes, expected ${size}`);
      }
      // Atomic: Nimble must never see a half-written file under its real name.
      await fs.rename(tmp, full);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    return { name: path.basename(full), size: got, written: true };
  },

  async 'PUT /media'(req, url) {
    const name = url.searchParams.get('name');
    const full = safeJoin(MEDIA_DIR, name);
    const ext = path.extname(full).slice(1).toLowerCase();
    if (!ALLOWED_MEDIA.includes(ext)) {
      throw Object.assign(new Error(`extension .${ext || '?'} is not allowed`), { code: 415 });
    }
    await ensureDir(MEDIA_DIR);
    const tmp = `${full}.part-${process.pid}`;
    let size = 0;
    const counter = new (await import('node:stream')).Transform({
      transform(chunk, _e, cb) {
        size += chunk.length;
        if (size > MAX_UPLOAD) return cb(Object.assign(new Error('payload too large'), { code: 413 }));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, createWriteStream(tmp));
      await fs.rename(tmp, full);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    return { name: path.basename(full), size };
  },

  async 'DELETE /media'(req, url) {
    const full = safeJoin(MEDIA_DIR, url.searchParams.get('name'));
    await fs.rm(full, { force: false });
    return { ok: true, name: path.basename(full) };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://agent');
  const key = `${req.method} ${url.pathname}`;
  if (!tokenOk(req.headers.authorization)) return json(res, 401, { error: 'unauthorized' });
  const handler = routes[key];
  if (!handler) return json(res, 404, { error: 'unknown endpoint' });
  try {
    json(res, 200, await handler(req, url));
  } catch (e) {
    const code = e.code === 413 ? 413 : e.code === 415 ? 415 : e.code === 'ENOENT' ? 404 : 400;
    json(res, code, { error: e.message });
    // A rejected upload leaves the client still sending. Closing the connection
    // explicitly stops us buffering a body we already refused, and gives the
    // client a clean end instead of a half-read stream on a pooled socket.
    if (!req.readableEnded) { req.destroy(); res.destroy(); }
  }
});

// ---- iter12 m2: log tailer ------------------------------------------------

let logState = {};                 // file -> { offset, ino }
let logCfg = { enabled: false, files: [] };
const statePath = () => path.join(STATE_DIR, 'logcursor.json');
let stateWritable = true;

async function loadLogState() {
  try { logState = JSON.parse(await fs.readFile(statePath(), 'utf8')); }
  catch { logState = {}; }
}

async function saveLogState() {
  if (!stateWritable) return;
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await writeAtomic(statePath(), JSON.stringify(logState));
  } catch (e) {
    stateWritable = false;
    console.error(`[nnm-agent] cannot persist the log cursor in ${STATE_DIR} (${e.message}); ` +
                  'after a restart the tail will resume at the end of the file');
  }
}

/**
 * Read what is new in one file and hand it to `ship`.
 *
 * The cursor only advances once `ship` has succeeded, so a panel that is down
 * costs nothing: the file itself is the buffer, and the agent re-reads from
 * where it was rather than holding anything in memory.
 */
async function tailOnce(file, ship) {
  const full = safeJoin(LOG_DIR, file);
  let st;
  try { st = await fs.stat(full); }
  catch { return; }                       // not there yet — nothing to say
  const ino = String(st.ino);

  const prev = logState[file] || { offset: 0, ino: '' };
  let { offset } = prev;
  let rotated = false;

  if (prev.ino && prev.ino !== ino) { rotated = true; offset = 0; }
  else if (st.size < offset) { rotated = true; offset = 0; }   // truncated in place
  // First sight of a file: start at the end. This is a tail, not an importer,
  // and a 128 MB backlog is not what an operator asked for by enabling it.
  else if (!prev.ino && st.size > LOG_BATCH_BYTES) offset = st.size;

  const fh = await fs.open(full, 'r');
  try {
    for (;;) {
      const stat = await fh.stat();
      if (offset >= stat.size) break;
      const len = Math.min(LOG_BATCH_BYTES, stat.size - offset);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, offset);
      if (!bytesRead) break;
      let slice = buf.subarray(0, bytesRead);
      // Never ship a partial line: the panel frames multi-line records and a
      // split inside one would corrupt the framing.
      const nl = slice.lastIndexOf(0x0a);
      if (nl === -1) {
        if (bytesRead < len) break;       // incomplete line still being written
        // A single line longer than a whole batch. Ship it rather than wedge.
      } else {
        slice = slice.subarray(0, nl + 1);
      }
      await ship({ file, ino, gen: rotated ? 1 : 0, offset, data: slice.toString('utf8') });
      offset += slice.length;
      logState[file] = { offset, ino };
      await saveLogState();
      rotated = false;                    // only the first batch carries the flag
    }
  } finally { await fh.close(); }

  logState[file] = { offset, ino };
  await saveLogState();
}

async function logLoop() {
  await loadLogState();
  for (;;) {
    try {
      if (logCfg.enabled && LOG_ENABLED && logCfg.files.length) {
        for (const f of logCfg.files) {
          await tailOnce(f, async (batch) => {
            await panelFetch('/logs', batch, { timeoutMs: 30_000 });
          });
        }
      }
    } catch (e) {
      // Shipping failed, so the cursor did not move. The next pass re-reads
      // the same bytes; nothing is lost unless the file rotates first, and
      // that gap is reported by the panel rather than hidden.
      console.error(`[nnm-agent] log shipping failed: ${e && e.message || e}`);
    }
    await new Promise(r => setTimeout(r, LOG_BATCH_MS));
  }
}

// ---- iter12 m1: outbound poll loop -----------------------------------------
//
// Tasks are dispatched through the SAME route table the local HTTP server
// uses. A task names a route key ('GET /health'), so the agent cannot be asked
// to do anything it could not already do, and there is no second dispatch
// surface to keep in step with the first.
async function panelFetch(pathname, body, { timeoutMs = 35_000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${PANEL_URL}/api/agent-gw${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${TOKEN}`,
        'x-nnm-server': SERVER_ID,
      },
      body: JSON.stringify({ serverId: SERVER_ID, ...body }),
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`panel returned ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

async function runTask(task) {
  const handler = routes[task.route];
  if (!handler) throw new Error(`no handler for ${task.route}`);
  // The handlers were written against a node request and a URL. Tasks arrive
  // as plain data, so they are given the same two shapes rather than the
  // handlers being rewritten to take a third.
  const url = new URL(`http://agent${task.route.split(' ')[1]}`);
  for (const [k, v] of Object.entries(task.query || {})) url.searchParams.set(k, String(v));
  const payload = task.body === null || task.body === undefined ? null : Buffer.from(JSON.stringify(task.body));
  const req = {
    method: task.route.split(' ')[0],
    headers: {},
    async *[Symbol.asyncIterator]() { if (payload) yield payload; },
  };
  // Handlers that take structured input get it as a third argument rather
  // than having to re-parse a synthesised request body.
  return await handler(req, url, task.body ?? null);
}

async function pollLoop() {
  let backoff = 1000;
  for (;;) {
    try {
      const health = await routes['GET /health']().catch(() => null);
      const { task, config } = await panelFetch('/poll', { instanceId: INSTANCE_ID, version: AGENT_VERSION, health });
      // The panel owns whether logs are shipped and which files. Carrying it on
      // the poll response means there is nothing to configure on the box and
      // no second channel to keep alive.
      if (config?.logs) logCfg = { enabled: Boolean(config.logs.enabled), files: config.logs.files || [] };
      backoff = 1000;
      if (!task) continue;
      try {
        const result = await runTask(task);
        await panelFetch(`/task/${task.id}/result`, { ok: true, result }, { timeoutMs: 15_000 });
      } catch (e) {
        await panelFetch(`/task/${task.id}/result`, { ok: false, error: String(e && e.message || e) }, { timeoutMs: 15_000 })
          .catch(() => {});
      }
    } catch (e) {
      // The panel being unreachable is normal — it is restarting, or the link
      // is down. Back off, keep trying, and never exit: a stopped agent needs
      // someone with shell access on a machine that by design has no inbound
      // route.
      console.error(`[nnm-agent] poll failed: ${e && e.message || e} (retry in ${backoff}ms)`);
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

server.listen(PORT, BIND, () => {
  console.log(`[nnm-agent] listening on ${BIND}:${PORT}`);
  console.log(`[nnm-agent] conf=${CONF_DIR} media=${MEDIA_DIR} maxUpload=${(MAX_UPLOAD / 1e6).toFixed(0)}MB`);
  console.log(`[nnm-agent] logs=${LOG_ENABLED ? `${LOG_DIR} (read-only, chunk ${(MAX_LOG_CHUNK / 1024).toFixed(0)}KB)` : 'disabled'}`);
  if (PANEL_ENABLED) {
    console.log(`[nnm-agent] panel=${PANEL_URL} server=${SERVER_ID} instance=${INSTANCE_ID}`);
    pollLoop();
    if (LOG_ENABLED) logLoop();
  } else {
    console.log('[nnm-agent] panel polling disabled (NNM_AGENT_PANEL_URL / NNM_AGENT_SERVER_ID not set)');
  }
});
