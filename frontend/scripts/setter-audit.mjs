// Two state writes in one handler that both derive from the same prop or the
// same state value: React has not re-rendered between them, so the second
// discards the first.
//
// This shipped. Picking an object in a function step called set('targetId')
// and then set('targetLabel'); the label stuck, the id did not, and the panel
// showed "SELECTED cct_feeds/feed1" beside an empty id. Every run then failed
// preflight on every step, and the screen gave no hint why.
//
// Narrow on purpose: only consecutive calls to the SAME single-field setter
// within one arrow body. That is the shape that loses data; a setter taking a
// whole patch, or two different setters, is fine.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = path.join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.jsx')) files.push(p);
  }
})(SRC);

// `set('a', x); set('b', y)` — same function name, called twice in a row.
const PAIR = /\b(\w+)\s*\(\s*['"`][^'"`]+['"`]\s*,[^;]*\)\s*;\s*\1\s*\(\s*['"`]/g;

let bad = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    // Look at the line and its neighbour: handlers are often wrapped.
    const window = line + ' ' + (lines[i + 1] || '');
    PAIR.lastIndex = 0;
    const m = PAIR.exec(window);
    if (!m) return;
    console.log(`  ✗ ${path.relative(SRC, file)}:${i + 1} — ${m[1]}() called twice in one handler; ` +
                'the second write discards the first. Pass one object instead.');
    bad++;
  });
}

console.log(bad
  ? `\n${bad} lost-write site(s)`
  : `setter audit: OK (${files.length} components)`);
process.exit(bad ? 1 : 0);
