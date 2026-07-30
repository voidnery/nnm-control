// iter11 m2 — installing over SSH.
//
// This hands root on a broadcast server to a panel, so the checks that matter
// are not "did it connect" but the three that bound the damage:
//
//   * the host key is verified, and a mismatch stops the handshake BEFORE the
//     credential is offered — otherwise "verification" would mean handing a
//     root password to whoever answered
//   * the command is built by the panel, never by the request
//   * nothing about the credential survives the operation
//
// Run against a real ssh2 server in this process, not a mock, because the
// property under test is exactly the handshake ordering that a mock would
// have to assume rather than demonstrate.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ssh2 from 'ssh2';
const { Server } = ssh2;
import { probeHostKey, runOverSsh, fingerprintOf, createJob, appendJob, finishJob, getJob } from '../src/services/sshInstaller.js';
import { sanitize } from '../src/services/audit.js';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
};
const acheck = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
};

const { privateKey: hostKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

/** A real SSH server that records what it was asked to do. */
function sshServer({ accept = true, output = 'ok\n', exitCode = 0 } = {}) {
  const seen = { authAttempts: [], commands: [] };
  const srv = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      seen.authAttempts.push({ method: ctx.method, username: ctx.username });
      if (ctx.method === 'none') return ctx.reject(['password', 'publickey']);
      return accept ? ctx.accept() : ctx.reject();
    });
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('exec', (acceptExec, _rej, info) => {
          seen.commands.push(info.command);
          const stream = acceptExec();
          stream.write(output);
          stream.exit(exitCode);
          stream.end();
        });
      });
    });
    client.on('error', () => { /* aborted handshakes are expected here */ });
  });
  return { srv, seen };
}

const listen = (srv) => new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv.address().port)));

console.log('HOST KEY:');

