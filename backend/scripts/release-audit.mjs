// The release mechanism, checked from the repository rather than from a run.
//
// Since HQ T-0012 there are two: release.yml (eterix-ci auto-release — tests, thin package,
// DIST-Control, the tag) and legacy-apt.yml (the old GitHub Pages APT + GHCR path, manual only,
// kept until installed clients are moved off it). The rules below that guard the old path now
// guard legacy-apt.yml; the version comes from VERSION.
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
//   - VERSION is the single source and both package.json files must agree with it;
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
const ver = read('VERSION').replace(/\r?\n$/, '');
const beVer = JSON.parse(read('backend/package.json')).version;
const feVer = JSON.parse(read('frontend/package.json')).version;
if (!/^\d+\.\d+\.\d+$/.test(ver)) {
  fail(`VERSION is "${ver}" — expected one line X.Y.Z (ERS/1 §4)`);
} else if (beVer !== ver || feVer !== ver) {
  fail(`VERSION is ${ver} but backend/package.json is ${beVer} and frontend/package.json is ${feVer}; `
     + 'the panel reports the package.json number, so a release would be labelled with a version '
     + 'the panel does not report');
} else {
  notes.push(`version ${ver}: VERSION and both package.json files agree`);
}

// ------------------------------------------------------- release.yml (new)
const rel = read('.github/workflows/release.yml');
const relOn = rel.slice(rel.indexOf('\non:'), rel.indexOf('\npermissions:'));
if (!/uses:\s*voidnery\/eterix-ci\/\.github\/workflows\/auto-release\.yml@v\d+\.\d+\.\d+\b/.test(rel)) {
  fail('release.yml does not call eterix-ci auto-release by a release tag — the release path is unpinned or gone');
} else {
  notes.push('release.yml calls eterix-ci auto-release by tag');
}
if (/tags:/.test(relOn)) {
  fail('release.yml triggers on tags; with release-by-version the tag is set by CI, and auto-release refuses a tag run');
}
if (!/branches:\s*\[?'?main/.test(relOn)) {
  fail('release.yml no longer triggers on a push to main; a VERSION bump would not release');
}
for (const [re, why] of [
  [/test-command:\s*bash ci\/test\.sh/, 'the gate does not run ci/test.sh — the tests would not run in CI'],
  [/package-name:\s*nnm-control\b/, 'the package name is not nnm-control (ERS/1 slug)'],
  [/gates-command:\s*\S/, 'no product gates — the package would be released without its e2e (class B)'],
  [/DC_TOKEN:\s*\$\{\{\s*secrets\.DC_TOKEN/, 'DC_TOKEN is not passed — ingest into DIST-Control cannot authenticate'],
]) if (!re.test(rel)) fail(`release.yml: ${why}`);
if (!bad) notes.push('release.yml: tests, nnm-control package, e2e gates, DC_TOKEN');

// ------------------------------------------------------ legacy-apt.yml (old)
const wf = read('.github/workflows/legacy-apt.yml');

// The epoch. Without it 0.x never overtakes the 1.x already published.
const debVerLines = [...wf.matchAll(/^\s*echo\s+"deb_version=(.+?)"/gm)].map(m => m[1]);
if (!debVerLines.length) {
  fail('the workflow sets no deb_version output — the .deb version is unpinned');
} else if (!debVerLines.every(v => /^\d+:/.test(v))) {
  fail(`deb_version is set without a Debian epoch (${debVerLines.join(', ')}); `
     + '0.x sorts below the 1.x versions already in the pool and apt upgrade '
     + 'would offer nothing at all');
} else {
  notes.push(`legacy deb_version carries an epoch (${debVerLines[0]})`);
}

// The image tag must not, because a docker tag cannot contain a colon.
const imgTagLines = [...wf.matchAll(/^\s*echo\s+"image_tag=(.+?)"/gm)].map(m => m[1]);
if (imgTagLines.some(v => v.includes(':'))) {
  fail(`image_tag contains a colon (${imgTagLines.join(', ')}); docker rejects it`);
}

// The legacy path takes its version from VERSION and checks both package.json files against it.
if (!/disagrees with VERSION/.test(wf)) {
  fail('legacy-apt.yml no longer checks package.json against VERSION; '
     + 'the old APT could publish a version the panel does not report');
} else {
  notes.push('legacy-apt.yml checks both package.json files against VERSION');
}

// Manual only. On a push it would race release.yml; on a tag it would be a second release path.
const on = wf.slice(wf.indexOf('\non:'), wf.indexOf('\npermissions:'));
if (/\bpush:|tags:|pull_request/.test(on) || !/workflow_dispatch/.test(on)) {
  fail('legacy-apt.yml runs on something other than a manual dispatch; the old path must not '
     + 'publish by itself any more (HQ T-0012)');
} else {
  notes.push('legacy-apt.yml runs only by hand');
}

// The tag and the GitHub Release belong to release.yml. A tag set here makes auto-release treat the
// version as released, and the version never reaches DIST-Control.
if (/action-gh-release|git\s+tag\b|git\s+push\b[^\n]*refs\/tags|tag_name:/.test(wf)) {
  fail('legacy-apt.yml creates a tag or a GitHub Release; both belong to release.yml (auto-release), '
     + 'and a tag from here stops the version reaching DIST-Control');
} else {
  notes.push('legacy-apt.yml creates no tag and no Release');
}

// Pushing to ghcr is refused, temporarily, by a secondary rate limit — and it
// arrives as `denied: permission_denied` with HTTP 403, wording that reads as
// a credentials failure and is not one. It is earned by release frequency, so
// it will happen again the next time several fixes ship in a day. A release
// that had nothing wrong with it must not die on it.
const pushes = (wf.match(/uses: docker\/build-push-action/g) || []).length;
if (pushes < 2) {
  fail('the image push has no retry; a secondary rate limit from ghcr would '
     + 'fail a release for a reason that resolves itself in two minutes');
} else if (!/steps\.push\.outcome == 'failure'/.test(wf)) {
  fail('there are two push steps but the second is not conditional on the '
     + 'first failing — that pushes twice on every release');
} else {
  notes.push('the image push retries once after a rate limit');
}
// A refusal from ghcr wears one word for two causes: a secondary rate limit,
// which the retry clears, and a permission denial on one package, which it
// cannot. The retry costs two minutes either way, so the message beside it has
// to name both — otherwise the operator waits out a wait that will not help.
if (!/oauth token: denied/.test(wf)) {
  fail('the push-failure message does not mention the permission denial, so a '
     + 'denied package reads as a rate limit and the operator waits for nothing');
} else if (!/Manage Actions access/.test(wf)) {
  fail('the message names the failure and not where to fix it');
} else {
  notes.push('a refused push explains both of its causes');
}

if (!/max-parallel:\s*1/.test(wf)) {
  fail('the image matrix runs in parallel; two jobs pushing to ghcr at once is '
     + 'half of what earns the rate limit in the first place');
} else {
  notes.push('images are pushed one at a time');
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
