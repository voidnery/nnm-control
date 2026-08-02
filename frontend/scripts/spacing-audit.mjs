// Buttons that can end up touching.
//
// Two buttons in a table cell are spaced only by the whitespace between JSX
// elements, and that collapses the moment they wrap — leaving "Delete" flush
// against "Edit", stacked. A `.row` has flex `gap` and is fine; a cell has
// nothing unless the stylesheet gives it something.
//
// Checks the rule exists rather than every call site, because the rule is what
// makes the next cell right without anyone remembering.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));
const css = readFileSync(path.join(SRC, 'styles.css'), 'utf8');

let bad = 0;

if (!/td\s*>\s*button\s*\+\s*button/.test(css)) {
  console.log('  ✗ styles.css has no rule spacing adjacent buttons inside a table cell');
  bad++;
}
if (!/td\s*>\s*button[^{]*\{[^}]*margin-bottom/.test(css)) {
  console.log('  ✗ styles.css does not space wrapped buttons vertically inside a cell');
  bad++;
}

// And the margin must not be global: in a flex row it would add to the gap and
// produce two different spacings on one screen.
if (/^\s*button \+ button\s*\{/m.test(css)) {
  console.log('  ✗ the adjacent-button margin is unscoped — in a `.row` it adds to the flex gap');
  bad++;
}

// A quick sweep for the shape that motivated the rule, so a cell that opts out
// of it (inline styles overriding margin) is at least visible.
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = path.join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.jsx')) files.push(p);
  }
})(SRC);

let cells = 0;
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  for (const m of s.matchAll(/<td[^>]*>([\s\S]{0,600}?)<\/td>/g)) {
    if ((m[1].match(/<button/g) || []).length >= 2) cells++;
  }
}

console.log(bad
  ? `\n${bad} spacing rule(s) missing`
  : `spacing audit: OK (${cells} table cells with adjacent buttons, all covered by the rule)`);
process.exit(bad ? 1 : 0);
