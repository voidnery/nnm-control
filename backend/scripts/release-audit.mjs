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

// The tag-vs-package.json gate itself must still be there, for the tag path.
if (!/does not match .*package\.json/.test(wf)) {
  fail('the tag/package.json agreement check is gone from the workflow; '
     + 'a release can be labelled with any version again');
} else {
  notes.push('tag/package.json agreement is still enforced for tag pushes');
}

// Releasing must not depend on a person typing a tag. Three consecutive
// releases died on exactly that, and the third one died on the tag pushed to
// fix the second. A push to main with a new version has to be enough.
const on = wf.slice(wf.indexOf('\non:'), wf.indexOf('\npermissions:'));
if (!/branches:\s*\[?'?main/.test(on)) {
  fail('the workflow no longer triggers on a push to main; releasing is back '
     + 'to depending on a hand-typed tag matching package.json');
} else {
  notes.push('a version bump pushed to main is itself a release');
}
if (!/ls-remote[^\n]*refs\/tags\/v\$pkgver/.test(wf)) {
  fail('there is no guard against re-releasing a version already tagged; '
     + 'every unrelated commit to main would try to republish it');
} else {
  notes.push('an already-released version is skipped, not republished');
}
if (!/tag_name:\s*v\$\{\{\s*needs\.meta\.outputs\.version/.test(wf)) {
  fail('the Release does not derive its tag from the resolved version; '
     + 'the tag and the artifact can disagree again');
} else {
  notes.push('the release tag is derived from package.json, not typed');
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
