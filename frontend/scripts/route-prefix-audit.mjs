// A call whose path no router serves.
//
// The playlist panel called `/nimble/:id/agent/...` for every one of fourteen
// requests. The agent routes are mounted at `/api/servers`, so those landed in
// the native-API router instead — which has a control-plane guard — and every
// one came back 409 "native control is off". The feature looked like a
// permissions problem, then like a missing playlist, and was a wrong prefix.
//
// Nothing in a build catches this: both prefixes exist, both routers are real,
// and the request is well-formed. It only shows at runtime, on a server in a
// particular mode.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The frontend AND the standalone tools. Fixing the panel and leaving the
// diagnostic pointed at the wrong router is what happened here: the tool then
// reported the very fault it had itself, and reported it a second time after
// the fault was fixed.
const ROOTS = [
  path.resolve(fileURLToPath(new URL('../src', import.meta.url))),
  path.resolve(fileURLToPath(new URL('../../tools', import.meta.url))),
  path.resolve(fileURLToPath(new URL('../../backend/tools', import.meta.url))),
];
const BACK = path.resolve(fileURLToPath(new URL('../../backend/src', import.meta.url)));

// Where each router is mounted, read from the server rather than assumed.
const index = readFileSync(path.join(BACK, 'index.js'), 'utf8');
const mounts = new Map();
for (const m of index.matchAll(/app\.use\('\/api\/([\w-]+)',\s*(\w+)\)/g)) {
  if (!mounts.has(m[2])) mounts.set(m[2], m[1]);
}

// Which router owns a given path segment, from the route declarations.
const owners = new Map();   // 'agent/media' -> router variable
for (const f of readdirSync(path.join(BACK, 'routes'))) {
  if (!f.endsWith('.js')) continue;
  const src = readFileSync(path.join(BACK, 'routes', f), 'utf8');
  for (const m of src.matchAll(/(\w+Router)\.(get|post|put|delete|patch)\('([^']+)'/g)) {
    // Only the shapes worth checking: `/:id/agent/thing`.
    const seg = /^\/:[\w]+\/(agent\/[\w-]+)/.exec(m[3]);
    if (seg) owners.set(seg[1], m[1]);
  }
}

const files = [];
const walk = (d) => {
  for (const e of readdirSync(d)) {
    const p = path.join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(jsx?|mjs)$/.test(p)) files.push(p);
  }
};
for (const root of ROOTS) { try { walk(root); } catch { /* an absent tools dir is fine */ } }

let bad = 0;
let checked = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/api\(\s*`\/([\w-]+)\/\$\{[^}]+\}\/(agent\/[\w-]+)/g)) {
    const [, prefix, route] = m;
    const router = owners.get(route);
    if (!router) continue;                    // not a route this audit knows
    checked++;
    const want = mounts.get(router);
    if (want && prefix !== want) {
      const line = src.slice(0, m.index).split('\n').length;
      console.log(`  ✗ ${path.relative(path.resolve(fileURLToPath(new URL('../..', import.meta.url))), file)}:${line} — calls /${prefix}/…/${route}, `
        + `but ${router} is mounted at /api/${want}`);
      bad++;
    }
  }
}

console.log(bad
  ? `\n${bad} call(s) aimed at the wrong router`
  : `route-prefix audit: OK (${checked} agent calls, ${owners.size} routes, ${mounts.size} mounts)`);
process.exit(bad ? 1 : 0);
