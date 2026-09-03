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
// Written the way the row stores it: no leading slash and no `/api`, because
// that is what `action` has always contained and what the sweep filter
// matches. See `routeOf`.
export const MACHINE_ROUTES = [
  'agent-gw/',      // agents polling for work, reporting logs and metrics
  'agents/enroll',  // the one-time handshake, logged explicitly by the route
];

// Routes that log themselves with meaning this middleware cannot add — an
// outcome, a username on a failed attempt. Recorded twice otherwise.
export const EXPLICITLY_LOGGED = ['auth/login'];

// One string: the route as it is recorded, and the route the rules are applied
// to. There used to be two, and they disagreed.
//
// MEASURED 2026-09-03 on the production panel. The skip compared
// `${req.baseUrl}${req.path}` — under `app.use('/api', auditMutations)` that
// is `/api/agent-gw/logs` — against a list written without the mount prefix.
// It never matched, so every agent poll was audited from the day the rule was
// added. `action` was built from the same pieces with `/api/` stripped, so the
// sweep filter, which matches `action`, worked perfectly: one list, two
// strings, and the drift invisible from either side.
//
// The same fault a second time, found by two counters agreeing: `auth:login`
// 39 and `POST auth/login` 39. `req.path === '/auth/login'` is false at
// `finish`, where `req.path` is the whole original path again.
//
// `req.originalUrl` is the one thing Express never rewrites — not on mount, not
// on the way back out — so it is what both decisions read, and it is read once
// rather than at two different moments in the request's life.
export function routeOf(req) {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  return path.replace(/^\/+api\/+/, '').replace(/^\/+/, '');
}

export function auditMutations(req, res, next) {
  if (req.method === 'GET' || req.method === 'OPTIONS' || req.method === 'HEAD') return next();
  const route = routeOf(req);
  if (MACHINE_ROUTES.some(prefix => route.startsWith(prefix))) return next();
  const startedAt = Date.now();
  res.on('finish', () => {
    if (EXPLICITLY_LOGGED.includes(route)) return;
    logEvent({
      req,
      action: `${req.method} ${route}`,
      detail: { body: req.body && Object.keys(req.body).length ? req.body : null, ms: Date.now() - startedAt },
      outcome: res.statusCode < 400 ? 'ok' : 'error',
      status: res.statusCode,
    });
  });
  next();
}


// Rows this panel would not write today.
//
// Machine polling filled the disk twice: 8.6 million rows and 50 GB in
// v0.99.20, then 29.4 million rows and 23.8 GB again on 2026-09-03 — because
// the source was believed closed and was not. It is closed now, and the check
// that says so runs the middleware instead of reading it.
//
// Built from the same list the middleware skips **and applied to the same
// string**. The second part is the one that was missing: the list was shared
// all along, and the two consumers still disagreed because one matched a URL
// carrying `/api` and the other matched a stored `action` that does not.
// `backend/tests/audit-wiring.test.mjs` now asserts against one real request
// that the row this filter would sweep is the row the middleware would skip.
// Removing a lot of rows, in batches, saying so as it goes.
//
// MEASURED 2026-09-03. A single `deleteMany` over 29.4 million rows printed
// one line and then nothing until it finished. From the screen that is
// indistinguishable from a stalled job, and it was read as one — on a machine
// with 1.3 GB free, which led to the collection being emptied by hand while
// the sweep was in fact already done.
//
// Batching costs a little speed and buys three things: a line per batch, a
// bounded amount of journal per commit — which matters precisely when the disk
// is nearly full, the case this feature exists for — and a partial result
// instead of all or nothing if it is interrupted.
//
// Injected `find` and `remove` rather than the model, so the loop is testable
// without a database. `backend/tests/audit-sweep.test.mjs`.
export async function deleteInBatches({ find, remove, onProgress = () => {}, batch = 25000, now = Date.now }) {
  const startedAt = now();
  let removed = 0;
  for (;;) {
    const ids = await find(batch);
    if (!ids.length) break;
    const n = await remove(ids);
    removed += n;
    onProgress({ removed, batch: n, seconds: Math.round((now() - startedAt) / 1000) });
    // A batch that matched rows and removed none would otherwise spin forever
    // printing the same number — the failure this whole change is about,
    // reintroduced in a new place.
    if (n === 0) return { removed, stalled: true };
  }
  return { removed, stalled: false };
}

export function machineTrafficFilter() {
  return {
    action: {
      $regex: `^(GET|POST|PUT|PATCH|DELETE) (${MACHINE_ROUTES
        .map(r => r.replace(/^\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|')})`,
    },
  };
}
