// What the panel writes into Nimble's server playlist (HQ T-0049). The operator's two files are the
// fixtures: one Nimble runs (playlist-operator-working.json), one it did not
// (playlist-operator-broken.json). Rules from softvelum.com/nimble/playout.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildFromModel, isEditorModel, prepareForNimble, blockKey, contentId, unplayable,
} from '../src/services/playlistBuild.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => JSON.parse(readFileSync(path.join(HERE, 'fixtures', n), 'utf8'));
const E = await import(pathToFileURL(path.join(HERE, '..', '..', 'frontend', 'src', 'lib', 'playlistEngine.js')).href);
const agentProxy = readFileSync(path.join(HERE, '..', 'src', 'routes', 'agentProxy.js'), 'utf8');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

// An editor model as the page holds it: every field present, unset ones null.
const editorModel = () => {
  const m = E.makeModel();
  const t = E.makeTask('247/stream1');
  t.InactivityTimeout = 0;
  const b = E.makeBlock('ads');
  b.Streams.push(E.makeStream('vod', '/srv/nimble/media/gallery/reklama1.mp4'));
  const live = E.makeStream('live', 'live/feed');
  live.MaxIterations = 3;                  // vod-only — must not reach a live entry
  b.Streams.push(live);
  t.Blocks.push(b);
  m.Tasks.push(t);
  return m;
};
const walk = (v, f, p = '$') => {
  f(v, p);
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, f, `${p}[${i}]`));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, f, `${p}.${k}`);
};

console.log('\nTHE OPERATOR\'S FILES:');

check('the working file passes untouched: no new Ids, no warnings', () => {
  const doc = fixture('playlist-operator-working.json');
  const r = prepareForNimble(doc, doc);
  assert.deepEqual(r.renewed, []);
  assert.deepEqual(r.playsOnce, []);
  assert.deepEqual(r.unsupported, []);
  assert.deepEqual(r.doc, doc);
});

check('the broken file: its block plays once, and two sources are .mov', () => {
  const r = prepareForNimble(fixture('playlist-operator-broken.json'));
  assert.deepEqual(r.playsOnce, [{ stream: '247/stream1', id: '00ebdda7' }]);
  assert.deepEqual(r.unsupported.sort(),
    ['/srv/nimble/media/gallery/reklama2.mov', '/srv/nimble/media/gallery/reklama3.mov']);
});

check('the broken file, edited and redeployed over itself, gets a new block Id', () => {
  const before = fixture('playlist-operator-broken.json');
  const edited = fixture('playlist-operator-broken.json');
  edited.Tasks[0].Blocks[0].MaxIterations = 0;
  const r = prepareForNimble(edited, before);
  assert.equal(r.renewed.length, 1);
  assert.equal(r.renewed[0].from, '00ebdda7');
  assert.notEqual(r.doc.Tasks[0].Blocks[0].Id, '00ebdda7');
  assert.match(r.doc.Tasks[0].Blocks[0].Id, /^[0-9a-f]{8}$/);
  assert.equal(edited.Tasks[0].Blocks[0].Id, '00ebdda7', 'the input was mutated');
});

console.log('\nTHE FILE IS THE PLAYLIST, NOT THE EDITOR:');

check('a deploy by playlist id builds the file — it no longer writes the model', () => {
  assert.ok(!/JSON\.stringify\(playlist\.model/.test(agentProxy), 'the editor model is written as the file');
  assert.match(agentProxy, /JSON\.stringify\(buildFromModel\(playlist\.model\), null, 2\)/);
});

check('the build carries no editor bookkeeping and no nulls', () => {
  const doc = buildFromModel(editorModel());
  walk(doc, (v, p) => {
    assert.notEqual(v, null, `${p} is null`);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of Object.keys(v)) assert.ok(!k.startsWith('_'), `${p}.${k}`);
    }
  });
  assert.equal(doc.Tasks[0].Blocks[0].Streams[1].MaxIterations, undefined, 'a vod-only field on a live entry');
});

check('the server build is the editor\'s build, field for field', () => {
  const m = editorModel();
  const b = m.Tasks[0].Blocks[0];
  b.Start = '2026-11-10 10:00:00'; b.Duration = 60000; b.TotalDuration = 3600000;
  b.DefaultStream = E.makeStream('vod', '/srv/x/fallback.mp4');
  b.Streams[0].Subtitles = [{ Code: 'ru', Name: 'RU', Path: '/srv/x/a.srt' }];
  b.Streams[0].Scte35Markers = [{ Start: '1000', Type: 'Out', Duration: 30000 }];
  b.Streams[0].Source_AWS = { aws_access_key_id: 'k', aws_secret_access_key: 's', aws_signature_version: '' };
  m.SyncInterval = 5000;
  assert.deepEqual(buildFromModel(m), E.buildPlaylist(m));
});

