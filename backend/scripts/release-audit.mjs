// The release mechanism, checked from the repository rather than from a run.
//
// v0.59.0 made frontend/package.json the single source of the version and made
// the workflow fail when the tag disagrees. That gate is right, and it is also
// the thing that stopped delivery: the tag pushed was `v1.8.7`, package.json
// said `0.59.0`, and both jobs died on their first step. Nothing shipped, and
// the failure looked like CI rather than like a tagging mistake.
//
// The lesson is not "drop the gate" — a mislabelled release is worse. It is
// that the coupling between three files has to be checked here, where it is
// cheap, instead of after a tag is pushed. Every rule below is one that has
// already cost a release or would silently stop `apt upgrade` if broken:
//
//   - the two package.json files must agree, since only one is read by CI;
//   - the .deb version must keep the epoch, because 0.59.0 without `1:` sorts
//     *below* the stray 1.x versions in the pool and apt offers nothing —
//     silently, which is the worst kind;
//   - postinst must strip the epoch, because a docker tag cannot hold a colon;
//   - the Release attach must name one file, because build-apt-repo pulls the
//     whole published pool into dist/ and a glob would attach all of it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROOT = path.resolve(BACKEND, '..');
const read = p => readFileSync(path.join(ROOT, p), 'utf8');

let bad = 0;
const fail = why => { console.log(`  ✗ ${why}`); bad++; };
const notes = [];

// ---------------------------------------------------------------- versions
const beVer = JSON.parse(read('backend/package.json')).version;
const feVer = JSON.parse(read('frontend/package.json')).version;
if (beVer !== feVer) {
  fail(`backend/package.json is ${beVer} but frontend/package.json is ${feVer}; `
     + 'CI reads the frontend one, so a release would be labelled with a version '
     + 'the backend does not report');
} else {
  notes.push(`version ${feVer} agreed by both package.json files`);
}

// ---------------------------------------------------------------- workflow
const wf = read('.github/workflows/release.yml');

// The epoch. Without it 0.x never overtakes the 1.x already published.
const debVerLines = [...wf.matchAll(/^\s*echo\s+"deb_version=(.+?)"/gm)].map(m => m[1]);
if (!debVerLines.length) {
  fail('the workflow sets no deb_version output — the .deb version is unpinned');
} else if (!debVerLines.every(v => /^\d+:/.test(v))) {
  fail(`deb_version is set without a Debian epoch (${debVerLines.join(', ')}); `
     + '0.x sorts below the 1.x versions already in the pool and apt upgrade '
     + 'would offer nothing at all');
} else {
  notes.push(`deb_version carries an epoch (${debVerLines[0]})`);
}

// The image tag must not, because a docker tag cannot contain a colon.
const imgTagLines = [...wf.matchAll(/^\s*echo\s+"image_tag=(.+?)"/gm)].map(m => m[1]);
if (imgTagLines.some(v => v.includes(':'))) {
  fail(`image_tag contains a colon (${imgTagLines.join(', ')}); docker rejects it`);
}

// The tag-vs-package.json gate itself must still be there.
if (!/does not match .*package\.json/.test(wf)) {
  fail('the tag/package.json agreement check is gone from the workflow; '
     + 'a release can be labelled with any version again');
} else {
  notes.push('tag/package.json agreement is still enforced in CI');
}

// One deb per Release. build-apt-repo pulls the published pool back in, so a
// glob over dist/ attaches every historical version to every Release.
const attach = wf.slice(wf.indexOf('action-gh-release'));
const files = attach.match(/files:\s*(\S.*)/)?.[1]?.trim();
if (!files) {
  fail('the Release step attaches no files');
} else if (files.includes('*')) {
  fail(`the Release step globs (${files}), and dist/ by then holds the whole `
     + 'preserved pool — name the single file being released');
} else {
  notes.push(`the Release attaches one file (${files})`);
}

// ---------------------------------------------------------------- postinst
const postinst = read('packaging/debian/postinst');
if (!/NCV="\$\{NCV#\*:\}"/.test(postinst)) {
  fail('postinst does not strip the epoch from the installed version before '
     + 'writing NC_VERSION; docker compose would be asked for an image tag '
     + 'containing a colon and every pull would fail');
} else {
  notes.push('postinst strips the epoch before NC_VERSION');
}

// ------------------------------------------------------------- pool source
const repoSh = read('packaging/build-apt-repo.sh');
if (!/APT_POOL_DIR/.test(repoSh)) {
  fail('build-apt-repo.sh has no local pool source; taking the pool from the '
     + 'Pages CDN means a stale cache silently drops older versions from the '
     + 'index and breaks rollback');
} else {
  notes.push('the pool is preserved from a local checkout, not the CDN');
}
if (!/compare-versions/.test(repoSh)) {
  fail('build-apt-repo.sh does not check that the version being published '
     + 'sorts above what is already in the pool — the failure mode this file '
     + 'exists for is exactly a version that does not');
} else {
  notes.push('the published version is asserted to sort above the pool');
}

console.log(bad
  ? `\n${bad} problem(s) in the release mechanism`
  : `release audit: OK\n  ${notes.join('\n  ')}`);
process.exit(bad ? 1 : 0);
