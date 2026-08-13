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
import net from 'node:net';
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

// Everything the panel may ask about, which is wider than where it may write.
//
// A working playlist points at files the operator placed by hand — the one
// this was built against uses /srv/nimble/media/2470208/ while uploads land in
// .../gallery. Refusing to look outside the upload directory would mean the
// panel could not tell an operator that a path in their own playlist is
// missing, which is the whole point of checking.
//
// Reads are allowed anywhere under the media root; writes are not, and stay in
// MEDIA_DIR as before.
// Where reads may reach. Wider than where writes may land, because a working
// playlist points at directories the operator made by hand — but not derived
// from the upload directory, which is what the first version did.
//
// `dirname(MEDIA_DIR)` was convenient and wrong: with MEDIA_DIR set to
// /srv/nimble/media it yields /srv/nimble, which contains conf/ and therefore
// the agent's own token; with MEDIA_DIR at / it yields the whole filesystem. A
// default that widens as someone's configuration gets simpler is the wrong
// shape for a permission.
//
// So: a fixed default, and a refusal to accept a root that is obviously too
// broad. An installation whose media genuinely lives elsewhere sets it
// explicitly, which is a deliberate act by someone who knows the layout.
// A bad value narrows to the default; it never stops the agent.
//
// Throwing here was the first attempt and it was worse than the problem: an
// agent that will not start is one that cannot self-update to a fix either,
// on a machine that by design has no inbound route. Someone would have to be
// sent to it. Refusing the setting and carrying on is the only version of
// this that cannot strand a server.
const MEDIA_ROOT = (() => {
  const dflt = '/srv/nimble/media';
  const raw = process.env.NNM_AGENT_MEDIA_ROOT;
  if (!raw) return dflt;
  const want = path.resolve(raw);
  if (want.split(path.sep).filter(Boolean).length < 2) {
    console.error(`[nnm-agent] NNM_AGENT_MEDIA_ROOT=${want} is too broad to read media from; using ${dflt}`);
    return dflt;
  }
  return want;
})();

// The first external process this agent has ever run, and kept deliberately
// narrow because of it.
//
// execFile, not exec: there is no shell, so a file name containing a quote or
// a semicolon is an argument and not an instruction. The command is a
// constant; only its arguments vary, and those are paths already confined to
// the media root.
async function runTool(cmd, args, { timeoutMs = 15_000 } = {}) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}
// iter10 m1 — logs are read-only and live in their own root. Nimble's default
// on Linux is /var/log/nimble. This directory is never written to, and it is
// mounted read-only in the systemd unit, so a bug here cannot damage a log.
const LOG_DIR = path.resolve(process.env.NNM_AGENT_LOG_DIR || '/var/log/nimble');

// The Nimble this agent lives with. Loopback by default and that is the point:
// an agent answers for its own machine and no other.
const NIMBLE_URL = (process.env.NNM_AGENT_NIMBLE_URL || 'http://127.0.0.1:8082').replace(/\/+$/, '');
const NIMBLE_TIMEOUT_MS = Number(process.env.NNM_AGENT_NIMBLE_TIMEOUT_MS || 8000);
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
const AGENT_VERSION = 21;

// iter14 — the agent updates ITSELF. The panel never pushes code.
//
// That distinction is the whole safety argument, and it is borrowed from
// NET-Control where this mechanism has already survived production: a button
// in the panel does not upload anything, it asks the agent to run its own
// verified update now instead of waiting. A download whose digest does not
// match the one the panel published is discarded and the agent keeps running
// the code it already has — the failure mode is "nothing happened", not "the
// server lost its agent".
//
// Self-update needs the agent's own file to be writable by the service user.
// systemd's StateDirectory is exactly that, so installs put the agent there.
// An agent installed under /usr/local/bin cannot rewrite itself and says so,
// rather than trying and failing halfway.
const SELF_PATH = process.argv[1] || '';
async function canSelfUpdate() {
  if (!SELF_PATH) return false;
  try { await fs.access(SELF_PATH, (await import('node:fs')).constants.W_OK); return true; }
  catch { return false; }
}

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

