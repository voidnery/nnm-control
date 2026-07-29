// The agent is the only thing in this project that writes to a production
// streaming box, so its guard rails are tested rather than assumed.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const TOKEN = 'test-token-that-is-long-enough-123456';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nnm-agent-'));
const CONF = path.join(root, 'conf');
const MEDIA = path.join(root, 'media');
const LOGS = path.join(root, 'logs');
const PORT = 18099;

const proc = spawn(process.execPath, [new URL('../nnm-agent.mjs', import.meta.url).pathname], {
  env: { ...process.env, NNM_AGENT_PORT: String(PORT), NNM_AGENT_TOKEN: TOKEN,
         NNM_AGENT_CONF_DIR: CONF, NNM_AGENT_MEDIA_DIR: MEDIA, NNM_AGENT_MAX_UPLOAD_MB: '1',
         NNM_AGENT_LOG_DIR: LOGS, NNM_AGENT_LOG_CHUNK_KB: '1' },
  stdio: 'ignore',
});
const base = `http://127.0.0.1:${PORT}`;
// A refused upload closes the connection mid-body, which can leave a dead
// socket in fetch's keep-alive pool; a real client simply reconnects, so one
// retry on a transport error keeps the test honest without masking failures.
const call = async (m, p, { token = TOKEN, body } = {}) => {
  const opts = { method: m, headers: token ? { authorization: `Bearer ${token}` } : {}, body };
  try { return await fetch(base + p, opts); }
  catch { await new Promise(r => setTimeout(r, 150)); return fetch(base + p, opts); }
};

// wait for listen
for (let i = 0; i < 50; i++) {
  try { await call('GET', '/health'); break; } catch { await new Promise(r => setTimeout(r, 100)); }
}

let bad = 0;
const check = async (name, fn) => {
  try { const ok = await fn(); if (ok) console.log(`  ✓ ${name}`); else { bad++; console.log(`  ✗ ${name}`); } }
  catch (e) { bad++; console.log(`  ✗ ${name} — threw ${e.message}`); }
};

console.log('AUTH:');
await check('no token is rejected', async () => (await call('GET', '/health', { token: '' })).status === 401);
await check('wrong token is rejected', async () => (await call('GET', '/health', { token: 'x'.repeat(36) })).status === 401);
await check('valid token is accepted', async () => (await call('GET', '/health')).ok);

console.log('\nPATH CONFINEMENT:');
for (const evil of ['../escape.json', '../../etc/passwd', 'sub/dir.json', '/etc/passwd', 'a\0b']) {
  await check(`config name "${evil.replace('\0','\\0')}" refused`, async () => {
    const r = await call('PUT', `/config?name=${encodeURIComponent(evil)}`, { body: 'x' });
    return r.status === 400;
  });
}
await check('nothing was written outside the conf dir', async () => {
  const outside = await fs.readdir(root);
  return !outside.includes('escape.json');
});

console.log('\nCONFIG READ/WRITE:');
await check('missing file reports exists:false', async () => {
  const d = await (await call('GET', '/config?name=playlist.json')).json();
  return d.exists === false && d.content === null;
});
await check('write creates the directory and file', async () => {
  const r = await call('PUT', '/config?name=playlist.json', { body: '{"Tasks":[]}' });
  if (!r.ok) return false;
  return (await fs.readFile(path.join(CONF, 'playlist.json'), 'utf8')) === '{"Tasks":[]}';
});
await check('read returns the content back', async () => {
  const d = await (await call('GET', '/config?name=playlist.json')).json();
  return d.content === '{"Tasks":[]}';
});
await check('rewrite keeps one .bak generation', async () => {
  await call('PUT', '/config?name=playlist.json', { body: '{"Tasks":[1]}' });
  return (await fs.readFile(path.join(CONF, 'playlist.json.bak'), 'utf8')) === '{"Tasks":[]}';
});

console.log('\nMEDIA:');
await check('disallowed extension refused', async () =>
  (await call('PUT', '/media?name=payload.sh', { body: 'rm -rf /' })).status === 415);
await check('media traversal refused', async () =>
  (await call('PUT', '/media?name=../outside.mp4', { body: 'x' })).status === 400);
