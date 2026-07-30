// iter11 m2 — installing the agent over SSH.
//
// THE COST, stated plainly because it does not go away: a panel that can
// install over SSH is a panel that can become root on every server it is
// given credentials for. Compromise of the panel would become compromise of
// the fleet. Three things keep that bounded:
//
//   1. NOTHING IS STORED. The credential lives in this process for the length
//      of one install and is never written to the database, to disk, or to the
//      audit log. The operator supplies it per install, exactly as they would
//      type it into a terminal. A stolen panel database yields no way in.
//
//   2. THE HOST KEY IS CHECKED. SSH to an unknown host without verifying the
//      key is a man-in-the-middle by default — and the thing being handed over
//      is root. The fingerprint is shown to the operator first and must be
//      confirmed; the install then refuses to proceed against a different key.
//
//   3. THE COMMAND IS FIXED. This is not a remote shell. The only thing it can
//      run is the enrollment installer for one ticket, in its checksum-verified
//      form, built by the panel — not by the request.
// ssh2 is CommonJS. Node's named-export detection happens to expose `Client`,
// but not `Server`, so nothing here relies on that heuristic.
import ssh2 from 'ssh2';
const { Client } = ssh2;
import crypto from 'node:crypto';

const CONNECT_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;

// OpenSSH-style: SHA256 of the raw key blob, base64, no padding.
export function fingerprintOf(keyBlob) {
  return 'SHA256:' + crypto.createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '');
}

function authOf({ password, privateKey, passphrase }) {
  if (privateKey) return { privateKey, ...(passphrase ? { passphrase } : {}) };
  if (password) return { password };
  return {};
}

/**
 * Fetch the host key without authenticating.
 *
 * ssh2 calls the verifier during the handshake, before any credential is
 * offered, so this deliberately connects with no auth at all and aborts as
 * soon as the key is in hand. An operator can therefore see what they are
 * about to trust before typing a password into anything.
 */
export function probeHostKey({ host, port = 22, timeoutMs = CONNECT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let captured = null;
    const done = (fn, arg) => { try { conn.end(); } catch { /* already closing */ } fn(arg); };
    const timer = setTimeout(() => done(reject, new Error(`no answer from ${host}:${port} within ${timeoutMs / 1000}s`)), timeoutMs);

    conn.on('error', (e) => {
      clearTimeout(timer);
      // Aborting after capturing the key is the expected path, not a failure.
      if (captured) return resolve(captured);
      reject(new Error(e.message));
    });
    conn.on('ready', () => { clearTimeout(timer); done(resolve, captured); });

    conn.connect({
      host, port, username: 'nnm-probe',
      readyTimeout: timeoutMs,
      hostVerifier: (key) => {
        captured = { fingerprint: fingerprintOf(key), bytes: key.length };
        clearTimeout(timer);
        setImmediate(() => { if (captured) resolve(captured); });
        return false;                    // never trust on first sight
      },
    });
  });
}

/**
 * Run one fixed command on the server, streaming its output back.
 *
 * @param {object}   o
 * @param {string}   o.expectedFingerprint  must match, or nothing is offered
 * @param {string}   o.command              built by the panel, never by the caller
 * @param {function} o.onOutput             called with each chunk as it arrives
 */
export function runOverSsh({
  host, port = 22, username,
  password, privateKey, passphrase,
  expectedFingerprint, command, useSudo = false,
  onOutput = () => {}, timeoutMs = INSTALL_TIMEOUT_MS,
}) {
  return new Promise((resolve, reject) => {
    if (!expectedFingerprint) return reject(new Error('a confirmed host fingerprint is required'));
    if (!command) return reject(new Error('no command'));

    const conn = new Client();
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.end(); } catch { /* already closing */ }
      fn(arg);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`the install did not finish within ${Math.round(timeoutMs / 60000)} min`)),
      timeoutMs,
    );

    conn.on('error', (e) => finish(reject, new Error(e.message)));

    conn.on('ready', () => {
      // -n so a sudo that wants a password fails immediately with a clear
      // message instead of hanging on a prompt nobody can answer.
      const full = useSudo ? `sudo -n sh -c ${shq(command)}` : command;
      conn.exec(full, { pty: false }, (err, stream) => {
        if (err) return finish(reject, new Error(err.message));
        let code = null;
        stream.on('close', (c) => { code = c; finish(resolve, { exitCode: Number(c) || 0 }); });
        stream.on('data', (d) => onOutput(d.toString('utf8')));
        stream.stderr.on('data', (d) => onOutput(d.toString('utf8')));
        void code;
      });
    });

    conn.connect({
      host, port, username,
      ...authOf({ password, privateKey, passphrase }),
      readyTimeout: CONNECT_TIMEOUT_MS,
      hostVerifier: (key) => {
        const seen = fingerprintOf(key);
        if (seen === expectedFingerprint) return true;
        // Refusing here means the credential is never sent: ssh2 aborts the
        // handshake before authentication.
        finish(reject, new Error(
          `host key does not match what you confirmed — expected ${expectedFingerprint}, got ${seen}. ` +
          'Either the server was rebuilt, or this is not the machine you think it is.'));
        return false;
      },
    });
  });
}

// Single-quote for /bin/sh. Only ever applied to a command this module built.
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ---- job store --------------------------------------------------------------
//
// An install takes about half a minute and produces output worth reading, so
// it does not block an HTTP request: the route starts a job and the browser
// follows it. In memory on purpose — this is a transcript, not a record, and
// it must not outlive the process any more than the credential does.
const jobs = new Map();
const JOB_TTL_MS = 30 * 60_000;

export function createJob(meta = {}) {
  const id = crypto.randomBytes(12).toString('hex');
  jobs.set(id, { id, status: 'running', output: '', exitCode: null, error: '', startedAt: new Date(), ...meta });
  return id;
}
export function appendJob(id, text) {
  const j = jobs.get(id);
  if (!j) return;
  // Bounded: a runaway installer must not be able to grow this without limit.
  j.output = (j.output + text).slice(-64_000);
}
export function finishJob(id, patch) {
  const j = jobs.get(id);
  if (!j) return;
  Object.assign(j, patch, { finishedAt: new Date() });
  setTimeout(() => jobs.delete(id), JOB_TTL_MS).unref?.();
}
export function getJob(id) { return jobs.get(id) || null; }
