import { AuditLog } from '../models/AuditLog.js';

// Deep-sanitize: any key smelling of a secret is masked before persisting.
//
// iter11 m2 — `privateKey` and `passphrase` were NOT covered, and the audit
// middleware persists the whole request body. Adding an SSH install route
// would have written operators' private keys into the audit log in the clear.
// Found before the route existed, which is the only good time to find it.
const SECRET_RE = /(password|passphrase|token|api_?key|private_?key|secret|ticket|code|backup|credential)/i;
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
// Machine traffic that is not a decision anybody made.
//
// Agents poll this panel continuously — logs, tasks, metrics — and every one is
// a POST, so "audit every mutating request" recorded all of them. The result:
// 8.6 million rows, of which fourteen were people. 50 GB of audit on a 96 GB
// disk, and a nightly backup that grew from 228 MB to 7 GB in twelve days
// until the machine stopped.
//
// The rule was right for its subject and wrong about what a mutation is. An
// agent saying "here are my logs" changes rows in a table; it does not change
// anything a person needs to be able to reconstruct later. Audit answers "who
// did what", and a polling loop is not a who.
//
// Listed by prefix rather than by an allow-list of everything else: these are
// the machine-facing routes, they are few, and a new operator action must be
// audited by default rather than by remembering to add it.
const MACHINE_ROUTES = [
  '/agent-gw/',      // agents polling for work, reporting logs and metrics
  '/agents/enroll',  // the one-time handshake, logged explicitly by the route
];

export function auditMutations(req, res, next) {
  if (req.method === 'GET' || req.method === 'OPTIONS' || req.method === 'HEAD') return next();
  const full = `${req.baseUrl || ''}${req.path}`;
  if (MACHINE_ROUTES.some(prefix => full.startsWith(prefix))) return next();
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
