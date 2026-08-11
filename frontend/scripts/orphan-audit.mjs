// A component file that nothing imports.
//
// dead-import-audit catches a name imported and never used *inside* a file.
// This is the other half: a whole component module that no other file imports
// at all. PipelineEditor.jsx lived like that for weeks — the transcoder editor
// was switched to ScenarioEditor and the old file was left behind, so two
// releases of "pipeline editor" work (folded forwarding, audio filter fields)
// were written into a file the app never renders. The dead-import gate could
// not see it, because the orphan imports nothing wrong — it is simply never
// reached. This gate is the contradiction of that: every component must have at
// least one inbound import, or it is not in the running app.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));

// The tree entry point is reached by the bundler, not by an import in src.
const ENTRY = new Set([path.join(SRC, 'main.jsx')]);

const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = path.join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.jsx?$/.test(p)) files.push(p);
  }
})(SRC);

// Resolve a relative import specifier from `fromFile` to an on-disk source file.
function resolveLocal(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // package import, not ours
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, base + '.jsx', base + '.js',
    path.join(base, 'index.jsx'), path.join(base, 'index.js')];
  return candidates.find(c => existsSync(c) && statSync(c).isFile()) || null;
}

// Every file another file imports.
const imported = new Set();
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  // Static imports, and dynamic ones. A component reached only through
  // `lazy(() => import('./X.jsx'))` is as much part of the running app as any
  // other — and this gate called the first such component dead, which is
  // exactly backwards: it was lazy *because* it is expensive and real.
  const patterns = [
    /(?:import\s[^'"]*?from\s*|import\s*)['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const m of [...patterns.flatMap(re => [...src.matchAll(re)])]) {
    const target = resolveLocal(file, m[1]);
    if (target) imported.add(target);
  }
}

// Only components are subject to this — pages are mounted by the router in
// App.jsx and libs are utilities; a component earns its place by being rendered.
const COMPONENTS = path.join(SRC, 'components');
const orphans = files.filter(f =>
  f.startsWith(COMPONENTS + path.sep) && !imported.has(f) && !ENTRY.has(f));

for (const o of orphans) {
  console.log(`  \u2717 ${path.relative(SRC, o)} \u2014 no other file imports it; it is not in the running app`);
}

console.log(orphans.length
  ? `\n${orphans.length} orphaned component(s)`
  : `orphan audit: OK (${files.length} files, ${imported.size} import targets)`);
process.exit(orphans.length ? 1 : 0);
