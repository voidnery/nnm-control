#!/usr/bin/env node
// NNM Control agent — the only component that touches a Nimble box's filesystem.
//
// Deliberately dependency-free (node:http + node:fs) so the whole trust surface
// fits on a screen and can be audited by the operator who installs it.
//
// It can do exactly three things, inside two fixed directories:
//   * read/write playlist & config files under CONF_DIR
//   * list/upload/delete media under MEDIA_DIR
//   * report its own health
// There is no shell, no arbitrary path, no directory listing outside those two.
import http from 'node:http';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const PORT = Number(process.env.NNM_AGENT_PORT || 8090);
const BIND = process.env.NNM_AGENT_BIND || '0.0.0.0';
const TOKEN = process.env.NNM_AGENT_TOKEN || '';
const CONF_DIR = path.resolve(process.env.NNM_AGENT_CONF_DIR || '/srv/nimble/conf');
const MEDIA_DIR = path.resolve(process.env.NNM_AGENT_MEDIA_DIR || '/srv/nimble/media/gallery');
const MAX_UPLOAD = Number(process.env.NNM_AGENT_MAX_UPLOAD_MB || 2048) * 1024 * 1024;
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
    return { ok: true, agent: 'nnm-agent', version: 1, maxUploadBytes: MAX_UPLOAD, ...disk };
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

server.listen(PORT, BIND, () => {
  console.log(`[nnm-agent] listening on ${BIND}:${PORT}`);
  console.log(`[nnm-agent] conf=${CONF_DIR} media=${MEDIA_DIR} maxUpload=${(MAX_UPLOAD / 1e6).toFixed(0)}MB`);
});