await acheck('the fingerprint can be read without offering any credential', async () => {
  const { srv, seen } = sshServer();
  const port = await listen(srv);
  try {
    const key = await probeHostKey({ host: '127.0.0.1', port });
    assert.match(key.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
    // The whole point: an operator sees what they are about to trust before
    // typing a password anywhere.
    assert.deepEqual(seen.authAttempts, [], 'the probe must not authenticate');
  } finally { srv.close(); }
});

await acheck('the same server always yields the same fingerprint', async () => {
  const { srv } = sshServer();
  const port = await listen(srv);
  try {
    const a = await probeHostKey({ host: '127.0.0.1', port });
    const b = await probeHostKey({ host: '127.0.0.1', port });
    assert.equal(a.fingerprint, b.fingerprint);
  } finally { srv.close(); }
});

check('the fingerprint is OpenSSH-shaped, so it can be compared with ssh-keyscan', () => {
  const fp = fingerprintOf(Buffer.from('some key blob'));
  assert.ok(fp.startsWith('SHA256:'));
  assert.ok(!fp.includes('='), 'OpenSSH prints it unpadded');
});

await acheck('an unreachable host fails with a plain message, not a hang', async () => {
  await assert.rejects(
    () => probeHostKey({ host: '127.0.0.1', port: 1, timeoutMs: 2000 }),
    (e) => typeof e.message === 'string' && e.message.length > 0,
  );
});

console.log('\nTHE CREDENTIAL IS NOT OFFERED TO THE WRONG MACHINE:');

await acheck('a mismatched fingerprint aborts BEFORE authentication', async () => {
  const { srv, seen } = sshServer();
  const port = await listen(srv);
  try {
    await assert.rejects(
      () => runOverSsh({
        host: '127.0.0.1', port, username: 'root', password: 'hunter2',
        expectedFingerprint: 'SHA256:' + 'A'.repeat(43),
        command: 'true',
      }),
      /host key does not match/,
    );
    // If this ever fires, "verification" would mean handing a root password to
    // whoever answered on that port.
    const offered = seen.authAttempts.filter(a => a.method !== 'none');
    assert.deepEqual(offered, [], 'no credential may be offered to an unverified host');
    assert.deepEqual(seen.commands, []);
  } finally { srv.close(); }
});

await acheck('no fingerprint at all is refused outright', async () => {
  await assert.rejects(
    () => runOverSsh({ host: '127.0.0.1', port: 22, username: 'root', password: 'x', command: 'true' }),
    /confirmed host fingerprint is required/,
  );
});

console.log('\nRUNNING THE INSTALL:');

await acheck('a confirmed fingerprint lets the command run and streams its output', async () => {
  const { srv, seen } = sshServer({ output: '==> fetching agent\n==> done.\n' });
  const port = await listen(srv);
  try {
    const { fingerprint } = await probeHostKey({ host: '127.0.0.1', port });
    let streamed = '';
    const r = await runOverSsh({
      host: '127.0.0.1', port, username: 'root', password: 'hunter2',
      expectedFingerprint: fingerprint,
      command: 'curl -fsSL https://panel/api/agents/install/abc -o /tmp/x && sh /tmp/x',
      onOutput: (c) => { streamed += c; },
    });
    assert.equal(r.exitCode, 0);
    assert.match(streamed, /==> done\./);
    assert.equal(seen.commands.length, 1);
    assert.match(seen.commands[0], /^curl -fsSL/, 'the panel-built command, unaltered');
  } finally { srv.close(); }
});

await acheck('a failing install surfaces its exit code instead of reporting success', async () => {
  const { srv } = sshServer({ output: 'nnm-agent install: node is required\n', exitCode: 1 });
  const port = await listen(srv);
  try {
    const { fingerprint } = await probeHostKey({ host: '127.0.0.1', port });
    const r = await runOverSsh({
      host: '127.0.0.1', port, username: 'root', password: 'x',
      expectedFingerprint: fingerprint, command: 'true',
    });
    assert.equal(r.exitCode, 1);
  } finally { srv.close(); }
});

await acheck('a rejected credential is reported, not retried forever', async () => {
  const { srv } = sshServer({ accept: false });
  const port = await listen(srv);
  try {
    const { fingerprint } = await probeHostKey({ host: '127.0.0.1', port });
    await assert.rejects(
      () => runOverSsh({
        host: '127.0.0.1', port, username: 'root', password: 'wrong',
        expectedFingerprint: fingerprint, command: 'true',
      }),
      (e) => /auth/i.test(e.message) || e.message.length > 0,
    );
  } finally { srv.close(); }
});

await acheck('sudo is asked for non-interactively, so a password prompt cannot hang it', async () => {
  const { srv, seen } = sshServer();
  const port = await listen(srv);
  try {
    const { fingerprint } = await probeHostKey({ host: '127.0.0.1', port });
    await runOverSsh({
      host: '127.0.0.1', port, username: 'ops', password: 'x',
      expectedFingerprint: fingerprint, command: 'sh /tmp/x', useSudo: true,
    });
    assert.match(seen.commands[0], /^sudo -n sh -c /, 'a prompt nobody can answer must fail fast, not block');
    assert.ok(seen.commands[0].includes("'sh /tmp/x'"), 'the command is quoted, not concatenated');
  } finally { srv.close(); }
});

await acheck("a quote in the command cannot break out of the sudo wrapper", async () => {
  const { srv, seen } = sshServer();
  const port = await listen(srv);
  try {
    const { fingerprint } = await probeHostKey({ host: '127.0.0.1', port });
    await runOverSsh({
      host: '127.0.0.1', port, username: 'ops', password: 'x', useSudo: true,
      expectedFingerprint: fingerprint, command: "sh /tmp/x'; rm -rf /; echo '",
    });
    // Quotes are escaped as '\'' — they close and reopen the literal rather
    // than ending it, so the payload stays one argument.
    assert.ok(seen.commands[0].includes(`'\\''`), 'quotes must be escaped, not stripped');
    assert.ok(seen.commands[0].startsWith('sudo -n sh -c '));
  } finally { srv.close(); }
});

console.log('\nNOTHING IS KEPT:');

check('the audit mask covers every shape an SSH credential arrives in', () => {
  const masked = sanitize({
    host: '10.0.0.5', port: 22, username: 'root',
    password: 'hunter2', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
    passphrase: 'secret', nested: { private_key: 'x', credential: 'y' },
  });
  for (const [k, v] of Object.entries(masked)) {
    if (['password', 'privateKey', 'passphrase'].includes(k)) assert.equal(v, '***', k);
  }
  assert.equal(masked.nested.private_key, '***');
  assert.equal(masked.nested.credential, '***');
  // Non-secrets must stay readable, or the audit log stops being useful.
  assert.equal(masked.username, 'root');
  assert.equal(masked.host, '10.0.0.5');
});

check('no module here persists a credential anywhere', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/services/sshInstaller.js', import.meta.url), 'utf8');
  assert.ok(!/mongoose|Schema|writeFile|createWriteStream/.test(src),
    'the credential must live in one closure and nowhere else');
});

check('a job transcript is bounded and expires', () => {
  const id = createJob({ host: 'x' });
  appendJob(id, 'a'.repeat(100_000));
  assert.ok(getJob(id).output.length <= 64_000, 'a runaway installer must not grow this without limit');
  finishJob(id, { status: 'done', exitCode: 0 });
  assert.equal(getJob(id).status, 'done');
});

check('an unknown job is absent, not empty', () => {
  assert.equal(getJob('nope'), null);
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : '\nall ssh-install checks passed');
process.exit(fail ? 1 : 0);
