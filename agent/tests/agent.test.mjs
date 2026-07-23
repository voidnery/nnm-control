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
const PORT = 18099;

const proc = spawn(process.execPath, [new URL('../nnm-agent.mjs', import.meta.url).pathname], {
  env: { ...process.env, NNM_AGENT_PORT: String(PORT), NNM_AGENT_TOKEN: TOKEN,
         NNM_AGENT_CONF_DIR: CONF, NNM_AGENT_MEDIA_DIR: MEDIA, NNM_AGENT_MAX_UPLOAD_MB: '1' },
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

console.log('\nSURFACE:');
await check('unknown endpoint is 404, not a crash', async () => (await call('GET', '/shell')).status === 404);

proc.kill();
await fs.rm(root, { recursive: true, force: true });
console.log(bad ? `\n${bad} failure(s)` : '\nall agent checks passed');
process.exit(bad ? 1 : 0);
