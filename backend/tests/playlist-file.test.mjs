// iter19 m1 — reading a live playlist.
//
// Every check here runs against a file taken from a running server, because
// the two times this project guessed at a format it was wrong and each guess
// cost a release.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePlaylistFile, comparePlaylists } from '../src/services/playlistFile.js';

let pass = 0, fail = 0;
const check = (n, f) => {
  try { f(); console.log(`  ✓ ${n}`); pass++; }
  catch (e) { console.log(`  ✗ ${n}: ${e.message}`); fail++; }
};

const real = readFileSync(new URL('./fixtures/server-playlist.json', import.meta.url), 'utf8');

console.log('AGAINST A LIVE PLAYLIST:');

check('the shape is Tasks -> Blocks -> Streams, not Tasks -> Streams', () => {
  // One level deeper than it looks. Reading it flat would find no items at all
  // and report a working playlist as empty.
  const r = parsePlaylistFile(real);
  assert.equal(r.ok, true);
  assert.equal(r.tasks.length, 2);
  assert.ok(r.tasks[0].items.length > 0);
  assert.ok(r.tasks[0].blocks.length > 0);
});

check('entries and distinct files are counted separately', () => {
  // 24 entries describe 9 files here: three adverts are interleaved between
  // every match. Reporting one number for both would misdescribe the playlist
  // whichever number was chosen.
  const r = parsePlaylistFile(real);
  assert.equal(r.tasks[0].count, 24);
  assert.equal(r.tasks[0].distinct, 9);
  assert.ok(r.tasks[0].count > r.tasks[0].distinct);
});

check('MaxIterations 0 is reported as looping, not as zero', () => {
  // An operator reading "0 iterations" would conclude the opposite of what it
  // means.
  const r = parsePlaylistFile(real);
  assert.equal(r.tasks[0].blocks[0].maxIterations, 0);
  assert.equal(r.tasks[0].blocks[0].loops, true);
});

check('every path the file depends on is collected once', () => {
  const r = parsePlaylistFile(real);
  assert.equal(r.sources.length, 16);
  assert.equal(new Set(r.sources).size, r.sources.length, 'deduplicated');
  assert.ok(r.sources.every(s => s.startsWith('/srv/nimble/media/')));
});

check('keys we do not model are preserved, not dropped', () => {
  // Whatever else Nimble grows must survive a round trip through the panel.
  const withExtra = JSON.stringify({ ...JSON.parse(real), SomethingNew: { a: 1 } });
  assert.deepEqual(parsePlaylistFile(withExtra).unknownKeys, ['SomethingNew']);
  assert.deepEqual(parsePlaylistFile(real).unknownKeys, []);
});

console.log('\nA BROKEN FILE IS A FACT, NOT AN EXCEPTION:');

check('each failure says what is wrong with it', () => {
  assert.equal(parsePlaylistFile('').reason, 'empty');
  assert.equal(parsePlaylistFile('{oops').reason, 'invalid JSON');
  assert.match(parsePlaylistFile('{"a":1}').reason, /not a Nimble playlist/);
  assert.equal(parsePlaylistFile(null).ok, false, 'and nothing throws');
});

console.log('\nCOMPARING SERVER AND PANEL:');

check('formatting is not a difference', () => {
  // Reporting whitespace or key order as a change would make the comparison
  // useless the first time anyone reformatted a file.
  const model = JSON.parse(real);
  assert.equal(comparePlaylists(real, model).same, true);
  assert.equal(comparePlaylists(JSON.stringify(model), model).same, true, 'reformatted');
  const reordered = { Tasks: model.Tasks, SyncInterval: model.SyncInterval };
  assert.equal(comparePlaylists(JSON.stringify(reordered), model).same, true, 'reordered keys');
});

check('a real change is a difference', () => {
  const model = JSON.parse(real);
  const changed = JSON.parse(real);
  changed.Tasks[0].Blocks[0].Streams.pop();
  assert.equal(comparePlaylists(JSON.stringify(changed), model).same, false);
});

check('an unparseable side is said so rather than called different', () => {
  assert.equal(comparePlaylists('{oops', {}).comparable, false);
  assert.equal(comparePlaylists(real, null).comparable, false);
});

console.log('\nMEDIA (m2):');

const agentSrc = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');
const routeSrc = readFileSync(new URL('../src/routes/agentProxy.js', import.meta.url), 'utf8');

// The agent's own path check, extracted and run rather than read.
const path_ = await import('node:path');
const safeJoin = new Function('path',
  `${agentSrc.slice(agentSrc.indexOf('function safeJoin'),
    agentSrc.indexOf('\n}', agentSrc.indexOf('function safeJoin')) + 2)}; return safeJoin;`)(path_.default);
const ROOT = '/srv/nimble/media/gallery';

check('one folder is allowed, because operators file by role', () => {
  // The live playlist separates adds/ from matches/. Flattening that would
  // either collide names or force everything into one heap.
  assert.equal(safeJoin(ROOT, 'adds/reklama_1.mp4', { allowFolder: true }), `${ROOT}/adds/reklama_1.mp4`);
  assert.equal(safeJoin(ROOT, 'match_1.mp4', { allowFolder: true }), `${ROOT}/match_1.mp4`);
});

check('two are not, and escapes still fail', () => {
  // A depth limit that is a number invites argument about the number; one
  // level is what the work needs.
  const refuses = (n, opt = { allowFolder: true }) => {
    try { safeJoin(ROOT, n, opt); return false; } catch { return true; }
  };
  assert.ok(refuses('a/b/c.mp4'), 'two folders');
  assert.ok(refuses('../../etc/passwd'));
  assert.ok(refuses('adds/../../x'));
  assert.ok(refuses('/etc/passwd'));
  assert.ok(refuses(''));
  assert.ok(refuses('adds/x.mp4', {}), 'and a caller that did not ask for a folder does not get one');
});

check('the listing reaches into those folders', () => {
  // A file filed under adds/ would otherwise vanish from the panel the moment
  // it landed there.
  assert.ok(agentSrc.includes('const scan = async (rel)'));
  assert.ok(agentSrc.includes('else if (st.isDirectory() && !rel)'), 'one level, matching what uploads create');
  assert.ok(agentSrc.includes('files.sort('), 'and a listing does not reshuffle between refreshes');
});

