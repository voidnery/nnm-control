import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Does the path the client calls exist on the server?
//
// Four routes shipped as `/servers/:id/gateway/plan` on a router already
// mounted at `/api/servers`, so their real path was
// `/api/servers/servers/:id/gateway/plan` and the dialog got a 404 the moment
// somebody pressed the button. Every test passed: the plan was correct, the
// agent was correct, the button was correct, and the two halves had never been
// introduced.
//
// Nothing else catches this. Unit tests import the service and never touch the
// router; the render smoke test mocks fetch and answers whatever it is asked;
// `node --check` sees valid syntax. The mount prefix lives in one file and the
// path in another, and only putting them together shows the mismatch.
//
// So: read the mounts, read the declarations, read the calls, and join them.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '../src');
const FRONTEND = path.resolve(HERE, '../../frontend/src');

let bad = 0;
const fail = (why) => { console.log(`  ✗ ${why}`); bad++; };
const ok = (why) => console.log(`  ✓ ${why}`);

// ---- where each router is mounted ------------------------------------------

const index = readFileSync(path.join(BACKEND, 'index.js'), 'utf8');
const mounts = new Map();          // routerName -> [prefix, …]
for (const m of index.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g)) {
  const [, prefix, name] = m;
  if (!mounts.has(name)) mounts.set(name, []);
  mounts.get(name).push(prefix);
}

// ---- what each router declares ---------------------------------------------
//
// Routes are often written through a short alias — `const r = wmspanelRouter`
// — and matching on the mounted name alone missed every one of them, then
// reported forty perfectly good endpoints as unreachable. A check that fires
// on working code is worse than one that fires on nothing: it gets switched
// off, and the one real fault goes with it.

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.js')) files.push(p);
  }
})(path.join(BACKEND, 'routes'));

// Full paths the API actually answers on, as regular expressions with the
// parameters loosened — `/:id` matches anything without a slash.
const declared = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');

  // Aliases, per file: `const r = wmspanelRouter;` means `r.get(…)` is a route
  // on that router and inherits its mount.
  const alias = new Map();
  for (const a of src.matchAll(/const\s+(\w+)\s*=\s*(\w+Router)\s*;/g)) alias.set(a[1], a[2]);
  const resolve = (name) => alias.get(name) || name;

  for (const m of src.matchAll(/(\w+)\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)) {
    const [, rawRouter, method, route] = m;
    const router = resolve(rawRouter);
    for (const prefix of mounts.get(router) || []) {
      const full = (prefix + route).replace(/\/+$/, '') || '/';
      declared.push({
        method: method.toUpperCase(),
        full,
        re: new RegExp('^' + full.replace(/:[^/]+/g, '[^/]+').replace(/\//g, '\\/') + '$'),
        file: path.relative(BACKEND, file),
      });
    }
  }
}

if (declared.length < 50) fail(`only ${declared.length} routes found; this check has lost its subject`);
else ok(`${declared.length} route(s) declared across ${mounts.size} mounted router(s)`);

// ---- what the client calls -------------------------------------------------

const jsx = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.jsx') || e.endsWith('.js')) jsx.push(p);
  }
})(FRONTEND);