await check('allowed upload lands in the media dir', async () => {
  const r = await call('PUT', '/media?name=clip.mp4', { body: Buffer.alloc(1024, 7) });
  if (!r.ok) return false;
  return (await fs.stat(path.join(MEDIA, 'clip.mp4'))).size === 1024;
});
await check('oversized upload refused and leaves no partial file', async () => {
  const r = await call('PUT', '/media?name=big.mp4', { body: Buffer.alloc(2 * 1024 * 1024, 1) });
  const names = await fs.readdir(MEDIA);
  return r.status >= 400 && !names.some(n => n.startsWith('big.mp4'));
});
await check('listing shows uploaded files only', async () => {
  const d = await (await call('GET', '/media')).json();
  return d.files.some(f => f.name === 'clip.mp4') && !d.files.some(f => f.name.includes('..'));
});
await check('delete removes the file', async () => {
  await call('DELETE', '/media?name=clip.mp4');
  return !(await fs.readdir(MEDIA)).includes('clip.mp4');
});

// iter10 m1 — log access. Real lines from srv-mediaserver2, because the
// framing this feeds depends on the exact shape of the file.
console.log('\nLOGS (read-only):');
const LINE1 = '[2026-07-29 19:14:49 P433506-T433515] [srtpull0] E: connection closed for [192.168.200.23:14331] socket=605423079 errno=2002\n';
const LINE2 = "[2026-07-29 19:14:49 P433506-T433516] [srtlisten0] D: add HLS chunk app='cct_feeds' stream='feed1' duration=6.0\n";
await fs.mkdir(LOGS, { recursive: true });
await fs.writeFile(path.join(LOGS, 'nimble.log'), LINE1 + LINE2);
await fs.writeFile(path.join(LOGS, 'secrets.key'), 'PRIVATE KEY MATERIAL');

await check('health advertises the log root', async () => {
  const d = await (await call('GET', '/health')).json();
  return d.logs === true && d.logDir === LOGS && d.logExists === true && d.version === 2;
});
await check('listing shows log files with inode and size', async () => {
  const d = await (await call('GET', '/logs')).json();
  const f = d.files.find(x => x.name === 'nimble.log');
  return Boolean(f) && f.size === Buffer.byteLength(LINE1 + LINE2) && typeof f.ino === 'string' && f.ino.length > 0;
});
await check('non-log extensions are not listed', async () =>
  !(await (await call('GET', '/logs')).json()).files.some(f => f.name === 'secrets.key'));
await check('a non-log file cannot be read even by exact name', async () =>
  (await call('GET', '/logs/read?name=secrets.key')).status >= 400);
await check('path traversal out of the log root is refused', async () =>
  (await call('GET', '/logs/read?name=../conf/playlist.json')).status >= 400);
await check('logs require the token like everything else', async () =>
  (await call('GET', '/logs', { token: '' })).status === 401);
await check('reading from zero returns the whole file and reports eof', async () => {
  const d = await (await call('GET', '/logs/read?name=nimble.log&offset=0')).json();
  return d.data === LINE1 + LINE2 && d.eof === true && d.nextOffset === Buffer.byteLength(LINE1 + LINE2);
});
await check('reading resumes exactly at the cursor', async () => {
  const d = await (await call('GET', `/logs/read?name=nimble.log&offset=${Buffer.byteLength(LINE1)}`)).json();
  return d.data === LINE2;
});
await check('a read is trimmed to whole lines, never split mid-record', async () => {
  const cut = Buffer.byteLength(LINE1) + 20;   // lands inside line 2
  const d = await (await call('GET', `/logs/read?name=nimble.log&offset=0&limit=${cut}`)).json();
  return d.data === LINE1 && d.data.endsWith('\n') && d.nextOffset === Buffer.byteLength(LINE1);
});
await check('an offset past the end reports truncation, not junk', async () => {
  const d = await (await call('GET', '/logs/read?name=nimble.log&offset=999999')).json();
  return d.truncated === true && d.nextOffset === 0 && d.data === '';
});
await check('appended lines are picked up from the old cursor', async () => {
  const at = Buffer.byteLength(LINE1 + LINE2);
  await fs.appendFile(path.join(LOGS, 'nimble.log'), LINE1);
  const d = await (await call('GET', `/logs/read?name=nimble.log&offset=${at}`)).json();
  return d.data === LINE1 && d.eof === true;
});
await check('the agent will not write to the log directory', async () => {
  const r = await call('PUT', '/logs/read?name=nimble.log', { body: 'tampered' });
  const still = await fs.readFile(path.join(LOGS, 'nimble.log'), 'utf8');
  return r.status === 404 && !still.includes('tampered');
});

console.log('\nSURFACE:');
await check('unknown endpoint is 404, not a crash', async () => (await call('GET', '/shell')).status === 404);

proc.kill();
await fs.rm(root, { recursive: true, force: true });
console.log(bad ? `\n${bad} failure(s)` : '\nall agent checks passed');
process.exit(bad ? 1 : 0);
