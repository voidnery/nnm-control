// API tokens — docs/api/PROPOSAL-nnm-api-1.md §2.2.
//
// Format `nnm_<8 hex id>_<43 base64url secret>`: the prefix lets secret scanners (gitleaks) recognise
// a leaked token; the id names it in the audit log; the 32-byte secret is stored only as SHA-256 and
// compared in constant time. Pure functions where possible — the model is injected — so every rule
// here is tested without a database (tests/api-tokens.test.mjs).
import crypto from 'node:crypto';
import net from 'node:net';
import { PERMISSION_KEYS } from '../permissions.js';

export const TOKEN_RE = /^nnm_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

// A token never carries the right to make rights: no users, roles, tokens or webhook subscriptions.
export const NEVER_FOR_TOKENS = ['users.manage', 'roles.manage', 'apitokens.manage', 'webhooks.manage'];

export const hashSecret = (secret) => crypto.createHash('sha256').update(String(secret)).digest('hex');

export function generateToken() {
  const tokenId = crypto.randomBytes(4).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  return { tokenId, secret, raw: `nnm_${tokenId}_${secret}`, secretHash: hashSecret(secret) };
}

export function parseToken(raw) {
  const m = TOKEN_RE.exec(String(raw || ''));
  return m ? { tokenId: m[1], secret: m[2] } : null;
}

/**
 * What the issuer may put into a token: only rights the issuer has, never NEVER_FOR_TOKENS, only
 * known keys. Returns { ok, permissions } or { ok: false, refused: [...] } — refused, not trimmed,
 * so nobody receives a token with less than they asked for without noticing.
 */
export function grantable(requested, issuerPerms) {
  const want = [...new Set((Array.isArray(requested) ? requested : []).map(String))];
  const has = (k) => issuerPerms.includes('*') || issuerPerms.includes(k);
  const refused = want.filter(k => !PERMISSION_KEYS.includes(k) || NEVER_FOR_TOKENS.includes(k) || !has(k));
  if (!want.length) return { ok: false, refused: [], reason: 'a token needs at least one permission' };
  return refused.length ? { ok: false, refused } : { ok: true, permissions: want };
}

/** CIDR list check; an empty list allows any address. Bad entries are refused at issue. */
export function cidrList(list) {
  const block = new net.BlockList();
  const bad = [];
  for (const c of list || []) {
    const [addr, bits] = String(c).trim().split('/');
    const type = net.isIPv6(addr) ? 'ipv6' : net.isIPv4(addr) ? 'ipv4' : null;
    const n = bits === undefined ? (type === 'ipv6' ? 128 : 32) : Number(bits);
    if (!type || !Number.isInteger(n) || n < 0 || n > (type === 'ipv6' ? 128 : 32)) { bad.push(c); continue; }
    block.addSubnet(addr, n, type);
  }
  return { bad, allows: (ip) => {
    if (!list || !list.length) return true;
    const a = String(ip || '').replace(/^::ffff:/, '');
    if (net.isIPv4(a)) return block.check(a, 'ipv4');
    if (net.isIPv6(a)) return block.check(a, 'ipv6');
    return false;
  } };
}

/**
 * Who presents this token, or why not. `find(tokenId)` returns the stored record (or null).
 * Every refusal is the same 401 to the caller; `why` is for the log.
 */
export async function authenticate(raw, { find, ip = '', now = new Date() }) {
  const parsed = parseToken(raw);
  if (!parsed) return { ok: false, why: 'malformed' };
  const rec = await find(parsed.tokenId);
  if (!rec) return { ok: false, why: 'unknown' };
  const a = Buffer.from(hashSecret(parsed.secret), 'hex');
  const b = Buffer.from(String(rec.secretHash || ''), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, why: 'secret' };
  if (rec.revokedAt) return { ok: false, why: 'revoked' };
  if (rec.expiresAt && new Date(rec.expiresAt) <= now) return { ok: false, why: 'expired' };
  if (!cidrList(rec.allowCidrs).allows(ip)) return { ok: false, why: 'address' };
  return { ok: true, token: rec };
}

/**
 * Requests per token per minute, fixed window, in memory: a restart forgets the window, which errs
 * on the side of letting a program through. Returns null (allowed) or seconds to wait.
 */
export function rateLimiter() {
  const windows = new Map();
  return (tokenId, limit, now = Date.now()) => {
    const minute = Math.floor(now / 60000);
    const w = windows.get(tokenId);
    if (!w || w.minute !== minute) { windows.set(tokenId, { minute, n: 1 }); return null; }
    w.n += 1;
    return w.n > limit ? Math.ceil(((minute + 1) * 60000 - now) / 1000) : null;
  };
}

/** What the panel shows about a token — never the secret or its hash. */
export const publicToken = (t) => ({
  id: String(t._id), name: t.name, tokenId: t.tokenId, prefix: `nnm_${t.tokenId}_…`,
  permissions: t.permissions, allowCidrs: t.allowCidrs, expiresAt: t.expiresAt, ratePerMin: t.ratePerMin,
  createdBy: t.createdBy, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, lastUsedIp: t.lastUsedIp,
  revokedAt: t.revokedAt,
});
