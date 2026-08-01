// A destructuring rename that lands on the name of a function declared in the
// same module.
//
// `const { publicUrl: pub } = req.body` shadowed the `pub()` that builds the
// settings response. Everything saved correctly and then the handler called a
// string — "Internal server error", with the settings already written, so the
// operator retried and it failed again. It survived several releases because
// it only fires when the request carries a non-empty publicUrl.
//
// Narrow on purpose: only renames whose TARGET matches a top-level `const
// name = (` or `function name(` in the same file. That is decidable from the
// text, unlike most shadowing, and it is the shape that bites.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = path.join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
})(SRC);

let bad = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');

  // Functions declared at the top level of the module.
  const fns = new Set([
    ...[...src.matchAll(/^(?:export\s+)?function\s+(\w+)\s*\(/gm)].map(m => m[1]),
    ...[...src.matchAll(/^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/gm)].map(m => m[1]),
  ]);
  if (!fns.size) continue;

  for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const rename = /^\s*\w+\s*:\s*(\w+)\s*$/.exec(part);
      if (!rename) continue;
      const target = rename[1];
      if (!fns.has(target)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      console.log(`  ✗ ${path.relative(SRC, file)}:${line} — destructuring renames a field to "${target}", ` +
                  `which is a function declared in this file. Calls to it after this line will fail at runtime.`);
      bad++;
    }
  }
}

console.log(bad ? `\n${bad} shadowed function(s)` : `shadow audit: OK (${files.length} modules)`);
process.exit(bad ? 1 : 0);
