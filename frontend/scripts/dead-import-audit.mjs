// Imports nothing uses.
//
// Removing the Raw view left `DataView` and `CopyJsonButton` imported and
// unreferenced. Harmless on its own — and that is the problem: it is invisible,
// so the next reader assumes the component is still in play and the bundle
// carries it forever. This is how a page accumulates the artefacts of three
// previous versions of itself.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = path.join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.jsx?$/.test(p)) files.push(p);
  }
})(SRC);

let bad = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const body = src.split('\n').filter(l => !/^\s*import\s/.test(l)).join('\n');

  for (const m of src.matchAll(/^import\s+(?:(\w+)\s*,\s*)?(?:\{([^}]*)\})?\s*(?:(\w+)\s*)?from\s+'[^']+';?$/gm)) {
    const names = [m[1], m[3], ...(m[2] || '').split(',')]
      .map(x => (x || '').trim().split(/\s+as\s+/).pop().trim())
      .filter(Boolean);
    for (const name of names) {
      // Word boundary on both sides: `Modal` must not be satisfied by
      // `ModalFooter`, which is a different thing entirely.
      if (new RegExp(`\\b${name}\\b`).test(body)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      console.log(`  ✗ ${path.relative(SRC, file)}:${line} — "${name}" is imported and never used`);
      bad++;
    }
  }
}

console.log(bad ? `\n${bad} dead import(s)` : `dead-import audit: OK (${files.length} files)`);
process.exit(bad ? 1 : 0);
