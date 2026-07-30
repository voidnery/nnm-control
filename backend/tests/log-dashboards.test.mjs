// iter10 m5 — dashboards and their links.
//
// A share link is read access to production logs without a password, so the
// checks that matter are about what it CANNOT do. Nimble writes publish URLs —
// which carry stream keys — into its log, and a link that could be edited into
// an arbitrary query would turn one transcoder view into the whole warehouse.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hashShareToken, newShareToken } from '../src/models/LogDashboard.js';
import { maskSecrets } from '../src/services/logQuery.js';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
};

console.log('SHARE TOKENS:');

check('a token is long random bytes, not a guessable id', () => {
  const a = newShareToken(), b = newShareToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 30, `token is only ${a.length} chars`);
  assert.match(a, /^[A-Za-z0-9_-]+$/, 'must survive being pasted into a URL unescaped');
});

check('only the hash is stored, and hashing is stable', () => {
  const raw = newShareToken();
  const h = hashShareToken(raw);
  assert.notEqual(h, raw);
  assert.equal(h.length, 64);
  assert.equal(hashShareToken(raw), h, 'an unstable hash would break every live link');
});

check('two tokens do not collide', () => {
  assert.notEqual(hashShareToken(newShareToken()), hashShareToken(newShareToken()));
});

console.log('\nWHAT THE LINK CANNOT DO:');

const route = readFileSync(new URL('../src/routes/logDashboards.js', import.meta.url), 'utf8');
const publicHalf = route.slice(route.indexOf('async function loadShared'), route.indexOf('logDashboardRouter.use(requireAuth)'));

check('the public window route reads its filters from the stored window', () => {
  // The whole security property in one line: if these came from req.query, the
  // link would be a query interface for the entire warehouse.
  assert.ok(publicHalf.includes('const w = req.dash.windows.find'), 'the window must come from the database');
  assert.ok(publicHalf.includes('category: w.category'), 'and so must its scope');
  assert.ok(publicHalf.includes('levels: w.levels'), 'and its levels');
});

check('the public half never reads a filter out of the request', () => {
  const offenders = publicHalf
    .split('\n')
    .filter(l => /req\.query/.test(l));
  assert.deepEqual(offenders, [], 'a filter taken from the URL is a filter the operator did not choose');
});

check('an unknown window id is refused rather than defaulted', () => {
  assert.ok(publicHalf.includes("res.status(404).json({ error: 'no such window' })"));
});

check('sharing must be enabled, not merely have a token', () => {
  assert.ok(publicHalf.includes('shareEnabled: true'),
    'revoking must take effect even if someone kept the old URL');
});

check('an expired link is refused', () => {
  assert.ok(publicHalf.includes('shareExpiresAt') && publicHalf.includes('410'));
});

check('raw rows are masked on the public path', () => {
  // Grouped output is masked in logQuery. Raw rows are not, because an
  // operator inside the panel needs the exact line — but a shared link is a
  // screen someone else can be standing in front of.
  assert.ok(publicHalf.includes('maskSecrets(x.msg)'));
  assert.ok(publicHalf.includes('maskSecrets(x.cont)'));
});

check('masking actually removes a stream key from a real publish URL', () => {
  const line = 'inactive rtmp socket removed [10.0.0.1:1935], url=rtmp://feed.example/v1/cct-a-cf?key=2CliveSecret';
  const out = maskSecrets(line);
  assert.ok(!out.includes('2CliveSecret'));
  assert.ok(out.includes('10.0.0.1'), 'addresses are not masked — the warning says so plainly');
});

console.log('\nPERMISSIONS AND ORDERING:');

check('issuing a link needs its own permission, not the one for reading logs', () => {
  const perms = readFileSync(new URL('../src/permissions.js', import.meta.url), 'utf8');
  assert.ok(perms.includes("key: 'logs.manage'"), 'a new key, because this is a different act');
  assert.ok(route.includes("requirePerm('logs.manage')"));
});

check('reading a dashboard in the panel still only needs streams.view', () => {
  assert.ok(route.includes("requirePerm('streams.view')"));
});

check('the public routes are declared before the auth middleware', () => {
  const authAt = route.indexOf('logDashboardRouter.use(requireAuth)');
  const sharedAt = route.indexOf("logDashboardRouter.get('/shared/:token'");
  assert.ok(sharedAt > 0 && sharedAt < authAt,
    'declared after requireAuth, the share route would demand a login nobody watching a wall display has');
});

check('the dashboard router is mounted before the log router', () => {
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(index.indexOf("'/api/log-dashboards'") < index.indexOf("'/api/logs'"));
});

console.log('\nSTORED WINDOWS ARE CLAMPED:');

check('a window definition cannot smuggle in unbounded values', () => {
  // The stored window is what the public route trusts, so what can be stored
  // matters as much as what can be asked for.
  assert.ok(route.includes('Math.min(900, Math.max(120, Number(w.height)'), 'height is bounded');
  assert.ok(route.includes('Math.min(3, Math.max(1, Number(w.span)'), 'span is bounded');
  assert.ok(route.includes("['15m', '1h', '6h', '24h', 'all'].includes(w.range)"), 'range is an allow-list');
  assert.ok(route.includes('.slice(0, 24)'), 'the number of windows is bounded');
});

check('levels are validated, not trusted', () => {
  assert.ok(route.includes('/^[A-Z]$/.test(x)'));
});

console.log('\nTHE PUBLIC PAGE:');

check('the shared page does not use the api helper that redirects to login', () => {
  const page = readFileSync(new URL('../../frontend/src/pages/SharedLogsPage.jsx', import.meta.url), 'utf8');
  assert.ok(!/from '\.\.\/api\.js'/.test(page),
    'api() clears the token and sends you to /login — the wrong thing to do to someone with no account');
  assert.ok(page.includes('async function pub('), 'it has its own plain fetch');
});

check('the shared route is answered before the login gate', () => {
  const app = readFileSync(new URL('../../frontend/src/App.jsx', import.meta.url), 'utf8');
  const sharedAt = app.indexOf("loc.pathname.startsWith('/shared/logs/')");
  const gateAt = app.indexOf('if (!user)');
  assert.ok(sharedAt > 0 && sharedAt < gateAt, 'otherwise a viewer is bounced to a login they cannot use');
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : '\nall dashboard checks passed');
process.exit(fail ? 1 : 0);
