// A directory the repository has and the image does not.
//
// `tools/` was written, documented in a changelog and handed over as a command
// to run — and the Dockerfile copies only `src`, so the command could not have
// worked. Instructions that are wrong cost more than a missing feature: the
// person follows them, gets an error, and now doubts the diagnosis as well as
// the tool.
//
// Only top-level directories that hold runnable code. Tests and scripts stay
// out of the image on purpose, so they are named here rather than inferred.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

// Deliberately absent from the image.
const NOT_SHIPPED = new Set(['tests', 'scripts', 'node_modules', 'coverage']);

const dirs = readdirSync(ROOT)
  .filter(e => !e.startsWith('.') && statSync(path.join(ROOT, e)).isDirectory())
  .filter(e => !NOT_SHIPPED.has(e));

let bad = 0;
for (const dir of dirs) {
  const copied = new RegExp(`^COPY\\s+${dir}\\b`, 'm').test(dockerfile);
  if (!copied) {
    console.log(`  ✗ ${dir}/ exists in the repository and no COPY in the Dockerfile brings it into the image`);
    bad++;
  }
}

console.log(bad
  ? `\n${bad} directory(ies) missing from the image`
  : `dockerfile audit: OK (${dirs.length} shipped director${dirs.length === 1 ? 'y' : 'ies'})`);
process.exit(bad ? 1 : 0);
