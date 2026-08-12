import tls from 'node:tls';

// Can this edge carry LL-HLS? Asked, not declared.
//
// The first version of the protocol gate read `edge.httpsPort` and
// `edge.http2Confirmed` — two fields that existed nowhere in the model, in the
// API, or in the database. Every LL-HLS channel was therefore permanently "not
// ready", and the option was dead code that looked like a working feature.
// Exactly the shape of fault this codebase keeps producing: something written
// on one side of a boundary and absent on the other.
//
// A declaration would not have fixed it either. A checkbox saying "this server
// has HTTP/2" is a claim by whoever ticked it, and the failure it guards
// against — a player silently falling back to ordinary HLS — is invisible
// precisely because everything looks configured. So the panel finds out.
//
// TLS negotiates the application protocol during the handshake (ALPN). Offer
// `h2` and `http/1.1`, and the server names which one it will speak. That is
// not an inference: it is the server's own answer, before a single byte of
// HTTP is sent.

export const DEFAULT_HTTPS_PORT = 443;

// `connect` is injected so every rule below is testable against a real socket
// in-process, with no fleet and no network.
export function probeTls(host, port = DEFAULT_HTTPS_PORT, {
  timeoutMs = 5000,
  connect = tls.connect,
} = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* already gone */ }
      resolve({ ...v, ms: Date.now() - started });
    };

    const socket = connect({
      host, port,
      ALPNProtocols: ['h2', 'http/1.1'],
      servername: /^[\d.]+$/.test(String(host)) ? undefined : host,
      // A self-signed or expired certificate still tells us what we came to
      // find out. Refusing the handshake over it would report "no TLS" about a
      // server that has TLS and a certificate problem — two different things
      // with two different fixes, and the certificate one is reported below.
      rejectUnauthorized: false,
      timeout: timeoutMs,
    }, () => {
      const cert = socket.getPeerCertificate?.() || {};
      const validTo = cert.valid_to ? Date.parse(cert.valid_to) : NaN;
      finish({
        ok: true,
        tls: true,
        // The server's own choice, not ours.
        alpn: socket.alpnProtocol || null,
        http2: socket.alpnProtocol === 'h2',
        protocol: socket.getProtocol?.() || null,
        // `authorized` is what a real player's TLS stack would decide. A
        // browser refusing the certificate is a delivery failure even though
        // the handshake succeeded here.
        certTrusted: Boolean(socket.authorized),
        certError: socket.authorizationError ? String(socket.authorizationError) : null,
        certExpiresAt: Number.isFinite(validTo) ? new Date(validTo).toISOString() : null,
        certExpired: Number.isFinite(validTo) ? validTo < Date.now() : null,
      });
    });

    socket.on('timeout', () => finish({ ok: false, tls: false, reason: 'timeout' }));
    socket.on('error', (e) => finish({
      ok: false, tls: false,
      // A refused connection means nothing is listening there, which is a
      // different sentence from a handshake that failed.
      reason: /ECONNREFUSED/.test(e?.code || e?.message) ? 'no-listener'
            : /ENOTFOUND|EAI_AGAIN/.test(e?.code || e?.message) ? 'no-such-host'
            : 'handshake-failed',
      error: String(e?.message || e).slice(0, 200),
    }));
  });
}

// What the readiness check stores, reduced to what it needs and stamped, so a
// stale answer can be told from a fresh one rather than being trusted forever.
export function tlsSummary(result, at = new Date()) {
  return {
    checkedAt: at.toISOString(),
    tls: Boolean(result?.tls),
    http2: Boolean(result?.http2),
    alpn: result?.alpn || '',
    certTrusted: Boolean(result?.certTrusted),
    certExpiresAt: result?.certExpiresAt || null,
    reason: result?.reason || '',
  };
}
