import { AuditLog } from '../models/AuditLog.js';

// Deep-sanitize: any key smelling of a secret is masked before persisting.
const SECRET_RE = /(password|token|api_?key|secret)/i;
export function sanitize(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map(v => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_RE.test(k) ? '***' : sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

export async function logEvent({ req = null, username = '', action, target = '', detail = null, outcome = 'ok', status = 0 }) {
  try {
    await AuditLog.create({
      username: username || req?.user?.username || '',
      roleType: req?.user?.roleType || '',
      ip: req ? (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '') : '',
      action,
      target,
      detail: detail === null ? null : sanitize(detail),
      outcome,
      status,
    });
  } catch (e) {
    // Audit must never break the main flow; log to stderr only.
    console.error('[audit] write failed:', e.message);
  }
}

// Express middleware: records every mutating API request after it finishes.
// Reading req.user at finish-time works because routers set it before the
// response completes. GETs are not audited (read-only).
export function auditMutations(req, res, next) {
  if (req.method === 'GET' || req.method === 'OPTIONS' || req.method === 'HEAD') return next();
  const startedAt = Date.now();
  res.on('finish', () => {
    // /api/auth/login is logged explicitly with outcome semantics; skip here.
    if (req.path === '/auth/login') return;
    logEvent({
      req,
      action: `${req.method} ${req.baseUrl || ''}${req.path}`.replace('/api/', '').trim(),
      detail: { body: req.body && Object.keys(req.body).length ? req.body : null, ms: Date.now() - startedAt },
      outcome: res.statusCode < 400 ? 'ok' : 'error',
      status: res.statusCode,
    });
  });
  next();
}
