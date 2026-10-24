#!/usr/bin/env node
// ci/license-audit.mjs — licences of every npm dependency (direct and transitive) of backend/ and
// frontend/, read from the lock files and checked against what npm ci actually installed.
//
//   node ci/license-audit.mjs            table (Markdown) of every package, to stdout
//   node ci/license-audit.mjs --bundle   + build the SPA once and mark which packages the bundle holds
//   node ci/license-audit.mjs --check    gate: exit 1 if anything that ships carries a copyleft or an
//                                        unknown licence (used by ci/test.sh)
//   node ci/license-audit.mjs --notices F   licence texts of everything that ships, into file F
//                                        (build.sh → /usr/share/doc/nnm-control/THIRD-PARTY-NOTICES)
//
// "Ships" means "is distributed to a customer":
//   backend  — production dependencies without optional ones: build.sh installs exactly these
//              (npm ci --omit=dev --omit=optional) into /opt/nnm-control/backend/node_modules;
//   frontend — production dependencies: they are compiled into the static bundle. --bundle narrows
//              this to the packages Rollup really pulled in.
// Dev dependencies (Vite, jsdom, acorn, js-yaml …) are build and test tools and never leave CI.
// Needs `npm ci` in both directories first (ci/test.sh does it).
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));

// Strong copyleft reaches the work it is combined with; weak copyleft — the library itself (and, for
// LGPL, relinking). Either is a finding for a closed product; the gate refuses both.
const STRONG = /\b(AGPL|GPL|SSPL|OSL|RPL|CPAL|EUPL|CC-BY-SA|Sleepycat)\b/i;
const WEAK = /\b(LGPL|MPL|EPL|CDDL|CPL|MS-RL|APSL)\b/i;
const NONFREE = /\b(CC-BY-NC|Commons-Clause|BUSL|Elastic-|SSPL|UNLICENSED)\b/i;

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const licenseOf = (v) => {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(x => licenseOf(x)).join(' OR ');
  return v.type || '';
};
const RANK = ['permissive', 'weak-copyleft', 'strong-copyleft', 'non-free', 'unknown'];
const single = (l) => {
  if (NONFREE.test(l)) return 'non-free';
  if (STRONG.test(l.replace(/\bLGPL/gi, ''))) return 'strong-copyleft';
  if (WEAK.test(l)) return 'weak-copyleft';
  return 'permissive';
};
// SPDX expression: «A OR B» — the licensee picks, so the best alternative counts; «A AND B» — both
// apply, so the worst part counts.
export function classify(license) {
  if (!license || !String(license).trim()) return 'unknown';
  const best = (xs) => xs.reduce((a, b) => (RANK.indexOf(a) <= RANK.indexOf(b) ? a : b));
  const worst = (xs) => xs.reduce((a, b) => (RANK.indexOf(a) >= RANK.indexOf(b) ? a : b));
  return best(String(license).replace(/[()]/g, ' ').trim().split(/\s+OR\s+/i)
    .map(alt => worst(alt.trim().split(/\s+AND\s+/i).map(single))));
}

async function bundledPackages() {
  const fe = join(ROOT, 'frontend');
  const req = createRequire(join(fe, 'package.json'));
  // The ESM entry: require.resolve('vite') would hand back the deprecated CJS build.
  const viteDir = dirname(req.resolve('vite/package.json'));
  const { build } = await import(pathToFileURL(join(viteDir, readJson(join(viteDir, 'package.json')).exports['.'].import.default)).href);
  const ids = new Set();
  await build({
    root: fe, configFile: join(fe, 'vite.config.js'), logLevel: 'error',
    build: { write: false },
    plugins: [{ name: 'license-audit-probe', moduleParsed(info) { ids.add(info.id); } }],
  });
  const names = new Set();
  for (const id of ids) {
    const m = id.split('\\').join('/').match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
    if (m) names.add(m[1]);
  }
  return names;
}

