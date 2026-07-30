// Six copy buttons used `navigator.clipboard?.writeText(...)` and then showed
// an unconditional "copied" toast. Outside a secure context that API is
// undefined, so the optional chain made every one of them a silent no-op that
// still claimed success. This refuses a return to that pattern.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SRC = '/home/claude/nnm-control/frontend/src';
const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(jsx?|mjs)$/.test(e.name)) files.push(p);
  }
})(SRC);

let bad = 0;
for (const f of files) {
  if (f.endsWith(path.join('lib', 'clipboard.js'))) continue;   // the helper itself
  const src = readFileSync(f, 'utf8');
  if (src.includes('navigator.clipboard')) {
    console.log(`  ✗ ${path.relative(SRC, f)}: uses navigator.clipboard directly — use copyText() from lib/clipboard.js`);
    bad++;
  }
}
const helper = readFileSync(path.join(SRC, 'lib', 'clipboard.js'), 'utf8');
if (!helper.includes('execCommand')) { console.log('  ✗ the helper has no non-secure-context fallback'); bad++; }
if (!/return (true|false|Boolean)/.test(helper)) { console.log('  ✗ the helper must report whether it worked'); bad++; }

console.log(bad ? `\n${bad} failed` : `clipboard audit: OK (${files.length} files, all copies go through the helper)`);
process.exit(bad ? 1 : 0);