// `api('/x/y')` and `api(`/x/${id}/y`)`. Template holes become a wildcard,
// since their value is not knowable here — and a hole is exactly where a
// parameter goes.
const calls = [];
for (const file of jsx) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\bapi\(\s*(['`])([^'`]+)\1/g)) {
    const raw = m[2];
    if (!raw.startsWith('/')) continue;
    calls.push({
      raw,
      // A template hole matches one segment; a query string is not part of the
      // path.
      // A hole glued to the end of a segment, with no slash before it, is a
      // query string built in a variable — `…/overview${q}` where q is
      // "?channels=…". Dropped, because it is not part of the path. A hole
      // that follows a slash is a real segment and stays.
      path: '/api' + raw.split('?')[0]
        .replace(/([^/])\$\{[^}]*\}$/, '$1')
        .replace(/\$\{[^}]*\}/g, ':x'),
      file: path.relative(FRONTEND, file),
    });
  }
}

if (calls.length < 30) fail(`only ${calls.length} api() calls found; this check has lost its subject`);
else ok(`${calls.length} call site(s) found`);

// ---- join them --------------------------------------------------------------

// A hole where the *route name* goes, rather than where a parameter goes,
// cannot be checked from here: `api(`/nimble/${id}/${path}`)` is a family of
// paths whose members are decided at runtime. Counted and reported as
// unchecked rather than failed — claiming those five are broken would be as
// wrong as claiming they are fine, and only one of the two gets the gate
// switched off.
const dynamic = [];
const seen = new Set();
for (const call of calls) {
  if (seen.has(call.path)) continue;
  seen.add(call.path);

  // Try it as written first: every hole is one path segment.
  const probe = call.path.replace(/:x/g, 'X');
  if (declared.some(d => d.re.test(probe))) continue;

  // Then allow the last hole to be a whole path fragment, which is what
  // `api(`/nimble/${id}/${path}`)` actually is — a family of routes chosen at
  // runtime. If some declared route covers the family, the call is fine and
  // this cannot say more than that.
  //
  // The first version excused a call the moment its last segment was a hole,
  // which is the shape of *every* call ending in an id — and it let
  // `/servers/:x/gateway/jobs/:x` through while the route was declared without
  // the server id at all. A 404 on the button, and the check that exists to
  // catch exactly that had waved it past.
  const loose = new RegExp('^' + call.path
    .replace(/:x(?=\/)/g, '[^/]+')
    .replace(/:x$/, '.+')
    .replace(/\//g, '\\/') + '$');
  const covered = declared.some(d => loose.test(d.full.replace(/:[^/]+/g, 'X')) || d.re.test(probe));
  if (covered) { dynamic.push(call); continue; }

  fail(`${call.file} calls ${call.raw} — no route answers ${call.path}`);
}
if (dynamic.length) {
  console.log(`  · ${dynamic.length} call(s) build the endpoint at runtime and cannot be checked here:`);
  for (const d of dynamic) console.log(`      ${d.file}: ${d.raw}`);
}
if (!bad) ok('every path the client calls is answered by a route');

// A duplicated mount prefix is the specific shape that shipped, and it is
// worth naming rather than leaving to the join above: a route declared with
// the prefix its router is already mounted under is always wrong, even if
// nothing calls it yet.
for (const [name, prefixes] of mounts) {
  for (const prefix of prefixes) {
    const seg = prefix.split('/').filter(Boolean).pop();
    if (!seg) continue;
    for (const d of declared.filter(x => x.full.startsWith(prefix))) {
      const rest = d.full.slice(prefix.length);
      if (rest.startsWith(`/${seg}/`) || rest === `/${seg}`) {
        fail(`${d.file} declares "${rest}" on ${name}, already mounted at "${prefix}" — the real path is ${d.full}`);
      }
    }
  }
}

// A permission check with nobody to check.
//
// `requirePerm` reads the user that `requireAuth` put on the request. Where a
// router applies auth to everything, per-route ordering does not matter; where
// it does not — because some route is deliberately public — a route that names
// a permission and skips auth answers "Missing permission" to a logged-in
// operator. Which is exactly the wrong message: the fault is not their role.
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const routerWide = /\.use\(\s*requireAuth\s*\)/.test(src);
  if (routerWide) continue;
  // Everything between the path and the handler. `[^)]*?` stopped at the
  // first bracket — which is `requirePerm(` itself — so the middleware list it
  // examined never contained the thing it was looking for, and the check
  // passed on every route by seeing none of them.
  for (const m of src.matchAll(/\w+\.(?:get|post|put|patch|delete)\(\s*'([^']*)'\s*,([\s\S]*?)(?:async\s*\(|\(\s*req)/g)) {
    const [, route, middleware] = m;
    if (!/requirePerm\(/.test(middleware)) continue;
    if (/requireAuth/.test(middleware)) continue;
    fail(`${path.relative(BACKEND, file)} — "${route}" checks a permission without requireAuth, `
       + 'so a logged-in operator is told their role is missing');
  }
}
if (!bad) ok('every permission check has an authenticated user to check');

// Backticks inside a template literal.
//
// Three times now a comment written as `like this` inside a shell script
// embedded in a template literal has terminated the string, turning a
// paragraph of shell into JavaScript. Twice `audit:undef` caught it as an
// undefined identifier and once it was a plain syntax error — both loud, but
// both after the fact and neither pointing at the cause.
//
// The files that carry shell in template literals are known and few. In them,
// a backtick inside a comment line is always a mistake.
for (const file of files.filter(f => /Installer|Helper|Uninstaller/.test(f.pathname || String(f)))) {
  const src = readFileSync(file, 'utf8');
  src.split('\n').forEach((line, i) => {
    const comment = /^\s*(\/\/|#)/.test(line);
    if (comment && line.includes('`')) {
      fail(`${path.relative(BACKEND, file)}:${i + 1} — a backtick in a comment inside a template `
         + 'literal ends the string and turns the shell below it into JavaScript');
    }
  });
}
if (!bad) ok('no backticks in comments inside the shell-bearing modules');

console.log(bad
  ? `\n${bad} routing problem(s) — a 404 the moment somebody presses the button`
  : 'route reachability audit: OK');
process.exit(bad ? 1 : 0);