export function inventory(dir, bundle = null) {
  const lock = readJson(join(ROOT, dir, 'package-lock.json'));
  const rows = [];
  for (const [path, e] of Object.entries(lock.packages || {})) {
    if (!path) continue;
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const pj = join(ROOT, dir, path, 'package.json');
    const installed = existsSync(pj) ? readJson(pj) : null;
    const license = licenseOf(e.license) || licenseOf(installed?.license) || licenseOf(installed?.licenses);
    const scope = e.dev ? 'dev' : e.devOptional ? 'dev' : e.optional ? 'optional' : 'prod';
    let ships = false;
    if (dir === 'backend') ships = scope === 'prod';
    if (dir === 'frontend') ships = scope === 'prod' && (!bundle || bundle.has(name));
    rows.push({
      dir, path, name, version: e.version || installed?.version || '', license: license || 'UNKNOWN',
      scope, installed: Boolean(installed), ships, cls: classify(license),
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// Third-party notices for the package: the licence text (and Apache NOTICE) of everything that ships.
// MIT, BSD, ISC and Apache-2.0 all require the notice to travel with copies; the backend's
// node_modules carry their own files, the minified SPA does not — so the package gets one file.
export function notices(rows) {
  const seen = new Set();
  const parts = ['Third-party software in NNM-Control', '='.repeat(36), '',
    'This product includes the following third-party packages. Their licences follow.', ''];
  for (const r of rows.filter(x => x.ships)) {
    const key = `${r.name}@${r.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dir = join(ROOT, r.dir, r.path);
    const files = existsSync(dir)
      ? readdirSync(dir).filter(f => /^(licen[cs]e|copying|notice)(\.|-|$)/i.test(f)).sort()
      : [];
    parts.push('-'.repeat(72), `${key} — ${r.license} (${r.dir === 'frontend' ? 'web interface bundle' : 'server'})`, '');
    if (!files.length) parts.push(`Licence: ${r.license}. The package carries no licence file.`, '');
    for (const f of files) parts.push(readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim(), '');
  }
  return parts.join('\n') + '\n';
}

async function main() {
  const bundle = args.has('--bundle') ? await bundledPackages() : null;
  const rows = [...inventory('backend'), ...inventory('frontend', bundle)];

  const ni = process.argv.indexOf('--notices');
  if (ni > 0) {
    const out = process.argv[ni + 1];
    if (!out) throw new Error('--notices needs an output file');
    writeFileSync(out, notices(rows));
    console.log(`license-audit: notices for ${new Set(rows.filter(r => r.ships).map(r => `${r.name}@${r.version}`)).size} packages → ${out}`);
    return;
  }

  if (args.has('--check')) {
    const bad = rows.filter(r => r.ships && r.cls !== 'permissive');
    const missing = rows.filter(r => r.ships && !r.installed);
    console.log(`license-audit: ${rows.length} packages, ships ${rows.filter(r => r.ships).length}, ` +
      `copyleft/unknown among shipped ${bad.length}, shipped but not installed ${missing.length}`);
    for (const r of bad) console.log(`  ✗ ${r.dir} ${r.name}@${r.version}: ${r.license} (${r.cls})`);
    for (const r of missing) console.log(`  ✗ ${r.dir} ${r.name}@${r.version}: not installed — run npm ci`);
    process.exit(bad.length || missing.length ? 1 : 0);
  }

  const count = (f) => rows.filter(f).length;
  console.log(`| каталог | пакет | версия | лицензия | область | в поставке | класс |`);
  console.log(`|---|---|---|---|---|---|---|`);
  for (const r of rows) {
    console.log(`| ${r.dir} | ${r.name} | ${r.version} | ${r.license} | ${r.scope} | ${r.ships ? 'да' : '—'} | ${r.cls} |`);
  }
  console.log('');
  console.log(`Всего ${rows.length}; в поставке ${count(r => r.ships)} ` +
    `(backend ${count(r => r.ships && r.dir === 'backend')}, frontend ${count(r => r.ships && r.dir === 'frontend')}` +
    `${bundle ? ', по факту сборки бандла' : ''}); копилефт и неизвестные среди поставки — ` +
    `${count(r => r.ships && r.cls !== 'permissive')}; среди всех — ${count(r => r.cls !== 'permissive')}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error('license-audit:', e?.stack || e); process.exit(2); });
}