check('an editor model posted as content is recognised and built', () => {
  assert.equal(isEditorModel(editorModel()), true);
  assert.equal(isEditorModel(fixture('playlist-operator-working.json')), false);
  assert.match(agentProxy, /if \(isEditorModel\(doc\)\) doc = buildFromModel\(doc\);/);
});

console.log('\nBLOCK IDENTITY (blocks are immutable to Nimble):');

const doc1 = () => ({ Tasks: [{ Stream: 'a/s', Blocks: [
  { Id: 'aaaaaaaa', MaxIterations: 0, Streams: [{ Type: 'vod', Source: '/m/1.mp4' }] },
  { Id: 'bbbbbbbb', MaxIterations: 0, Streams: [{ Type: 'vod', Source: '/m/2.mp4' }] },
] }] });

check('an unchanged block keeps its Id — renaming it would restart it', () => {
  const r = prepareForNimble(doc1(), doc1());
  assert.deepEqual(r.renewed, []);
});

check('only the changed block is renewed', () => {
  const next = doc1();
  next.Tasks[0].Blocks[1].Streams.push({ Type: 'vod', Source: '/m/3.mp4' });
  const r = prepareForNimble(next, doc1());
  assert.deepEqual(r.renewed.map(x => x.from), ['bbbbbbbb']);
  assert.equal(r.doc.Tasks[0].Blocks[0].Id, 'aaaaaaaa');
});

check('a block new to the server keeps the Id the editor gave it', () => {
  const next = doc1();
  next.Tasks[0].Blocks.push({ Id: 'cccccccc', MaxIterations: 0, Streams: [{ Type: 'vod', Source: '/m/4.mp4' }] });
  assert.deepEqual(prepareForNimble(next, doc1()).renewed, []);
});

check('a repeated or missing Id gets one of its own', () => {
  const next = doc1();
  next.Tasks[0].Blocks[1].Id = 'aaaaaaaa';
  next.Tasks[0].Blocks.push({ MaxIterations: 0, Streams: [{ Type: 'vod', Source: '/m/5.mp4' }] });
  const r = prepareForNimble(next, null);
  const ids = r.doc.Tasks[0].Blocks.map(b => b.Id);
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(r.renewed.map(x => x.why), ['Id repeated in this file', 'no Id']);
});

check('the new Id depends on content only, so the same edit gives the same Id', () => {
  const b = { Id: 'x', Streams: [{ Type: 'vod', Source: '/m/1.mp4' }] };
  assert.equal(contentId(b), contentId({ ...b, Id: 'y' }));
  assert.equal(blockKey({ Id: 'x', A: 1, B: 2 }), blockKey({ B: 2, Id: 'z', A: 1 }));
});

console.log('\nCONTAINERS:');

check('MP4 and MP3 play; MOV, MKV, TS do not', () => {
  for (const s of ['/m/a.mp4', '/m/A.MP4', '/m/a.m4v', '/m/a.mp3', 'https://cdn/x/a.mp4?sig=1']) assert.equal(unplayable(s), false, s);
  for (const s of ['/m/a.mov', '/m/a.mkv', '/m/a.ts', '/m/a', 'https://cdn/x/a.mov?x=.mp4']) assert.equal(unplayable(s), true, s);
});

check('the deploy refuses an unplayable source before writing, with the repackaging command', () => {
  const refuse = agentProxy.indexOf('prepared?.unsupported.length');
  const write = agentProxy.indexOf("runTask(req.srv, 'PUT /config', {\n    query: { name: filename }, body: { content }");
  assert.ok(refuse > 0 && write > refuse, 'no refusal, or it comes after the write');
  assert.match(agentProxy, /ffmpeg -i file\.mov -c copy/);
});

console.log('\nTHE EDITOR:');

check('a new block repeats endlessly (MaxIterations 0)', () => {
  assert.equal(E.makeBlock().MaxIterations, 0);
});

check('the editor warns about a block that plays once and a .mov source', () => {
  const m = editorModel();
  m.Tasks[0].Blocks[0].MaxIterations = null;
  m.Tasks[0].Blocks[0].Streams[0].Source = '/m/clip.mov';
  const keys = E.validate(m).map(n => n.k);
  assert.ok(keys.includes('pl.err.blockPlaysOnce'));
  assert.ok(keys.includes('pl.err.sourceContainer'));
  assert.deepEqual(E.validate(editorModel()).map(n => n.k), []);
});

console.log(failures ? `\n${failures} playlist check(s) failed` : '\nall playlist checks passed');
process.exit(failures ? 1 : 0);