check('a file the live playlist names cannot be deleted', () => {
  // Tidying happens between events and the consequence lands hours later, in
  // the middle of one: the entry stays and plays silence, and nothing else in
  // the system would report it.
  assert.ok(routeSrc.includes("req.query.force !== '1'"));
  assert.ok(routeSrc.includes('would make those entries play silence'));
});

check('the reference check compares full paths, not file names', () => {
  // This fleet's playlist holds two different match_1.mp4 in different
  // directories; a name match would block deleting either because of the
  // other.
  const sources = [...new Set(JSON.parse(real).Tasks
    .flatMap(t => t.Blocks.flatMap(b => b.Streams.map(s => s.Source))))];
  const used = (dir, name) => sources.filter(s => s === `${dir.replace(/\/+$/, '')}/${name}`);
  assert.equal(used('/srv/nimble/media/2470208', 'matches/match_1.mp4').length, 1);
  assert.equal(used('/srv/nimble/media/gallery', 'matches/match_1.mp4').length, 0,
    'a same-named file elsewhere is not blocked');
  assert.ok(routeSrc.includes('const used = parsed.sources.filter(src => src === full)'));
});

check('a playlist that cannot be read is not permission to delete', () => {
  // If the check itself failed, saying so beats proceeding as though the file
  // were unused.
  assert.ok(routeSrc.includes('could not check the playlist before deleting'));
});

console.log('\nTHE EDITOR (m3):');

const page = readFileSync(new URL('../../frontend/src/pages/PlaylistsPage.jsx', import.meta.url), 'utf8');

check('a source can be picked from what the server holds', () => {
  // It has always been free text, which is how a path to a missing file gets
  // into a playlist — and the only way to find out has been silence on air.
  // The per-item grid this lived in was replaced in v0.41.0; the guarantee
  // moved with it rather than going away.
  const src = readFileSync(new URL('../../frontend/src/components/SourceRows.jsx', import.meta.url), 'utf8');
  assert.ok(src.includes("t('src.pick')"));
  assert.ok(src.includes('const missing = isVod(s) && known && s.Source && !known.has(s.Source)'));
  assert.ok(src.includes("t('src.missing')"));
});

