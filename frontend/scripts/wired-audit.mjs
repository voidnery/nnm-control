import path from 'node:path';
import { fileURLToPath } from 'node:url';
// State that nothing renders, and handlers nothing calls.
//
// Twice now an edit has added a `useState` and its dialog while the control
// that opens them failed to land — a string replacement that matched nothing
// and reported nothing. The result compiles, passes every other gate, and
// ships a feature with no way in.
//
// The first version of this check asked whether the setter was called at all,
// and missed the very case it was written for: `setHistory(null)` was there in
// the dialog's own onClose, so the state could be CLOSED but never OPENED.
//
// The precise signal is narrower: a setter only ever called with a falsy value
// gates something that can never appear. That is a missing control, every
// time.
import { readdirSync, readFileSync, statSync } from 'node:fs';

const SRC = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = path.join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.jsx')) files.push(p);
  }
})(SRC);

let bad = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/const \[(\w+), (set\w+)\]\s*=\s*useState\(/g)) {
    const [, name, setter] = m;
    // Only states that gate rendering: a boolean or an object standing in for
    // "is this open". A counter or a string being reset to '' is normal.
    const initial = src.slice(m.index + m[0].length, m.index + m[0].length + 20);
    if (!/^\s*(null|false)\s*\)/.test(initial)) continue;

    // Passed by reference — `.then(setFleet)` — is a use like any other, and
    // the value is whatever the promise resolves to. Two false positives came
    // from missing this, and a gate that cries twice for one real finding gets
    // ignored; that judgement was already made once over the flicker audit.
    if (new RegExp(`[(,]\\s*${setter}\\s*[),]`).test(src)) continue;

    const calls = [...src.matchAll(new RegExp(`\\b${setter}\\(([^)]*)`, 'g'))].map(c => c[1].trim());
    if (!calls.length) continue;
    const opens = calls.filter(a => a && !/^(null|false|undefined|''|""|0)$/.test(a));
    if (opens.length === 0) {
      const line = src.slice(0, m.index).split('\n').length;
      console.log(`  ✗ ${path.relative(SRC, file)}:${line} — ${setter} is only ever called with a ` +
                  `falsy value, so "${name}" can never become set. Whatever it gates has no way in.`);
      bad++;
    }
  }
}

console.log(bad ? `\n${bad} unreachable state(s)` : `wired audit: OK (${files.length} components)`);
process.exit(bad ? 1 : 0);
