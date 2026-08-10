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

// Release mechanism (scheme A). The version drift that stranded apt upgrades
// came back once because the tag, not package.json, drove the build. These
// checks assert the single-source-of-truth wiring stays in place: the release
// derives the version from package.json and refuses a mismatched tag, the deb
// carries the Debian epoch while the docker image tag does not, and postinst
// strips the epoch back off. All are readable from files, so this holds locally
// and does not wait for a tag push to catch a regression.
const read = (rel) => { try { return readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; } };
const wf = read('.github/workflows/release.yml');
const postinst = read('packaging/debian/postinst');
const buildDeb = read('packaging/build-deb.sh');

console.log('\nRELEASE MECHANISM (scheme A):');
check('release derives version from frontend/package.json',
  /require\(['"]\.\/frontend\/package\.json['"]\)\.version/.test(wf) ? 'yes' : 'no', 'yes');
check('release fails when the tag disagrees with package.json',
  /!=\s*"\$pkgver"/.test(wf) && /exit 1/.test(wf) ? 'yes' : 'no', 'yes');
check('deb version carries the Debian epoch',
  /deb_version=1:\$pkgver/.test(wf) ? 'yes' : 'no', 'yes');
// Named by what it must be, not by which variable happens to carry it: the
// output feeding the ghcr tag must be the bare version, and the tag expression
// must not reach for the epoched one. Asserting the variable name instead is
// how this check went red on a rename that changed nothing it cares about.
const bareOut = /^\s*echo "(image_tag|version)=\$pkgver"/m.test(wf);
const ghcrTag = /nnm-control-\$\{\{ matrix\.name \}\}:\$\{\{ [^}]*\.(image_tag|version) \}\}/.test(wf);
check('docker image tag is epoch-free',
  bareOut && ghcrTag && !/nnm-control-[^\n]*deb_version/.test(wf) ? 'yes' : 'no', 'yes');
check('postinst strips the epoch for NC_VERSION',
  /NCV="\$\{NCV#\*:\}"/.test(postinst) ? 'yes' : 'no', 'yes');
check('deb filename is built epoch-free',
  /FILEVER="\$\{VERSION#\*:\}"/.test(buildDeb) && /nnm-control_\$\{FILEVER\}_all\.deb/.test(buildDeb) ? 'yes' : 'no', 'yes');
check('apt pool is preserved across releases',
  /APT_POOL_DIR|APT_PUBLIC_BASE/.test(wf) ? 'yes' : 'no', 'yes');

console.log(bad ? `\n${bad} failed` : `\nversion audit: OK (${fePkg.version})`);
process.exit(bad ? 1 : 0);
