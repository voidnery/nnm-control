// What actually goes into Nimble's server playlist file — built and checked on the server, for every
// way a playlist reaches one (the editor, stop/start of a stream, rollback, later the API).
//
// Four faults reached the fleet through the old path (HQ T-0049, operator's files 2026-11-10):
//
//   1. A deploy by playlist id wrote the EDITOR MODEL as the file — `_id`, `_kind` and every unset
//      field as `null` ("Start": null, "Source_AWS": null, "DefaultStream": null …). The grammar has
//      no such values; the file is the editor's memory, not a playlist. buildFromModel() is the
//      clean build (a port of frontend/src/lib/playlistEngine.js — tests/playlist-nimble.test.mjs
//      keeps the two identical).
//   2. Blocks are immutable to Nimble: «If a block needs to be changed then a new ID must be applied
//      to it» (softvelum.com/nimble/playout). The editor kept a block's Id through every edit, so a
//      changed block was ignored by the server that already had it. prepareForNimble() compares
//      with the file on the server and gives a changed block a new Id.
//   3. A block without MaxIterations plays ONCE (the default is 1; 0 is endless). With
//      InactivityTimeout 0 the stream then stays on air, empty. Reported, not changed — once may
//      be what is meant.
//   4. «Only MP4 and MP3 containers are supported.» A .mov source was written without a word.
import crypto from 'node:crypto';

// ---- the clean build (mirror of playlistEngine.js cleanStream/cleanBlock/cleanTask) ----
const VOD_ONLY = new Set(['Start', 'MaxIterations', 'AudioStreamId', 'VideoStreamId', 'Subtitles']);

function cleanStream(s) {
  const o = {};
  o.Type = s.Type || 'vod';
  o.Source = s.Source || '';
  const aws = s.Source_AWS;
  if (aws && (aws.aws_access_key_id || aws.aws_secret_access_key)) {
    o.Source_AWS = {
      aws_access_key_id: aws.aws_access_key_id || '',
      aws_secret_access_key: aws.aws_secret_access_key || '',
      aws_signature_version: aws.aws_signature_version || 'v4',
    };
  }
  const isVod = o.Type === 'vod';
  for (const key of ['Start', 'Duration', 'TotalDuration', 'MaxIterations', 'AudioStreamId', 'VideoStreamId']) {
    const val = s[key];
    if (val === null || val === undefined) continue;
    if (!isVod && VOD_ONLY.has(key)) continue;
    o[key] = val;
  }
  for (const key of ['StreamTitle', 'StreamUrl']) if (s[key]) o[key] = s[key];
  const subs = s.Subtitles || [];
  if (isVod && subs.length) {
    o.Subtitles = subs.map(x => ({ Code: x.Code || '', Name: x.Name || '', Path: x.Path || '' }));
  }
  const marks = s.Scte35Markers || [];
  if (marks.length) {
    o.Scte35Markers = marks.map(mk => {
      const m = { Start: mk.Start || '', Type: mk.Type || 'Out' };
      if (mk.Type === 'Out' && mk.Duration !== null && mk.Duration !== undefined) m.Duration = mk.Duration;
      return m;
    });
  }
  return o;
}
function cleanBlock(b) {
  const o = {};
  o.Id = b.Id || '';
  if (b.Name) o.Name = b.Name;
  if (b.Start) o.Start = b.Start;
  for (const key of ['Duration', 'TotalDuration', 'MaxIterations']) if (b[key] !== null && b[key] !== undefined) o[key] = b[key];
  if (b.DefaultStream) o.DefaultStream = cleanStream(b.DefaultStream);
  o.Streams = (b.Streams || []).map(cleanStream);
  return o;
}
function cleanTask(t) {
  const o = {};
  o.Stream = t.Stream || '';
  if (t.InactivityTimeout !== null && t.InactivityTimeout !== undefined) o.InactivityTimeout = t.InactivityTimeout;
  o.Blocks = (t.Blocks || []).map(cleanBlock);
  return o;
}
export function buildFromModel(model) {
  const o = {};
  if (model?.SyncInterval !== null && model?.SyncInterval !== undefined) o.SyncInterval = model.SyncInterval;
  o.Tasks = (model?.Tasks || []).map(cleanTask);
  return o;
}