// A file inside the given root — never a parent, never an absolute path.
//
// One level of folder is allowed, because operators organise media by role:
// the playlist this was built against separates `adds/` from `matches/`, and
// flattening that would either collide names or force everything into one
// heap. Two levels are not allowed: a depth limit that is a number invites
// argument about the number, and one level is what the work actually needs.
function safeJoin(root, name, { allowFolder = false } = {}) {
  const clean = String(name || '').trim();
  if (!clean || clean.includes('\0')) throw new Error('invalid name');
  if (path.isAbsolute(clean)) throw new Error('name must be relative');

  const parts = clean.split('/').filter(p => p !== '');
  if (parts.some(p => p === '.' || p === '..')) throw new Error('name must not contain . or ..');
  if (!allowFolder && parts.length !== 1) throw new Error('name must not contain a path');
  if (parts.length > 2) throw new Error('at most one folder is allowed');
  // A folder name has the same rules as a file name; letting one through
  // unchecked would make the check on the other pointless.
  if (parts.some(p => p !== path.basename(p))) throw new Error('invalid name');

  const rel = parts.join(path.sep);
  const full = path.resolve(root, rel);
  // resolve() alone is not enough: a symlinked root could still escape, so the
  // prefix is re-checked after resolution.
  if (full !== path.join(root, rel) || !full.startsWith(root + path.sep)) throw new Error('path escapes the allowed directory');
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


// ---- iter23 m1: reading the machine, without changing it -------------------
//
// Every helper here is a read. None runs a package manager, writes a file or
// restarts anything: the agent's new job is to answer questions, and doing is
// a separate decision with a separate envelope.
//
// Each returns null rather than false when it could not find out. "ss is not
// installed" must not read as "the port is free" — that is the difference
// between proposing an install and breaking a service.

// No shell, ever. This agent has one rule about running things and it is the
// oldest one here: `execFile`, so an argument containing a semicolon is an
// argument rather than an instruction. A `sh -c` helper written for these
// checks was caught by the gate that enforces it — correctly, because the
// paths and unit names below arrive from a panel over the network.
async function run(file, args = []) {
  try {
    const { promisify } = await import('node:util');
    const { execFile } = await import('node:child_process');
    const { stdout } = await promisify(execFile)(file, args, { timeout: 5000 });
    return String(stdout || '');
  } catch (e) { return String(e?.stdout || ''); }
}

async function hasBinary(name) {
  // `command -v` needs a shell, so: look for the file. A fixed list of the
  // places a system binary lives, which is not elegant and does not hand a
  // name to an interpreter.
  for (const dir of ['/usr/sbin', '/usr/bin', '/sbin', '/bin', '/usr/local/sbin', '/usr/local/bin']) {
    try { await fs.access(`${dir}/${name}`); return true; } catch { /* next */ }
  }
  return false;
}

async function firstLine(file, args) { return (await run(file, args)).split('\n')[0].trim() || null; }

async function unitActive(unit) {
  return (await run('systemctl', ['is-active', unit])).trim() === 'active';
}

async function portListening(port) {
  // ss, then netstat, because a minimal image has one or the other — and
  // "neither is installed" must not read as "the port is free", which is the
  // difference between proposing an install and breaking a service.
  if (await hasBinary('ss')) return (await run('ss', ['-ltn'])).includes(`:${port} `);
  if (await hasBinary('netstat')) return (await run('netstat', ['-ltn'])).includes(`:${port} `);
  return null;
}

async function certState() {
  let names = [];
  try { names = (await fs.readdir('/etc/letsencrypt/live')).filter(n => n !== 'README'); }
  catch { return { present: null, expired: null, detail: 'could not read /etc/letsencrypt/live' }; }
  if (!names.length) return { present: false, expired: null, detail: 'no certificate found' };

  const out = await run('openssl', ['x509', '-enddate', '-noout', '-in',
                                    `/etc/letsencrypt/live/${names[0]}/fullchain.pem`]);
  const m = /notAfter=(.+)/.exec(out);
  if (!m) return { present: true, expired: null, detail: `certificate for ${names[0]}, expiry unreadable` };
  const until = new Date(m[1]);
  return {
    present: true,
    expired: until.getTime() < Date.now(),
    detail: `${names[0]}, until ${until.toISOString().slice(0, 10)}`,
  };
}

// Reading the files rather than shelling out to grep, for the same reason.
// Reading the files rather than shelling out to grep, for the same reason.
async function grepConf(dir, needle) {
  try {
    for (const f of await collectFiles(dir, 3)) {
      try { if ((await fs.readFile(f, 'utf8')).includes(needle)) return true; } catch { /* next file */ }
    }
    return false;
  } catch { return null; }
}

async function collectFiles(dir, depth, out = []) {
  if (depth < 0 || out.length > 300) return out;
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = `${dir}/${e.name}`;
    if (e.isDirectory()) await collectFiles(full, depth - 1, out);
    else out.push(full);
  }
  return out;
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
    // Offered so the panel can let an operator choose which to graph.
    try { disk.interfaces = await physicalInterfaces(); } catch { disk.interfaces = []; }
    disk.mediaRoot = MEDIA_ROOT;
    disk.selfPath = SELF_PATH;
    disk.selfUpdate = await canSelfUpdate();
    return { ok: true, agent: 'nnm-agent', version: AGENT_VERSION, logs: LOG_ENABLED,
             maxLogChunk: MAX_LOG_CHUNK, maxUploadBytes: MAX_UPLOAD, ...disk };
  },

  // What configuration files are actually there.
  //
  // The panel had a default filename compiled into it and the file on this
  // fleet is called something one character different — `server_playlist.json`
  // against `server-playlist.json`. The panel reported "no playlist", which
  // was true of the name it asked for and false of the server. A guess at a
  // name is not something to build on when the directory can simply be read.
  async 'GET /config/list'() {
    let names = [];
    try { names = await fs.readdir(CONF_DIR); } catch { return { dir: CONF_DIR, files: [], readable: false }; }
    const files = [];
    for (const n of names) {
      if (!n.toLowerCase().endsWith('.json')) continue;
      try {
        const st = await fs.stat(path.join(CONF_DIR, n));
        if (st.isFile()) files.push({ name: n, size: st.size, mtime: st.mtimeMs });
      } catch { /* vanished between readdir and stat */ }
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { dir: CONF_DIR, files, readable: true };
  },

  async 'GET /config'(req, url) {
    const full = safeJoin(CONF_DIR, url.searchParams.get('name'));
    try {
      const [content, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
      return { name: path.basename(full), content, size: stat.size, mtime: stat.mtime, dir: CONF_DIR };
    } catch (e) {
      // The directory travels with the answer. "No such file" is not
      // actionable without knowing where it was looked for: a CONF_DIR
      // pointing somewhere else looks exactly like a server with no playlist.
      if (e.code === 'ENOENT') return { name: path.basename(full), content: null, exists: false, dir: CONF_DIR };
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
    // One level down as well, matching what uploads may now create. Listing
    // only the top would hide every file the operator filed under `adds/`
    // moments after putting it there.
    const files = [];
    const scan = async (rel) => {
      const dir = rel ? path.join(MEDIA_DIR, rel) : MEDIA_DIR;
      let names = [];
      try { names = await fs.readdir(dir); } catch { return; }
      for (const n of names) {
        try {
          const st = await fs.stat(path.join(dir, n));
          if (st.isFile()) files.push({ name: rel ? `${rel}/${n}` : n, size: st.size, mtime: st.mtime });
          else if (st.isDirectory() && !rel) await scan(n);
        } catch { /* vanished between readdir and stat */ }
      }
    };
    await scan('');
    // Sorted so a listing does not reshuffle itself between refreshes for
    // reasons that are the filesystem's and not the operator's.
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { dir: MEDIA_DIR, files, folders: [...new Set(files.map(f => f.name.split('/')[0]).filter((x, i, a) => files.some(f => f.name.startsWith(`${x}/`))))] };
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
  // iter19 m6 — how long does this file run.
  //
  // Needed to work out where a stopped playlist had got to: the file format
  // carries no position, so it has to be reconstructed from durations, and a
  // wrong duration puts the resume in the wrong file.
  //
  // ffprobe is asked because it reads the container rather than guessing from
  // size and bitrate. If it is not installed, that is reported — a made-up
  // duration is worse than none, because none disables the resume while a
  // wrong one silently misplaces it.
  async 'POST /media/probe'(req, url, task) {
    const paths = Array.isArray(task?.paths) ? task.paths.slice(0, 200) : [];
    const results = [];
    let toolMissing = false;

    for (const raw of paths) {
      const p = path.resolve(String(raw || ''));
      if (p !== MEDIA_ROOT && !p.startsWith(`${MEDIA_ROOT}${path.sep}`)) {
        results.push({ path: raw, ok: false, reason: 'outside the media root' });
        continue;
      }
      if (toolMissing) { results.push({ path: raw, ok: false, reason: 'ffprobe is not installed' }); continue; }
      try {
        const st = await fs.stat(p);
        // Streams as well as duration, in one call. A playlist made of files
        // that disagree on resolution or frame rate stutters at every join,
        // and the probe that measures length is already open — asking twice
        // would double the cost of the check that catches it.
        const out = await runTool('ffprobe', [
          '-v', 'error', '-print_format', 'json',
          '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels',
          p,
        ], { timeoutMs: 20_000 });

        let doc;
        try { doc = JSON.parse(String(out)); }
        catch { results.push({ path: raw, ok: false, reason: 'ffprobe returned something unreadable' }); continue; }

        const seconds = Number(doc?.format?.duration);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          results.push({ path: raw, ok: false, reason: 'ffprobe reported no usable duration' });
          continue;
        }

        const v = (doc.streams || []).find(x => x.codec_type === 'video');
        const a = (doc.streams || []).find(x => x.codec_type === 'audio');
        // r_frame_rate is a ratio like "30000/1001". Reduced here so the panel
        // compares numbers rather than two spellings of the same rate.
        const fps = (() => {
          const [n, d] = String(v?.r_frame_rate || '').split('/').map(Number);
          return n && d ? Math.round((n / d) * 1000) / 1000 : null;
        })();

        results.push({
          path: raw, ok: true,
          durationMs: Math.round(seconds * 1000),
          // Size and mtime travel with it so the panel can tell a cached
          // reading from one belonging to a file that has since been replaced.
          size: st.size, mtime: st.mtimeMs,
          video: v ? { codec: v.codec_name || null, width: v.width || null, height: v.height || null, fps } : null,
          audio: a ? { codec: a.codec_name || null, sampleRate: Number(a.sample_rate) || null, channels: a.channels || null } : null,
        });
      } catch (e) {
        const msg = String(e?.message || e);
        // `e.code === 'ENOENT'` on a spawn failure means the BINARY is absent;
        // a missing media file fails differently, because ffprobe runs and
        // then complains. Matching on the message would confuse the two the
        // first time either wording changed.
        if (e?.code === 'ENOENT' && !/No such file/i.test(msg)) {
          // Asked once, reported for all: two hundred identical failures is
          // not two hundred pieces of information.
          toolMissing = true;
          results.push({ path: raw, ok: false, reason: 'ffprobe is not installed' });
        } else {
          results.push({ path: raw, ok: false, reason: msg.slice(0, 120) });
        }
      }
    }
    return { root: MEDIA_ROOT, ffprobe: !toolMissing, results };
  },

  // iter19 m1 — does this path exist, and how big is it.
  //
  // A playlist entry naming a file that is not there plays silence, and the
  // only way to find out today is to watch the stream. Checked before the file
  // is deployed rather than after.
  async 'POST /media/stat'(req, url, task) {
    const paths = Array.isArray(task?.paths) ? task.paths.slice(0, 500) : [];
    const out = [];
    for (const raw of paths) {
      const p = path.resolve(String(raw || ''));
      // Confined to the media root. The panel decides what to ask about, but
      // not where to look — a stat is a small oracle about a filesystem and
      // this one answers only about media.
      if (p !== MEDIA_ROOT && !p.startsWith(`${MEDIA_ROOT}${path.sep}`)) {
        out.push({ path: raw, ok: false, reason: 'outside the media root' });
        continue;
      }
      try {
        const st = await fs.stat(p);
        out.push({ path: raw, ok: st.isFile(), size: st.size, mtime: st.mtimeMs, dir: st.isDirectory() });
      } catch (e) {
        out.push({ path: raw, ok: false, reason: e.code === 'ENOENT' ? 'missing' : String(e.code || e.message) });
      }
    }
    return { root: MEDIA_ROOT, results: out };
  },

  // iter16 — read Nimble's native API on the panel's behalf.
  //
  // The panel used to call the server directly, which was a leftover from
  // before the reverse transport existed. It fails outright for a server on a
  // studio LAN — the panel is remote and cannot route there — and it is the
  // one place left where the panel opens a connection TO a server, against the
  // rule the whole transport was built on.
  //
  // The agent already talks to the panel, so it asks the Nimble it lives with
  // instead. That fixes NAT, and it removes a whole class of confusion for
  // free: the address is 127.0.0.1, so the agent cannot possibly answer for a
  // different machine. A mismatched server record cost this project a dozen
  // releases; here it is impossible by construction.
  // iter20 m4 — reachability and latency from *this* box.
  //
  // The panel cannot measure a path it is not on. Whether an edge in Frankfurt
  // can reach an origin in Moscow is a fact about those two machines, and the
  // only honest way to learn it is to ask one of them. That is what an agent
  // is for.
  //
  // TCP connect time, not ICMP. Ping needs a raw socket, which means running
  // the agent as root or shelling out to a binary whose output format differs
  // per distro — and the number an operator actually cares about is whether a
  // TCP connection to the port carrying the stream comes up, and how long it
  // takes. That is what this measures, so it is what it reports: `connectMs`,
  // never "ping".
  //
  // No payload is transferred. Throughput needs something to download and a
  // decision about what that costs on a live channel; this measures the path,
  // not its capacity, and says so.
  async 'POST /probe'(_req, _url, body) {
    const targets = Array.isArray(body?.targets) ? body.targets.slice(0, 64) : [];
    const attempts = Math.min(Math.max(Number(body?.attempts) || 3, 1), 5);
    const timeoutMs = Math.min(Math.max(Number(body?.timeoutMs) || 3000, 200), 10_000);

    const once = (host, port) => new Promise((resolve) => {
      const started = process.hrtime.bigint();
      const sock = new net.Socket();
      let done = false;
      const finish = (ok, error) => {
        if (done) return;
        done = true;
        sock.destroy();
        resolve({ ok, error, ms: Number(process.hrtime.bigint() - started) / 1e6 });
      };
      sock.setTimeout(timeoutMs, () => finish(false, 'timeout'));
      sock.once('error', (e) => finish(false, e.code || e.message));
      sock.connect(port, host, () => finish(true, null));
    });

    const results = [];
    for (const tgt of targets) {
      const host = String(tgt?.host || '');
      const port = Number(tgt?.port) || 0;
      if (!host || !(port > 0 && port < 65536)) {
        results.push({ id: tgt?.id ?? null, ok: false, error: 'bad target' });
        continue;
      }
      const runs = [];
      for (let i = 0; i < attempts; i++) runs.push(await once(host, port));
      const good = runs.filter(r => r.ok).map(r => r.ms);
      results.push({
        id: tgt?.id ?? null, host, port,
        attempts, okCount: good.length,
        // Reported as a spread rather than one number: a path that answers in
        // 12ms four times and 900ms once is not a 190ms path, and averaging it
        // hides the thing worth seeing.
        minMs: good.length ? Math.round(Math.min(...good) * 10) / 10 : null,
        maxMs: good.length ? Math.round(Math.max(...good) * 10) / 10 : null,
        avgMs: good.length ? Math.round((good.reduce((a, b) => a + b, 0) / good.length) * 10) / 10 : null,
        error: good.length ? null : (runs.find(r => r.error)?.error || 'failed'),
      });
    }
    return { ok: true, agent: AGENT_VERSION, attempts, timeoutMs, results };
  },
  async 'POST /nimble'(req, url, task) {
    const rawPath = String(task?.path || '');
    // Read-only, and only Nimble's management surface. The task already comes
    // from an authenticated panel, but a proxy that forwards anything is a
    // proxy someone will eventually point somewhere else.
    if (!/^\/manage\/[A-Za-z0-9_\/-]*$/.test(rawPath)) {
      throw new Error(`refusing to fetch "${rawPath}": only /manage/... paths are allowed`);
    }
    const query = String(task?.query || '');
    if (query && !/^[A-Za-z0-9_=&.%-]*$/.test(query)) throw new Error('bad query string');

    // Loopback first, then whatever the panel knows the server by.
    //
    // Loopback is right and is what makes "which machine answered" a
    // non-question — but only if Nimble is listening on it. A management API
    // bound to the external interface alone refuses it, and the panel saw
    // nothing but "fetch failed", which names neither the address nor the
    // reason.
    //
    // The fallback is still this machine: the agent runs on it, so dialling
    // the address the panel holds for it reaches the same Nimble or nothing.
    const bases = [NIMBLE_URL];
    if (task?.baseUrl && !bases.includes(task.baseUrl)) bases.push(String(task.baseUrl).replace(/\/+$/, ''));

    const failures = [];
    for (const base of bases) {
      const target = `${base}${rawPath}${query ? `?${query}` : ''}`;
      let res;
      try {
        res = await fetch(target, { signal: AbortSignal.timeout(NIMBLE_TIMEOUT_MS) });
      } catch (e) {
        // The address is part of the fault. Without it the operator cannot
        // tell a Nimble that is down from one that is listening elsewhere.
        failures.push(`${base}: ${e?.cause?.code || e?.name || e?.message || 'unreachable'}`);
        continue;
      }
      const text = await res.text();
      // An answer, even a bad one, ends the search: a second address would be
      // asking a server that already replied.
      if (!res.ok) throw new Error(`nimble returned ${res.status} for ${rawPath}: ${text.slice(0, 160)}`);
      try { return { status: res.status, json: JSON.parse(text), via: base }; }
      catch { throw new Error(`nimble returned ${text.length} bytes of non-JSON for ${rawPath}`); }
    }
    throw new Error(`could not reach Nimble from this server — tried ${failures.join('; ')}`);
  },

  // iter14 — fetch the panel's copy of the agent, check it, become it.
  //
  // Ordering matters and is the reason this is safe: verify the digest, write
  // beside the current file, keep the old one, swap atomically, and only then
  // exit so systemd starts the new code. Every step before the rename can fail
  // without consequence.
  async 'POST /self-update'(req, url, task) {
    const { sha256: expected, version } = task || {};
    if (!expected) throw new Error('the panel did not say what to expect');
    if (!(await canSelfUpdate())) {
      throw new Error(`cannot rewrite ${SELF_PATH || 'the agent'} — this agent was installed ` +
                      'somewhere it cannot update itself; reinstall it from the panel');
    }

    const res = await fetch(`${PANEL_URL}/api/agent-gw/agent-source`, {
      headers: { authorization: `Bearer ${TOKEN}`, 'x-nnm-server': SERVER_ID },
    });
    if (!res.ok) throw new Error(`panel returned ${res.status} for the agent source`);
    const body = Buffer.from(await res.arrayBuffer());

    const digest = crypto.createHash('sha256').update(body).digest('hex');
    if (digest !== expected) {
      throw new Error(`checksum mismatch: got ${digest.slice(0, 12)}…, expected ${String(expected).slice(0, 12)}…`);
    }
    // A sanity check on the downloaded bytes, in case the panel is fronted by
    // something that returns an HTML error page with a 200.
    //
    // The first version looked for 'nnm-agent' in the leading 200 bytes, where
    // the file has a shebang and a title in capitals — so it never matched and
    // self-update failed on every agent with a message that sounded like
    // tampering. Check for what the file actually contains, and check the
    // whole of it.
    const text = body.toString('utf8');
    if (!text.startsWith('#!') || !text.includes('AGENT_VERSION')) {
      throw new Error('the downloaded file does not look like the agent (no shebang or version marker)');
    }

    const tmp = `${SELF_PATH}.new`;
    const bak = `${SELF_PATH}.bak`;
    await fs.writeFile(tmp, body, { mode: 0o755 });
    try { await fs.copyFile(SELF_PATH, bak); } catch { /* first update, nothing to keep */ }
    await fs.rename(tmp, SELF_PATH);

    // Exit non-zero so `Restart=on-failure` brings the new code up. Delayed a
    // beat so this task's result reaches the panel first — otherwise every
    // successful update would look like a failed one.
    setTimeout(() => process.exit(9), 1500);
    return { updated: true, from: AGENT_VERSION, to: Number(version) || null, sha256: digest };
  },

  async 'POST /media/fetch'(req, url, task) {
    const { transferId, name, sha256: expected, size } = task || {};
    if (!transferId || !name) throw new Error('transferId and name are required');
    const full = safeJoin(MEDIA_DIR, name, { allowFolder: true });
    // The folder is created here rather than required to exist: the operator
    // is choosing it in the panel, and making them log in to mkdir first
    // defeats the point of uploading through the panel at all.
    await fs.mkdir(path.dirname(full), { recursive: true });

    // Refuse before pulling, not after.
    //
    // This machine is a broadcast server. Filling its disk does not fail a
    // file transfer, it stops encoders writing and takes streams off air —
    // and the transfer would have to run to completion first to do it. Two
    // gigabytes of margin because a disk at exactly zero cannot be recovered
    // from without someone on site.
    if (Number.isFinite(size) && size > 0) {
      try {
        const st = await fs.statfs(path.dirname(full));
        const free = st.bavail * st.bsize;
        const margin = 2 * 1024 * 1024 * 1024;
        if (size + margin > free) {
          throw new Error(`not enough space on this server: ${(free / 1e9).toFixed(1)} GB free, `
            + `this file needs ${(size / 1e9).toFixed(1)} GB plus a 2 GB margin`);
        }
      } catch (e) {
        // A filesystem that will not answer statfs is not necessarily full;
        // only a measured shortfall stops the transfer.
        if (/not enough space/.test(String(e.message))) throw e;
      }
    }
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
    const full = safeJoin(MEDIA_DIR, name, { allowFolder: true });
    await fs.mkdir(path.dirname(full), { recursive: true });
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
    const full = safeJoin(MEDIA_DIR, url.searchParams.get('name'), { allowFolder: true });
    await fs.rm(full, { force: false });
    return { ok: true, name: path.basename(full) };
  },

  // ---- iter23 m1: what this machine has, for the job it has been given ------
  //
  // Reporting only. The panel is about to start installing software and
  // opening public ports, which is a class of action it has never taken:
  // everything written so far went into somebody else's API, where a wrong
  // call is refused. A wrong apt-get is not refused; it happens.
  //
  // So this endpoint finds out and changes nothing. It runs no package
  // manager, writes no file, touches no service. The cost of being wrong here
  // is a wrong answer, not a broken machine.
  async 'GET /host/readiness'() {
    const out = { agent: AGENT_VERSION };

    // `systemctl is-active` rather than a port check: something answering on
    // 8081 says something is there, not that it is Nimble, and a gateway
    // answering on that port would read as a media server.
    out['nimble-running'] = await unitActive('nimble');

    out['playback-port-open'] = await portListening(8081);
    out['playback-port-open:detail'] = 'listening locally; a firewall in front is not visible from here';

    out['nginx-installed'] = await hasBinary('nginx');
    if (out['nginx-installed']) out['nginx-installed:detail'] = await firstLine('nginx', ['-v']);

    // Installing nginx onto a machine where something already holds 80
    // produces a broken service rather than an error, so this is asked before
    // anything is proposed.
    const p80 = await portListening(80);
    const p443 = await portListening(443);
    out['ports-free'] = (p80 === null || p443 === null) ? null : (!p80 && !p443);
    if (p80 || p443) {
      out['ports-free:detail'] = [p80 ? '80 is taken' : null, p443 ? '443 is taken' : null]
        .filter(Boolean).join(', ');
    }

    // Presence is not the question: an expired certificate is a page of
    // browser warnings, which is worse than none because it looks like an
    // attack rather than an omission.
    const cert = await certState();
    out['tls-cert'] = cert.present === null ? null : (cert.present && !cert.expired);
    out['tls-cert:detail'] = cert.detail;

    // Without a resolver line nginx looks names up once at start-up and keeps
    // a dead address until somebody restarts it — the failure that makes a
    // balancer worse than no balancer.
    out.resolver = await grepConf('/etc/nginx', 'resolver ');

    return out;
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

// ---- iter15 m1: host metrics -----------------------------------------------
//
// CPU, memory, swap and network read straight from /proc — no dependency, and
// nothing here needs privileges the agent does not already have.
//
// Everything in /proc is CUMULATIVE, so the useful numbers are differences
// between two reads. Those differences are computed HERE rather than on the
// panel, for one reason: a reboot resets the counters, and only this process
// can tell a reboot from a spike by watching its own uptime go backwards. A
// panel differencing blindly would draw a hundred-gigabit peak every time a
// server restarted.
let hostPrev = null;
let hostCfg = { enabled: false, intervalSec: 10, interfaces: [] };

async function readCpu() {
  const line = (await fs.readFile('/proc/stat', 'utf8')).split('\n')[0];
  const n = line.trim().split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal guest guest_nice
  return {
    total: n.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0),
    idle: n[3] || 0, iowait: n[4] || 0,
    system: (n[2] || 0) + (n[5] || 0) + (n[6] || 0),
    user: (n[0] || 0) + (n[1] || 0),
    steal: n[7] || 0,
  };
}

async function readMem() {
  const m = {};
  for (const l of (await fs.readFile('/proc/meminfo', 'utf8')).split('\n')) {
    const mm = /^(\w+):\s+(\d+) kB/.exec(l);
    if (mm) m[mm[1]] = Number(mm[2]);
  }
  return m;
}

async function readNet() {
  const out = {};
  for (const l of (await fs.readFile('/proc/net/dev', 'utf8')).split('\n').slice(2)) {
    const mm = /^\s*([^:]+):\s*(.*)$/.exec(l);
    if (!mm) continue;
    const f = mm[2].trim().split(/\s+/).map(Number);
    out[mm[1].trim()] = { rx: f[0] || 0, tx: f[8] || 0 };
  }
  return out;
}

// Which interfaces are real. A device directory under /sys/class/net is what
// separates a NIC from docker0, a bridge or a veth pair — summing those would
// count the same traffic twice.
export async function physicalInterfaces() {
  const out = [];
  let names = [];
  try { names = await fs.readdir('/sys/class/net'); } catch { return out; }
  for (const n of names) {
    if (n === 'lo') continue;
    try { await fs.access(`/sys/class/net/${n}/device`); out.push(n); }
    catch { /* virtual */ }
  }
  return out.sort();
}

async function uptimeSeconds() {
  try { return Number((await fs.readFile('/proc/uptime', 'utf8')).split(' ')[0]) || 0; }
  catch { return 0; }
}

/**
 * One host sample, as rates.
 *
 * Returns null on the very first read and after a reboot: there is no honest
 * rate without a previous point, and inventing one is how a graph acquires a
 * spike that never happened.
 */
export async function sampleHost(want = []) {
  const now = Date.now();
  const [cpu, mem, net, up] = await Promise.all([readCpu(), readMem(), readNet(), uptimeSeconds()]);
  const prev = hostPrev;
  hostPrev = { at: now, cpu, net, up };

  if (!prev) return null;
  // Counters reset on reboot. Uptime going backwards is the reliable tell;
  // a counter going backwards on its own can also mean an interface was
  // recreated, which is the same problem and the same answer.
  if (up < prev.up || cpu.total <= prev.cpu.total) return null;

  const secs = (now - prev.at) / 1000;
  if (secs <= 0) return null;

  const dTotal = cpu.total - prev.cpu.total;
  const pct = (a, b) => Math.max(0, Math.min(100, (100 * (a - b)) / dTotal));
  const metrics = {
    // Busy excludes idle AND iowait: a server waiting on disk is not a server
    // short of CPU, and merging them hides which one it is.
    cpu_pct: Math.max(0, Math.min(100, 100 * (dTotal - (cpu.idle - prev.cpu.idle) - (cpu.iowait - prev.cpu.iowait)) / dTotal)),
    cpu_user_pct: pct(cpu.user, prev.cpu.user),
    cpu_system_pct: pct(cpu.system, prev.cpu.system),
    cpu_iowait_pct: pct(cpu.iowait, prev.cpu.iowait),
    // On a shared VM "CPU is fine but steal is 30%" IS the diagnosis, and it
    // is invisible once folded into a single number.
    cpu_steal_pct: pct(cpu.steal, prev.cpu.steal),
    // MemAvailable, not MemTotal-MemFree: the latter counts page cache as
    // used and is wrong in both directions depending on how warm the box is.
    mem_total_mb: Math.round((mem.MemTotal || 0) / 1024),
    mem_used_mb: Math.round(((mem.MemTotal || 0) - (mem.MemAvailable || 0)) / 1024),
    mem_used_pct: mem.MemTotal ? (100 * (1 - (mem.MemAvailable || 0) / mem.MemTotal)) : 0,
    swap_total_mb: Math.round((mem.SwapTotal || 0) / 1024),
    swap_used_mb: Math.round(((mem.SwapTotal || 0) - (mem.SwapFree || 0)) / 1024),
    swap_used_pct: mem.SwapTotal ? (100 * (1 - (mem.SwapFree || 0) / mem.SwapTotal)) : 0,
  };

  const chosen = want.length ? want : await physicalInterfaces();
  let rxTotal = 0, txTotal = 0;
  for (const iface of chosen) {
    const a = net[iface], b = prev.net[iface];
    if (!a || !b) continue;
    // An interface recreated between samples restarts at zero; skip rather
    // than report a negative rate as an enormous positive one.
    if (a.rx < b.rx || a.tx < b.tx) continue;
    const rx = (a.rx - b.rx) / secs;
    const tx = (a.tx - b.tx) / secs;
    metrics[`net_${iface}_rx_bps`] = rx * 8;
    metrics[`net_${iface}_tx_bps`] = tx * 8;
    rxTotal += rx; txTotal += tx;
  }
  metrics.net_rx_bps = rxTotal * 8;
  metrics.net_tx_bps = txTotal * 8;

  return { ts: new Date(now).toISOString(), metrics, interfaces: chosen };
}

async function hostLoop() {
  for (;;) {
    const wait = Math.max(2, Number(hostCfg.intervalSec) || 10) * 1000;
    try {
      if (hostCfg.enabled) {
        const s = await sampleHost(hostCfg.interfaces || []);
        // The first read after a start or a reboot yields nothing; that is the
        // correct answer, not a gap to paper over.
        if (s) await panelFetch('/metrics', s, { timeoutMs: 15_000 });
      }
    } catch (e) {
      console.error(`[nnm-agent] host metrics failed: ${e && e.message || e}`);
    }
    await new Promise(r => setTimeout(r, wait));
  }
}

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
      // Which interfaces to watch is the panel's decision, carried on the same
      // response — nothing to configure on the box.
      if (config?.host) hostCfg = {
        enabled: Boolean(config.host.enabled),
        intervalSec: Number(config.host.intervalSec) || 10,
        interfaces: Array.isArray(config.host.interfaces) ? config.host.interfaces : [],
      };
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
    hostLoop();
  } else {
    console.log('[nnm-agent] panel polling disabled (NNM_AGENT_PANEL_URL / NNM_AGENT_SERVER_ID not set)');
  }
});
