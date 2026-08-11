import path from 'node:path';
import { fileURLToPath } from 'node:url';
// A flex row with `justify-content: space-between` and exactly two children
// means "identity on the left, controls on the right". Give it a third and the
// browser spreads all three evenly, which is how the Agents page ended up with
// a checkbox floating in the middle of an otherwise empty row.
//
// The convention this enforces: put the controls in their own nested `.row`.
// It reads the same, it survives a control being added, and it cannot drift
// into the middle of the page.
import { readdirSync, readFileSync, statSync } from 'node:fs';

const SRC = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.jsx')) files.push(p);
  }
})(SRC);

// Counting JSX children by scanning for tags does not survive this codebase:
// arrow functions in attributes (`n => ...`) contain `>`, so finding a tag's
// end by the next angle bracket is wrong almost everywhere. The first version
// of this audit did exactly that and reported the correctly-built rows.
//
// Indentation is the reliable signal here — the house style is consistent, and
// a direct child of a row sits exactly one level in.
function directChildrenByIndent(lines, openIdx) {
  const base = lines[openIdx].search(/\S/);
  let kids = 0;
  for (let i = openIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.search(/\S/);
    if (indent <= base) break;                 // the row closed
    if (indent !== base + 2) continue;         // deeper: not a direct child
    const t = line.trim();
    if (t.startsWith('</') || t.startsWith('/>') || t.startsWith('>')) continue;
    // A JSX comment is not a child.
    if (t.startsWith('{/*')) continue;
    // `{cond && (` and `<El` both introduce exactly one child.
    if (t.startsWith('<') || t.startsWith('{')) kids++;
  }
  return kids;
}

let bad = 0;
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!/<div className="row"/.test(line)) return;
    // The style may continue on the following line.
    const decl = line + (lines[i + 1] || '');
    if (!decl.includes('space-between')) return;
    const kids = directChildrenByIndent(lines, i);
    if (kids >= 3) {
      console.log(`  ✗ ${path.relative(SRC, file)}:${i + 1} — ${kids} children under space-between; ` +
                  'group the controls in a nested .row or they spread into the middle');
      bad++;
    }
  });
}

console.log(bad ? `\n${bad} row(s) spread their controls` : `layout audit: OK (${files.length} components)`);
process.exit(bad ? 1 : 0);