/** An editor model rather than a playlist: it carries the editor's own bookkeeping. */
export function isEditorModel(doc) {
  return Boolean(doc && typeof doc === 'object' && (doc._kind === 'root'
    || (Array.isArray(doc.Tasks) && doc.Tasks.some(t => t && (t._kind || t._id)))));
}

// ---- block identity ----
const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};
/** What a block plays — everything but its Id. Two blocks with the same key are the same block. */
export function blockKey(block) {
  const { Id: _ignored, ...rest } = block || {};
  return canonical(rest);
}
/** A new Id derived from the block's content: 8 hex digits, the shape Nimble's own files use. */
export function contentId(block, salt = '') {
  return crypto.createHash('sha256').update(`${salt}\n${blockKey(block)}`).digest('hex').slice(0, 8);
}

const blocksOf = (doc) => (Array.isArray(doc?.Tasks) ? doc.Tasks : [])
  .flatMap(t => (Array.isArray(t?.Blocks) ? t.Blocks : []).map(b => ({ task: t, block: b })));

// ---- containers ----
const PLAYABLE = /\.(mp4|m4v|m4a|mp3)$/i;
const vodSources = (b) => [...(Array.isArray(b?.Streams) ? b.Streams : []), b?.DefaultStream]
  .filter(s => s && (s.Type || 'vod') === 'vod' && typeof s.Source === 'string' && s.Source.trim())
  .map(s => s.Source);
/** A vod source Nimble cannot play: not an MP4 or MP3 container, judged by the file name. */
export function unplayable(source) {
  const path = String(source).split(/[?#]/)[0];
  return !PLAYABLE.test(path);
}

/**
 * Make a playlist document safe to hand to Nimble, given what the server holds now.
 *
 *   - a block whose Id the server already has with DIFFERENT content gets a new Id (changed blocks
 *     are otherwise ignored); so does a block with no Id or one repeated in this file;
 *   - a block unchanged since the server's copy keeps its Id — renaming it would restart it;
 *   - reported, not changed: blocks that play once, vod sources Nimble cannot play.
 *
 * Mutates nothing it was given; returns the document to write.
 */
export function prepareForNimble(doc, currentDoc = null) {
  const out = JSON.parse(JSON.stringify(doc));
  const onServer = new Map();
  for (const { block } of blocksOf(currentDoc)) if (block?.Id) onServer.set(String(block.Id), blockKey(block));

  const used = new Set();
  const renewed = [];
  const playsOnce = [];
  const unsupported = [];
  for (const { task, block } of blocksOf(out)) {
    const key = blockKey(block);
    const id = block.Id ? String(block.Id) : '';
    let why = '';
    if (!id) why = 'no Id';
    else if (used.has(id)) why = 'Id repeated in this file';
    else if (onServer.has(id) && onServer.get(id) !== key) why = 'changed since the server\'s copy';
    if (why) {
      let n = 0;
      let fresh = contentId(block, task?.Stream || '');
      while (used.has(fresh) || (onServer.has(fresh) && onServer.get(fresh) !== key)) {
        fresh = contentId(block, `${task?.Stream || ''}#${++n}`);
      }
      renewed.push({ stream: task?.Stream || '', from: id || null, to: fresh, why });
      block.Id = fresh;
    }
    used.add(String(block.Id));

    if (block.MaxIterations === undefined && block.TotalDuration === undefined) {
      playsOnce.push({ stream: task?.Stream || '', id: String(block.Id) });
    }
    for (const src of vodSources(block)) if (unplayable(src)) unsupported.push(src);
  }
  return { doc: out, renewed, playsOnce, unsupported: [...new Set(unsupported)] };
}