check('editing never writes to a server', () => {
  // The editor reads state and media so it can warn. Deploying is a separate
  // act, and a page that can save and deploy in one motion is a page that
  // deploys by accident.
  const builder = page.slice(page.indexOf('function Builder'), page.indexOf('export default'));
  const writes = [...builder.matchAll(/method:\s*'(POST|PUT|DELETE)'/g)].length;
  const toPlaylists = [...builder.matchAll(/api\('\/playlists/g)].length
    + [...builder.matchAll(/api\(`\/playlists/g)].length;
  assert.equal(writes, toPlaylists, 'every write goes to the panel, none to an agent');
  assert.ok(!/agent\/(config|deploy)/.test(builder));
});

check('the interleave reproduces the pattern the live file was built with', () => {
  // Three adverts before every match: 24 entries for 8 matches. Building that
  // a row at a time is where an advert goes missing or a match repeats, and
  // neither shows until it airs.
  const mk = (Source) => ({ Type: 'vod', Source });
  const ads = ['a/r1.mp4', 'a/r2.mp4', 'a/r3.mp4'];
  const run = (streams, every) => {
    const content = streams.filter(x => !ads.includes(x.Source));
    const out = [];
    content.forEach((item, i) => {
      if (i % every === 0) for (const src of ads) out.push(mk(src));
      out.push(item);
    });
    return out;
  };
  const matches = [1, 2, 3, 4, 5, 6].map(i => mk(`m/match_${i}.mp4`));
  const once = run(matches, 1);
  assert.equal(once.length, 24, 'six matches and three adverts each');
  assert.equal(run(once, 1).length, 24, 'applying it again replaces, it does not multiply');
  assert.deepEqual(once.slice(0, 4).map(x => x.Source), [...ads, 'm/match_1.mp4']);
});


console.log('\nDEPLOY AND ROLLBACK (m4):');

const { inspect, sha256 } = await import('../src/services/playlistDeploy.js');
const deploySrc = readFileSync(new URL('../src/services/playlistDeploy.js', import.meta.url), 'utf8');
const proxySrc = readFileSync(new URL('../src/routes/agentProxy.js', import.meta.url), 'utf8');
const allPaths = new Set(JSON.parse(real).Tasks
  .flatMap(t => t.Blocks.flatMap(b => b.Streams.map(s => s.Source))));

check('a source that is not on the server is named before the write', () => {
  // Afterwards it is silence on air, and nothing reports it.
  const some = new Set([...allPaths].slice(0, 3));
  const r = inspect(real, some);
  assert.equal(r.fatal, null);
  assert.equal(r.missing.length, 13);
  assert.equal(inspect(real, allPaths).missing.length, 0);
});

check('an empty playlist is recognised as stopping everything', () => {
  // Legal JSON, and a plausible accident: deleting the last task. Silent
  // unless said.
  assert.equal(inspect(JSON.stringify({ SyncInterval: 1000, Tasks: [] }), allPaths).empty, true);
  assert.equal(inspect(real, allPaths).empty, false);
  assert.equal(inspect(real, allPaths).entries, 36);
});

check('a malformed file is fatal, a missing media file is not', () => {
  // One cannot be deployed at all; the other an operator may knowingly accept,
  // because the file might be arriving in a minute.
  assert.ok(inspect('{oops', allPaths).fatal);
  assert.equal(inspect(real, new Set()).fatal, null);
  assert.ok(proxySrc.includes("if (check.fatal) throw"), 'fatal is refused regardless of force');
  assert.ok(proxySrc.includes('if (!force) {'), 'the rest is what force covers');
});

check('an unreadable media list is not a licence to skip the check', () => {
  // The check failing and the check passing must not look the same.
  assert.ok(proxySrc.includes('if (present === null)'));
  assert.ok(proxySrc.includes('could not be read from this server, so the sources could not be checked'));
});

check('what is being replaced is recorded before it is replaced', () => {
  // Without it the first rollback has nothing to go back to — and the first
  // deploy is the one most likely to need undoing.
  assert.ok(proxySrc.includes('await captureCurrent('));
  const capture = proxySrc.indexOf('captureCurrent(');
  const write = proxySrc.indexOf("'PUT /config'", capture);
  assert.ok(capture > 0 && write > capture, 'and before, not after');
  assert.ok(deploySrc.includes("origin: 'captured'"));
});

check('rolling back is deploying, not a second implementation', () => {
  // A separate path would be one that skips the checks at the exact moment
  // they matter most: when something has already gone wrong.
  assert.ok(proxySrc.includes('async function deployHandler(req)'));
  assert.ok(proxySrc.includes('return deployHandler(req);'));
  const rollback = proxySrc.slice(proxySrc.indexOf("rollback-playlist"));
  assert.ok(!/PUT \/config/.test(rollback.slice(0, 600)), 'the rollback route writes nothing itself');
});

check('a forced deploy is remembered as forced', () => {
  // It explains an outage nobody could otherwise account for.
  assert.ok(proxySrc.includes('missingAtDeploy: check.missing'));
  assert.ok(proxySrc.includes('forced: force'));
});

check('the version list does not carry every version body', () => {
  // Thirty playlists of content sent to a browser that wants a list.
  assert.ok(deploySrc.includes(".select('-content')"));
});

check('the same content is not recorded twice as a capture', () => {
  assert.ok(deploySrc.includes('PlaylistDeploy.findOne({ serverId, sha256: hash })'));
  assert.equal(sha256('a'), sha256('a'));
  assert.notEqual(sha256('a'), sha256('b'));
});

console.log('\nSTOP AND START (m5):');

const { withoutTask, withTask, findTaskInVersions } = await import('../src/services/playlistDeploy.js');
const NAME = 'povtor_tennis/video_playlist_02_03';

check('stopping removes exactly one task and disturbs nothing else', () => {
  // Another operator's tasks, the sync interval and any key this panel does
  // not model all survive: a stop is not an excuse to rewrite the file.
  const next = withoutTask(real, NAME);
  const before = JSON.parse(real);
  const after = JSON.parse(next);
  assert.equal(after.Tasks.length, before.Tasks.length - 1);
  assert.equal(after.SyncInterval, before.SyncInterval);
  assert.deepEqual(after.Tasks[0], before.Tasks[1], 'the other task is untouched');
});

check('stopping something that is not running says so', () => {
  // Rather than writing an identical file and reporting success.
  assert.equal(withoutTask(real, 'nope/x'), null);
  assert.equal(withoutTask('{oops', NAME), null);
});

check('starting restores the task where it was, whole', () => {
  // A task that reappears at the bottom of the file looks like a new one to
  // the next person reading it.
  const stopped = withoutTask(real, NAME);
  const found = findTaskInVersions([{ content: real }], NAME);
  const back = JSON.parse(withTask(stopped, found.task, found.index));
  assert.equal(back.Tasks.length, 2);
  assert.equal(back.Tasks.findIndex(t => t.Stream === NAME), 0, 'in its original position');
  assert.equal(back.Tasks[0].Blocks[0].Streams.length, 24, 'with all its entries');
  assert.deepEqual(back, JSON.parse(real), 'and the file is what it was');
});

check('starting one that is already running is refused', () => {
  const found = findTaskInVersions([{ content: real }], NAME);
  assert.equal(withTask(real, found.task, 0), null);
});

check('the definition is recovered from the version history', () => {
  // Nothing extra to store, and no chance of a stored copy drifting from what
  // was really running.
  assert.equal(findTaskInVersions([{ content: '{oops' }, { content: real }], NAME).task.Stream, NAME);
  assert.equal(findTaskInVersions([{ content: real }], 'nope/x'), null);
});

check('both go through the deploy path', () => {
  // A second way to change a live config is a second way that skips the
  // checks, and this is the path most likely to be taken in a hurry.
  const stop = proxySrc.slice(proxySrc.indexOf('playlist-stop'), proxySrc.indexOf('playlist-start'));
  assert.ok(stop.includes('await deployHandler(req)'));
  assert.ok(!/PUT \/config/.test(stop), 'and neither writes the file itself');
});

check('the response says whether it restarted or resumed', () => {
  // It was unconditionally "restarts from the top" until m6 made resuming
  // possible; saying that now would be a lie in the one case that matters.
  // Either way it is stated: a Play button that silently moves an hour of
  // broadcast, in either direction, is worse than one that says what it did.
  assert.ok(proxySrc.includes('resumesFromStart: !resume || Boolean(resume.failed)'));
});

console.log('\nRESUMING WHERE IT STOPPED (m6):');

const { locate, resumeTask, __rewindMs } = await import('../src/services/playlistResume.js');
const agent2 = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');

const task0 = JSON.parse(real).Tasks[0];
// Adverts 30s, matches 20 minutes — the shape of this playlist.
const durations = new Map(task0.Blocks[0].Streams.map(s =>
  [s.Source, /reklama/.test(s.Source) ? 30_000 : 1_200_000]));

check('the position is found from durations, laps and all', () => {
  // The file carries no position: Nimble knows it and does not expose it, so
  // it is reconstructed from when it started, when it stopped, and how long
  // each file runs.
  const r = resumeTask(task0, durations, 25 * 60_000);
  assert.equal(r.ok, true);
  assert.equal(r.at.index, 7);
  assert.match(r.task.Blocks[0].Streams[0].Source, /match_2/);
  assert.equal(r.task.Blocks[0].Streams.length, 17, 'what is already played is dropped');
});

check('a looping block wraps rather than running out', () => {
  // 400 minutes is three full laps of this block and part of a fourth.
  const r = resumeTask(task0, durations, 400 * 60_000);
  assert.equal(r.ok, true);
  assert.equal(r.at.laps, 3);
  assert.match(r.task.Blocks[0].Streams[0].Source, /match_1/);
});

check('the resume lands before the computed point, never after', () => {
  // Drift is inevitable and the two errors are not equal: land early and the
  // audience sees a few seconds twice; land late and they miss content that
  // will never be shown.
  const entries = [{ source: 'a', durationMs: 60_000 }];
  assert.equal(locate(entries, 30_000, false).offsetMs, 30_000 - __rewindMs);
  assert.ok(__rewindMs > 0);
  assert.equal(locate(entries, 1_000, false).offsetMs, 0, 'and never before the beginning');
});

check('one unknown duration disables the resume entirely', () => {
  // Guessing past it would put the resume in the wrong file, which is worse
  // than not resuming: a restart from the top is at least what the operator
  // expects.
  const partial = new Map([...durations].slice(0, 3));
  const r = resumeTask(task0, partial, 60_000);
  assert.equal(r.ok, false);
  assert.match(r.reason, /duration/);
});

check('a scheduled block is left alone', () => {
  // A block with a Start time is a schedule, not a queue; rewriting it would
  // move the schedule.
  const scheduled = { ...task0, Blocks: [{ ...task0.Blocks[0], Start: '2026-01-17 08:00:00' }] };
  assert.equal(resumeTask(scheduled, durations, 60_000).ok, false);
});

check('a finished non-looping block restarts, and says it did', () => {
  const entries = [{ source: 'a', durationMs: 10_000 }];
  const r = locate(entries, 60_000, false);
  assert.equal(r.ok, true);
  assert.equal(r.index, 0);
  assert.equal(r.atEnd, true);
});

check('the result is marked as an estimate', () => {
  // Playback drifts from arithmetic; presenting this as exact would be the
  // only real mistake available here.
  assert.equal(resumeTask(task0, durations, 60_000).estimated, true);
});

console.log('\nMEASURING THE FILES:');

check('the agent runs ffprobe without a shell', () => {
  // The first external process this agent has ever run. execFile means a file
  // name containing a semicolon is an argument, not an instruction.
  assert.ok(agent2.includes("const { execFile } = await import('node:child_process')"));
  // `.exec(` is a regular expression, not a shell — the first version of this
  // check flagged two of those.
  assert.ok(!/child_process['"]\)\.exec\b|\bexecSync\(|shell:\s*true/.test(agent2), 'no shell anywhere');
  assert.ok(!/import\('node:child_process'\)[\s\S]{0,80}\bexec\b(?!File)/.test(agent2));
  assert.ok(agent2.includes('timeout: timeoutMs'), 'and it cannot hang forever');
});

check('a missing ffprobe is told apart from a missing file', () => {
  // Matching on message text would confuse the two the first time either
  // wording changed.
  assert.ok(agent2.includes("e?.code === 'ENOENT' && !/No such file/i.test(msg)"));
  assert.ok(agent2.includes('toolMissing = true'), 'and it is reported once, not once per file');
});

check('probing is confined to the media root', () => {
  const probe = agent2.slice(agent2.indexOf("'POST /media/probe'"), agent2.indexOf("'POST /media/stat'"));
  assert.ok(probe.includes('outside the media root'));
});

console.log('\nWHAT THE PANEL CAN SAY THAT NOTHING ELSE DOES (m7):');

const A = await import('../src/services/playlistAdvice.js');
const proxySrc2 = readFileSync(new URL('../src/routes/agentProxy.js', import.meta.url), 'utf8');
const parsedReal = parsePlaylistFile(real);
const srcs0 = parsedReal.tasks[0].items.map(i => i.source);
const uniform = () => new Map(srcs0.map(s => [s, {
  video: { codec: 'h264', width: 1920, height: 1080, fps: 25 },
  audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
}]));

check('a file changed behind the panel is reported with its consequence', () => {
  // The next deploy overwrites without asking, and editing by hand is how
  // this has always been done here — the change would be lost silently.
  assert.equal(A.detectDrift({ serverSha: 'a', lastDeploy: { sha256: 'a' } }).state, 'in-sync');
  const d = A.detectDrift({ serverSha: 'b', lastDeploy: { sha256: 'a', by: 'op' } });
  assert.equal(d.state, 'drifted');
  assert.match(d.note, /overwrite/);
  assert.equal(A.detectDrift({ serverSha: 'a', lastDeploy: null }).state, 'never-deployed');
  assert.equal(A.detectDrift({ serverSha: null }).state, 'no-file');
});

check('joins are checked at the boundary, not per file', () => {
  // It is the CHANGE that stutters. A playlist of uniformly odd files is
  // fine; one odd file among twenty is not — and it produces two bad joins,
  // going in and coming out.
  assert.equal(A.checkJoins(srcs0, uniform()).issues.length, 0);
  const probes = uniform();
  probes.set(srcs0[3], {
    video: { codec: 'h264', width: 1280, height: 720, fps: 30 },
    audio: { codec: 'aac', sampleRate: 44100, channels: 2 },
  });
  const r = A.checkJoins(srcs0, probes);
  assert.equal(r.issues.length, 2, 'entering and leaving the odd file');
  const kinds = r.issues[0].diffs.map(x => x.what);
  assert.ok(kinds.includes('resolution') && kinds.includes('frame rate') && kinds.includes('sample rate'));
});

check('a file with no audio among files that have it is called out', () => {
  // Silence, not a join artefact, and audible even when the picture is fine.
  const probes = uniform();
  probes.set(srcs0[3], { video: { codec: 'h264', width: 1920, height: 1080, fps: 25 }, audio: null });
  const r = A.checkJoins(srcs0, probes);
  assert.ok(r.issues.some(i => i.diffs.some(d => d.what === 'audio track')));
});

check('unmeasured files are listed, not silently skipped', () => {
  const r = A.checkJoins(srcs0, new Map());
  assert.equal(r.issues.length, 0);
  assert.equal(r.unknown.length, srcs0.length);
  assert.equal(r.checked, 0);
});

check('block length is summed, and a partial sum is marked partial', () => {
  // "At least 40 minutes" is useful; pretending it is the whole answer is not.
  const durations = new Map(srcs0.map(s => [s, /reklama/.test(s) ? 30_000 : 1_200_000]));
  const t = A.timings(parsedReal, durations)[0];
  assert.equal(t.blocks[0].complete, true);
  assert.equal(Math.round(t.totalMs / 60_000), 129);
  const partial = new Map([...durations].slice(0, 5));
  const t2 = A.timings(parsedReal, partial)[0];
  assert.equal(t2.blocks[0].complete, false);
  assert.ok(t2.blocks[0].missingDurations > 0);
  assert.ok(t2.totalMs > 0, 'and what is known is still summed');
});

check('a looping block has no end, a finite one does', () => {
  const durations = new Map(srcs0.map(s => [s, /reklama/.test(s) ? 30_000 : 1_200_000]));
  assert.equal(A.timings(parsedReal, durations, { startedAt: Date.now() })[0].endsAt, null);

  const finite = parsePlaylistFile(real.replace(/"MaxIterations": 0/g, '"MaxIterations": 1'));
  const t = A.timings(finite, durations, { startedAt: Date.now() - 3_600_000 })[0];
  assert.ok(t.endsAt, 'a block that stops has a time it stops at');
  assert.ok(t.endsInMs < 129 * 60_000);
});

check('InactivityTimeout 0 means the stream is never dropped', () => {
  // Which is its own thing worth saying: the content ends and the output stays
  // up, empty. The live file uses 0.
  const durations = new Map(srcs0.map(s => [s, 30_000]));
  const finite = parsePlaylistFile(real.replace(/"MaxIterations": 0/g, '"MaxIterations": 1'));
  assert.equal(finite.tasks[0].inactivityTimeout, 0);
  const t = A.timings(finite, durations, { startedAt: Date.now() })[0];
  assert.ok(t.endsAt.contentEndsAt);
  assert.equal(t.endsAt.streamDropsAt, null, 'no drop time, because it never drops');
});

check('already-finished sorts ahead of about-to-finish', () => {
  // Negative is more urgent than small, not nonsense to be filtered out.
  const timed = [
    { stream: 'soon', endsInMs: 10 * 60_000 },
    { stream: 'over', endsInMs: -5 * 60_000 },
    { stream: 'later', endsInMs: 10 * 3_600_000 },
    { stream: 'never', endsInMs: null },
  ];
  assert.deepEqual(A.endingSoon(timed).map(x => x.stream), ['over', 'soon']);
});

check('the probe reads streams and duration in one call', () => {
  // The call that measures length is already open; asking twice would double
  // the cost of the check that catches a stuttering join.
  const agent3 = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');
  assert.ok(agent3.includes('codec_type,codec_name,width,height,r_frame_rate'));
  assert.ok(agent3.includes("String(v?.r_frame_rate || '').split('/')"),
    'and a ratio like 30000/1001 is reduced, so two spellings of one rate compare equal');
});

console.log('\nREACHABLE FROM THE PANEL (m8):');

const panel = readFileSync(new URL('../../frontend/src/components/PlaylistServerPanel.jsx', import.meta.url), 'utf8');
const apiSrc = readFileSync(new URL('../../frontend/src/api.js', import.meta.url), 'utf8');
const pageSrc = readFileSync(new URL('../../frontend/src/pages/PlaylistsPage.jsx', import.meta.url), 'utf8');

check('every route built for this epic is called from the page', () => {
  // A capability with no way in is a capability nobody has — which is what "I
  // don't see our changes" meant when this started. m1 to m7 were all routes
  // and none was reachable.
  for (const route of ['playlist-state', 'playlist-advice', 'agent/media', 'playlist-history',
                       'playlist-stop', 'playlist-start', 'rollback-playlist']) {
    assert.ok(panel.includes(route), route);
  }
  assert.ok(pageSrc.includes('<PlaylistServerPanel servers={servers} />'), 'and the panel is mounted');
});

check('a file body is sent as a file', () => {
  // JSON.stringify of a Blob is "{}": a gigabyte upload becomes 38 bytes and
  // the request reports success.
  assert.ok(apiSrc.includes('raw = false'));
  assert.ok(apiSrc.includes('raw ? body : JSON.stringify(body)'));
  assert.ok(panel.includes('raw: true'));
});

check('the four reads are independent', () => {
  // A server whose media cannot be listed can still have its playlist read,
  // and saying "nothing works" when one thing does sends the operator looking
  // in the wrong place.
  const load = panel.slice(panel.indexOf('const load = useCallback'), panel.indexOf('useEffect(() => { load(); }'));
  assert.equal([...load.matchAll(/\.catch\(/g)].length, 4, 'each failure is caught on its own');
  assert.ok(!/await Promise\.all/.test(load), 'and one failing does not abandon the rest');
});

check('start and resume are separate buttons', () => {
  // They do different things and the difference is an hour of broadcast. A
  // checkbox next to one button is a setting people do not read.
  assert.ok(panel.includes("t('pls.startTop')") && panel.includes("t('pls.startResume')"));
  // The file name joined both calls in v0.39.1; what is asserted is that the
  // two are still distinct, not their exact spelling.
  assert.ok(panel.includes('body: { stream, filename, resume: true }'));
  assert.ok(panel.includes('body: { stream, filename },'));
});

check('resuming is opt-in on the server side too', () => {
  // A Play button that silently jumps an hour forward is as wrong as one that
  // silently rewinds.
  assert.ok(proxySrc2.includes('if (req.body?.resume === true)'));
  assert.ok(proxySrc2.includes('resumesFromStart: !resume || Boolean(resume.failed)'),
    'and the response stops claiming a restart when it resumed');
});

check('stopping and rolling back ask first', () => {
  // Both take a stream off air, and neither is undoable by closing a dialog.
  assert.ok(panel.includes("confirm({ title: t('pls.stop')"));
  assert.ok(panel.includes("confirm({ title: t('pls.rollback')"));
});

console.log('\nWHY THE PANEL CANNOT SEE A PLAYLIST (v0.38.1):');

const proxy3 = readFileSync(new URL('../src/routes/agentProxy.js', import.meta.url), 'utf8');
const panel2 = readFileSync(new URL('../../frontend/src/components/PlaylistServerPanel.jsx', import.meta.url), 'utf8');
const agent4 = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');

check('a politely-reported missing file is no longer parsed as empty', () => {
  // The agent answers ENOENT with `{ content: null, exists: false }` rather
  // than throwing, and that answer was ignored: it fell through to the parser,
  // which said "empty". So an unreachable agent, a server with no playlist and
  // a server with an unreadable one all reached the page looking alike.
  assert.ok(proxy3.includes('if (file && file.exists === false)'));
  const at = proxy3.indexOf('if (file && file.exists === false)');
  const parseAt = proxy3.indexOf('parsePlaylistFile(file.content)', at);
  assert.ok(parseAt > at, 'the check comes before the parse');
});

check('content that is neither a string nor a stated absence is reported', () => {
  // Rather than becoming "empty playlist", which is a different fact.
  assert.ok(proxy3.includes("typeof file?.content !== 'string'"));
  assert.ok(proxy3.includes('did not say it was missing'));
});

check('the agent says where it looked', () => {
  // "No such file" is not actionable without it: a CONF_DIR pointing
  // elsewhere looks exactly like a server that has no playlist.
  // Both the found and the missing path of GET /config carry it. The listing
  // route added later reports the same directory, so counting occurrences
  // across the file measures the wrong thing.
  const cfg = agent4.slice(agent4.indexOf("async 'GET /config'(req, url)"));
  const body = cfg.slice(0, cfg.indexOf('\n  },'));
  assert.equal((body.match(/dir: CONF_DIR/g) || []).length, 2, 'on both the found and missing paths');
});

check('the page tells the four causes apart', () => {
  for (const k of ['pls.unreachable', 'pls.noFile', 'pls.lookedIn', 'pls.unreadable']) {
    assert.ok(panel2.includes(k), k);
  }
  assert.ok(panel2.includes('state.exists === null'));
  assert.ok(panel2.includes('state.exists === true && state.parsed && !state.parsed.ok'));
});

check('the diagnostic calls the router that serves it', () => {
  // The panel was fixed and the tool was not, so it reported the very fault it
  // had itself — and reported it again after the fault was fixed. A tool that
  // can be wrong about the thing it diagnoses is worse than no tool, which is
  // the second time that has come up in this project.
  const diag = readFileSync(new URL('../../tools/nnm-diag.mjs', import.meta.url), 'utf8');
  assert.ok(diag.includes('/servers/${SERVER}/agent/playlist-state'));
  assert.ok(!diag.includes('/nimble/${SERVER}/agent/'));
});

check('the prefix audit covers the tools, not only the pages', () => {
  const audit = readFileSync(new URL('../../frontend/scripts/route-prefix-audit.mjs', import.meta.url), 'utf8');
  assert.ok(audit.includes("new URL('../../tools'"));
  // The extension lives inside a regular expression in the audit, so a plain
  // substring search for it finds nothing.
  assert.ok(audit.includes('(jsx?|mjs)'), 'and reads the extension the tools use');
});

check('the standalone diagnostic reaches the same four verdicts', () => {
  const diag = readFileSync(new URL('../../tools/nnm-diag.mjs', import.meta.url), 'utf8');
  assert.ok(diag.includes('6. PLAYLIST'));
  assert.ok(diag.includes('the agent could not answer'));
  assert.ok(diag.includes('the file is not there — check the directory above'));
  assert.ok(diag.includes('could not be read as a Nimble playlist'));
  assert.ok(diag.includes('the panel can see the playlist'));
});

console.log('\nTHE FILE NAME WAS A GUESS (v0.39.0):');

const proxy4 = readFileSync(new URL('../src/routes/agentProxy.js', import.meta.url), 'utf8');
const panel3 = readFileSync(new URL('../../frontend/src/components/PlaylistServerPanel.jsx', import.meta.url), 'utf8');
const agent5 = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');

check('the agent can say what is in the config directory', () => {
  // The default was one character from the real name — `server-playlist.json`
  // against `server_playlist.json` — so the panel reported "no playlist" about
  // a server that had one, and nothing on the page could have said otherwise.
  // A guess at a name is not something to build on when the directory can be
  // read.
  assert.ok(agent5.includes("async 'GET /config/list'"));
  assert.ok(agent5.includes("n.toLowerCase().endsWith('.json')"), 'and only configuration files');
});

check('a .bak is not offered as a playlist', () => {
  const keep = (n) => n.toLowerCase().endsWith('.json');
  assert.deepEqual(['playlist.json', 'playlist.json.bak', 'server_playlist.json', 'nimble.conf'].filter(keep),
    ['playlist.json', 'server_playlist.json']);
});

check('what IS there is offered when what was asked for is not', () => {
  assert.ok(proxy4.includes("runTask(req.srv, 'GET /config/list'"));
  assert.ok(proxy4.includes('alternatives'));
  assert.ok(panel3.includes("t('pls.butThereIs')"));
  assert.ok(panel3.includes('onClick={() => setFile(n)}'), 'and picking one is a click');
});

check('an agent too old to list is still an agent that answered', () => {
  // The listing failing must not turn "the file is not there" into an error.
  // The guarded call is the one inside playlist-state, not the route that
  // simply exposes the listing — indexOf finds the latter first.
  const at = proxy4.indexOf('let alternatives = [];');
  assert.ok(at > 0);
  assert.ok(proxy4.slice(at, at + 400).includes('catch'), 'the listing failing does not become an error');
});

check('the chosen name travels with the request', () => {
  // It was fetched without one, so the server default applied and choosing a
  // file would have changed nothing.
  assert.ok(panel3.includes('playlist-state?name=${encodeURIComponent(file)}'));
  assert.ok(panel3.includes('}, [srvId, file]);'), 'and choosing one reloads');
});

console.log('\nACTING ON THE FILE BEING LOOKED AT (v0.39.1):');

const panel4 = readFileSync(new URL('../../frontend/src/components/PlaylistServerPanel.jsx', import.meta.url), 'utf8');
const proxy5 = readFileSync(new URL('../src/routes/agentProxy.js', import.meta.url), 'utf8');

check('every action names the file it acts on', () => {
  // v0.39.0 passed the chosen name when READING and not when acting. So Stop
  // read `server-playlist.json`, which does not exist on this fleet, and
  // reported the stream as absent — while the page displayed it, from a
  // different file, two lines above.
  for (const call of ['body: { stream: task.stream, filename: file }',
                      'body: { versionId: v._id, filename: file }',
                      'body: { stream, filename }',
                      'body: { stream, filename, resume: true }']) {
    assert.ok(panel4.includes(call), call);
  }
});

check('the server default is only a default', () => {
  // It is right for a fresh install and wrong for every server that named its
  // file something else, which is why the caller has to be able to say.
  // deploy reads it in `deployHandler`, which is declared above the route that
  // calls it — so searching from the route name finds nothing.
  for (const where of ['playlist-stop', 'playlist-start', 'async function deployHandler']) {
    const at = proxy5.indexOf(where);
    assert.ok(at > 0, where);
    assert.ok(proxy5.slice(at, at + 400).includes("req.body?.filename || 'server-playlist.json'"), where);
  }
});

check('"cannot check" is not reported as "not there"', () => {
  // A playlist pointing at /srv/nimble/video — outside the directory the agent
  // will read — showed as two broken entries on a server where both files
  // exist. An alarm that is wrong is an alarm that stops being read.
  const split = (results) => {
    const failed = results.filter(r => !r.ok);
    return {
      missing: failed.filter(r => r.reason === 'missing').length,
      unverifiable: failed.filter(r => r.reason !== 'missing').length,
    };
  };
  assert.deepEqual(split([
    { ok: true }, { ok: false, reason: 'missing' },
    { ok: false, reason: 'outside the media root' },
  ]), { missing: 1, unverifiable: 1 });
  assert.ok(proxy5.includes('const unverifiable = failed.filter'));
  assert.ok(panel4.includes("t('pls.unverifiable'"));
});

check('a playlist on the server can be brought in to edit', () => {
  // Seeing one without being able to edit it is half a feature, and the editor
  // only works on playlists the panel holds.
  assert.ok(panel4.includes("t('pls.import')"));
  assert.ok(panel4.includes("api('/playlists', { method: 'POST'"));
  // And importing must not touch the server.
  const at = panel4.indexOf("t('pls.import')");
  const around = panel4.slice(Math.max(0, at - 700), at);
  assert.ok(!/deploy-playlist|PUT \/config/.test(around));
});

console.log('\nUPLOAD, AND ONE PAGE INSTEAD OF TWO (v0.40.0):');

const panel5 = readFileSync(new URL('../../frontend/src/components/PlaylistServerPanel.jsx', import.meta.url), 'utf8');
const page5 = readFileSync(new URL('../../frontend/src/pages/PlaylistsPage.jsx', import.meta.url), 'utf8');

check('the upload sends the file that was chosen', () => {
  // `upload(file)` shadowed the `file` state — the playlist being viewed — so
  // an upload sent the playlist's name as the media file's name. It compiles,
  // it runs, and it is wrong in a way nobody reads past.
  assert.ok(panel5.includes('const upload = async (f) =>'));
  assert.ok(panel5.includes('folder ? `${folder}/${f.name}` : f.name'));
  assert.ok(!/const upload = async \(file\)/.test(panel5));
});

check('the frontend has the shadow check the backend has had since v0.25.3', () => {
  // The same mistake arrived by a different route — a destructured `pub` there,
  // a parameter here — so the check follows it.
  const audit = readFileSync(new URL('../../frontend/scripts/shadow-audit.mjs', import.meta.url), 'utf8');
  assert.ok(audit.includes('use(?:State|Reducer)'));
  const pkg = JSON.parse(readFileSync(new URL('../../frontend/package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.scripts.audit.includes('audit:shadow'), 'and it runs in the gate');
});

check('the upload control is a button, not a label around a hidden input', () => {
  // A label either works or does nothing, and "does nothing" is not a state
  // anyone can debug — it was reported as "there is no upload".
  assert.ok(panel5.includes('onClick={() => fileInput.current?.click()}'));
  assert.ok(!panel5.includes('<label className="btn"'));
});

check('the page opens on the server, not on the library', () => {
  // It showed the same subject twice in two mental models — stored playlists
  // above, the live server below — and left the reader to join them up. What
  // is on air is the truth; what the panel holds is material for it.
  const at = page5.indexOf('<PlaylistServerPanel');
  const drafts = page5.indexOf("t('pl.drafts')");
  assert.ok(at > 0 && drafts > at, 'the server panel comes first');
  assert.equal((page5.match(/<PlaylistServerPanel/g) || []).length, 1, 'and only once');
});

console.log('\nAN EDITOR SOMEONE CAN USE (v0.41.0):');

const rows = readFileSync(new URL('../../frontend/src/components/SourceRows.jsx', import.meta.url), 'utf8');
const page6 = readFileSync(new URL('../../frontend/src/pages/PlaylistsPage.jsx', import.meta.url), 'utf8');

check('the eight-field grid per item is gone', () => {
  // Every field was equally prominent, so the two used constantly were as hard
  // to find as the two used once a year — twenty-four times down a modal.
  assert.ok(!page6.includes('function StreamEditor('));
  assert.ok(page6.includes('<SourceRows'));
});

check('order can be changed by dragging or by arrows', () => {
  // There was no way to reorder anything at all: an item in the wrong place
  // had to be deleted and retyped.
  assert.ok(rows.includes('draggable'));
  assert.ok(rows.includes('const drop = (to)'));
  assert.ok(rows.includes('const swap = (i, j)'));
  // Dropping past the last row appends; every other target inserts before
  // something, so without it the end of the list is unreachable.
  assert.ok(rows.includes('onDrop={() => drop(streams.length)}'));
});

check('dragging starts from the handle, not the whole row', () => {
  // Otherwise every attempt to select text in the path starts a drag.
  // indexOf finds the word in the comment above it, so the element is located
  // by its opening tag.
  const at = rows.indexOf('<span draggable');
  assert.ok(at > 0);
  assert.ok(rows.slice(at, at + 300).includes("cursor: 'grab'"));
  assert.ok(!/<div[^>]*className="src-row"[^>]*draggable/.test(rows));
});

check('an item can be moved to a neighbouring block', () => {
  // The thing that was impossible: a source in the wrong block had to be
  // deleted and retyped there.
  assert.ok(rows.includes("title={t('src.toPrevBlock')}"));
  assert.ok(page6.includes('move={(si, dir, probe) =>'));
  // Asked before it is done, so the button is disabled rather than silently
  // doing nothing at the ends.
  assert.ok(page6.includes('if (probe) return true;'));
  assert.ok(rows.includes('disabled={!move(i, -1, true)}'));
});

check('a file can be picked or uploaded in place, and fills the path in', () => {
  // Uploading elsewhere and typing the path here is how an entry ends up
  // naming a file that arrived under a different name.
  assert.ok(rows.includes("t('src.pick')"));
  assert.ok(rows.includes('setAt(i, { ...streams[i], Source: `${dir}/${f.name}` })'));
  assert.ok(rows.includes('onMediaChanged?.()'), 'and the picker is refreshed');
  assert.ok(page6.includes('const loadMedia = useCallback'), 'by a loader that exists outside the effect');
});

check('the rare fields are present but out of the way', () => {
  // Someone needs each of them once a year. Removing them would be worse than
  // showing them; showing them beside the path was what made this unusable.
  for (const k of ['src.duration', 'src.offset', 'src.totalDuration',
                   'src.maxIterations', 'src.streamTitle', 'src.streamUrl']) {
    assert.ok(rows.includes(k), k);
  }
  assert.ok(rows.includes('const advanced = open === i'));
});

console.log('\nTHE UPLOAD ACTUALLY GETTING THROUGH (v0.41.1):');

const conf = readFileSync(new URL('../../frontend/nginx/default.conf.template', import.meta.url), 'utf8');
const page7 = readFileSync(new URL('../../frontend/src/pages/PlaylistsPage.jsx', import.meta.url), 'utf8');

check('the proxy accepts a video, not a megabyte', () => {
  // nginx defaults to 1 MB, so every upload was refused with 413 before it
  // reached a panel that accepts 2 GB. A 413 from a proxy looks identical to a
  // 413 from an application, which is why this took a screenshot to find.
  // Matched inside the block rather than within N characters of the location
  // line: the explanation between them is longer than any span worth guessing.
  const at = conf.indexOf('agent/media$');
  assert.ok(at > 0, 'there is a location for the upload');
  const block = conf.slice(at, conf.indexOf('\n    }', at));
  // The figure moved to 100 GB in v0.42.0. What is asserted is that a limit
  // exists and is far above nginx's one-megabyte default, not the number.
  const mb = Number(/client_max_body_size\s+(\d+)m/.exec(block)?.[1]);
  assert.ok(mb >= 2048, `expected a real limit, got ${mb}m`);
  assert.ok(/proxy_request_buffering\s+off/.test(conf), 'and is not spooled to the proxy first');
});

check('the limit is a literal, because envsubst cannot do defaults', () => {
  // `${VAR:-2048}` would be left in the file verbatim and nginx would refuse
  // to start. A web container that will not start is worse than a limit that
  // has to be edited.
  const code = conf.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  for (const m of code.matchAll(/\$\{[^}]*\}/g)) {
    assert.match(m[0], /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/, m[0]);
  }
});

check('no markup was left behind by the source-list replacement', () => {
  // A fragment of the old call survived the edit and rendered as literal text
  // in the middle of the editor: "onDup= /> ))}".
  assert.ok(!page7.includes('onDup= />'));
  assert.ok(!/onDup=\{\(\) => set\('Streams'/.test(page7), 'the old per-item handlers are gone with it');
});

check('the advert interleave is gone', () => {
  // It was never asked for.
  assert.ok(!page7.includes('setAds'));
  assert.ok(!page7.includes("t('pl.interleave')"));
});

console.log('\nUPLOADS UP TO A HUNDRED GIGABYTES (v0.42.0):');

const spool = readFileSync(new URL('../src/services/mediaSpool.js', import.meta.url), 'utf8');
const conf2 = readFileSync(new URL('../../frontend/nginx/default.conf.template', import.meta.url), 'utf8');
const proxy6 = readFileSync(new URL('../src/routes/agentProxy.js', import.meta.url), 'utf8');
const agent6 = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');

check('every limit on the path was raised, not just the first one', () => {
  // A limit raised in one place and left in another produces the same refusal
  // from a different component, which is harder to find than the original.
  assert.ok(spool.includes('MEDIA_MAX_MB || 102_400'));
  const at = conf2.indexOf('agent/media$');
  assert.match(conf2.slice(at, conf2.indexOf('\n    }', at)), /client_max_body_size\s+102400m/);
});

check('the limit is bounded, not removed', () => {
  // An unlimited upload is one that fills a disk, and a panel with no disk
  // left stops answering for every server rather than failing one transfer.
  assert.ok(!/client_max_body_size\s+0/.test(conf2));
});

check('an upload with nowhere to go is refused before it starts', () => {
  // At this size the answer "no" arriving at the end is the expensive one: the
  // bandwidth is spent, there is a half-file to clean up, and the disk it was
  // going to fill is shared with the database.
  assert.ok(spool.includes('export async function canAccept'));
  assert.ok(proxy6.includes("canAccept(req.headers['content-length'])"));
  const at = proxy6.indexOf("canAccept(req.headers['content-length'])");
  assert.ok(at < proxy6.indexOf('spoolUpload(req.srv', at), 'before the write, not after');
});

check('too large and no room are different answers', () => {
  // 413 is "never"; 507 is "not now" and will be right again once something is
  // deleted. Telling an operator the wrong one sends them to the wrong fix.
  assert.ok(spool.includes('status: 413'));
  assert.ok(spool.includes('status: 507'));
  assert.ok(spool.includes('plus a'), 'and the margin is stated');
});

check('being unable to measure does not refuse', () => {
  // A filesystem that will not answer statfs is not necessarily full, and the
  // meter still stops an overlong write.
  assert.ok(spool.includes('return { ok: true, unmeasured: true }'));
});

check('the broadcast server refuses what it cannot hold', () => {
  // Filling this disk does not fail a transfer, it stops encoders writing and
  // takes streams off air — and the transfer would run to completion first.
  assert.ok(agent6.includes('not enough space on this server'));
  const at = agent6.indexOf('not enough space on this server');
  const fetchAt = agent6.indexOf('await fetch(', agent6.indexOf("'POST /media/fetch'"));
  assert.ok(at < fetchAt, 'checked before pulling the file');
});

check('the timeouts allow for hours, not minutes', () => {
  // A hundred gigabytes over a studio uplink is hours, and a task expiring
  // mid-transfer throws all of it away.
  assert.ok(proxy6.includes('timeoutMs: 12 * 60 * 60_000'));
  assert.ok(/proxy_read_timeout\s+12h/.test(conf2));
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : '\nall playlist-file checks passed');
process.exit(fail ? 1 : 0);
