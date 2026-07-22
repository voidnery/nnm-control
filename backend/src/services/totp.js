// Dependency-free TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30s step) + base32.
// Used for optional two-factor auth. The stored secret is encrypted at rest
// by the caller (fieldCrypto); this module only does crypto math.
import crypto from 'crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/,'').replace(/\s/g,'');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

function hotp(secretB32, counter) {
  const key = base32Decode(secretB32);
  const buf = Buffer.alloc(8);
  // big-endian counter
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16)
             | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

export function totpAt(secretB32, timeSec = Date.now() / 1000, step = 30) {
  return hotp(secretB32, Math.floor(timeSec / step));
}

// Verify with a +/- window (default 1 step) to tolerate clock skew.
export function verifyTotp(secretB32, token, { window = 1, timeSec = Date.now() / 1000, step = 30 } = {}) {
  if (!token || !/^\d{6}$/.test(String(token))) return false;
  const counter = Math.floor(timeSec / step);
  for (let w = -window; w <= window; w++) {
    if (hotp(secretB32, counter + w) === String(token)) return true;
  }
  return false;
}

export function otpauthUri(secretB32, account, issuer = 'NNM Control') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}
