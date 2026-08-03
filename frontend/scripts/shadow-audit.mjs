// A function parameter that shadows a state variable in the same component.
//
// `upload(file)` shadowed `const [file] = useState(...)`, the playlist being
// viewed — so an upload sent the playlist's name as the media file's name. It
// compiles, it runs, and it is wrong in a way nobody reads past.
//
// The backend has had this check since v0.25.3, when a destructured `pub`
// shadowed the function that built a response. The same mistake arrived on the
// frontend by a different route, so the check follows it.
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

  // State and refs declared in this file, with the line they are on.
  const declared = new Map();
  for (const m of src.matchAll(/const \[(\w+),\s*set\w+\]\s*=\s*use(?:State|Reducer)\(/g)) {
    declared.set(m[1], src.slice(0, m.index).split('\n').length);
  }
  if (!declared.size) continue;

  // Arrow functions with a single simple parameter — the shape that bites,
  // and the one that can be read without parsing the whole file.
  for (const m of src.matchAll(/(?:const \w+ = |\(\) => |onChange=\{)?\((\w+)\)\s*=>/g)) {
    const param = m[1];
    if (!declared.has(param)) continue;
    // A parameter named after state is only a problem if the body also uses
    // that name expecting the state — but distinguishing that needs scope
    // analysis. The name collision alone is worth surfacing: there is no
    // reason to reuse it, and renaming costs nothing.
    const line = src.slice(0, m.index).split('\n').length;
    console.log(`  ✗ ${path.relative(SRC, file)}:${line} — parameter "${param}" shadows the state `
      + `declared on line ${declared.get(param)}; inside this function the state is unreachable`);
    bad++;
  }
}

console.log(bad
  ? `\n${bad} shadowed state variable(s)`
  : `shadow audit: OK (${files.length} components)`);
process.exit(bad ? 1 : 0);
