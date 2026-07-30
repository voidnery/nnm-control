// The panel reported v0.8.3 while v0.9.0 was running, because the number the
// UI shows was a hand-maintained second copy of the one in package.json. This
// gate exists so that cannot recur: it asserts there is a single source of
// truth, that both packages agree, and that the built bundle really carries
// the current number rather than a stale literal.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname, '..');
const FE = path.join(ROOT, 'frontend');
const BE = path.join(ROOT, 'backend');

let bad = 0;
const check = (name, actual, expected) => {
  const ok = String(actual) === String(expected);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `: expected ${expected}, got ${actual}`}`);
  if (!ok) bad++;
};

const fePkg = JSON.parse(readFileSync(path.join(FE, 'package.json'), 'utf8'));
const bePkg = JSON.parse(readFileSync(path.join(BE, 'package.json'), 'utf8'));

console.log('VERSION CONSISTENCY:');
check('frontend and backend package versions agree', fePkg.version, bePkg.version);

// The source must not contain a literal version. Anything matching x.y.z on
// the APP_VERSION line is a hand-copied number by definition.
const app = readFileSync(path.join(FE, 'src', 'App.jsx'), 'utf8');
const line = app.split('\n').find(l => l.includes('APP_VERSION ='));
check('APP_VERSION is not a hardcoded literal',
  /['"]\d+\.\d+\.\d+['"]/.test(line || '') ? 'hardcoded' : 'derived', 'derived');
check('APP_VERSION comes from the build-time define',
  (line || '').includes('__APP_VERSION__') ? 'yes' : 'no', 'yes');

const cfg = readFileSync(path.join(FE, 'vite.config.js'), 'utf8');
check('vite.config injects it from package.json',
  cfg.includes('__APP_VERSION__') && cfg.includes('package.json') ? 'yes' : 'no', 'yes');

// If a build is present, verify what actually ships. Skipped rather than
// failed when dist is absent, so the audit still runs on a clean checkout.
const dist = path.join(FE, 'dist', 'assets');
if (existsSync(dist)) {
  const js = readdirSync(dist).filter(f => f.startsWith('index-') && f.endsWith('.js'));
  const bundle = js.map(f => readFileSync(path.join(dist, f), 'utf8')).join('');
  check('built bundle carries the current version',
    bundle.includes(`"${fePkg.version}"`) ? 'yes' : 'no', 'yes');
  check('no unsubstituted placeholder survives the build',
    bundle.includes('__APP_VERSION__') ? 'left over' : 'clean', 'clean');
} else {
  console.log('  – dist not built, skipping bundle check');
}

console.log(bad ? `\n${bad} failed` : `\nversion audit: OK (${fePkg.version})`);
process.exit(bad ? 1 : 0);
