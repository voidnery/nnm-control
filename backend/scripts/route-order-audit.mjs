// Express matches routes in declaration order, so a literal path declared
// after a same-method parameter route on the same router is unreachable: the
// parameter route swallows it and treats the literal as an id.
//
// This has now happened twice. The servers router carries a comment warning
// about it for `/order`; the functions router was written anyway, and
// `DELETE /runs` was handled as "delete the function whose id is 'runs'",
// which casts badly and comes back as HTTP 500 — a message that points at the
// server rather than at the route table.
//
// Order is not something to remember. It is something to check.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTES = path.resolve(fileURLToPath(new URL('../src/routes', import.meta.url)));

const CALL = /^\s*(?:export\s+)?(?:const\s+\w+\s*=\s*)?(\w+)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/;

let bad = 0;
for (const file of readdirSync(ROUTES).filter(f => f.endsWith('.js'))) {
  const lines = readFileSync(path.join(ROUTES, file), 'utf8').split('\n');
  // router -> method -> [{ path, line }]
  const declared = [];
  lines.forEach((line, i) => {
    const m = CALL.exec(line);
    if (!m) return;
    declared.push({ router: m[1], method: m[2], route: m[3], line: i + 1 });
  });

  for (let i = 0; i < declared.length; i++) {
    const later = declared[i];
    // Only literals can be shadowed.
    const seg = later.route.split('/').filter(Boolean);
    if (!seg.length || seg[0].startsWith(':')) continue;

    for (let j = 0; j < i; j++) {
      const earlier = declared[j];
      if (earlier.router !== later.router) continue;
      if (earlier.method !== later.method && earlier.method !== 'all') continue;
      const eseg = earlier.route.split('/').filter(Boolean);
      // A parameter in the same position, and the same number of segments:
      // the earlier route matches everything the later one would.
      if (eseg.length !== seg.length) continue;
      const shadows = eseg.every((p, k) => p.startsWith(':') || p === seg[k]);
      if (shadows && eseg.some(p => p.startsWith(':'))) {
        console.log(`  ✗ ${file}:${later.line} — ${later.method.toUpperCase()} ${later.route} is unreachable; ` +
                    `${earlier.method.toUpperCase()} ${earlier.route} at line ${earlier.line} matches it first`);
        bad++;
        break;
      }
    }
  }
}

console.log(bad
  ? `\n${bad} shadowed route(s) — declare the literal path before the parameter one`
  : 'route-order audit: OK');
process.exit(bad ? 1 : 0);
