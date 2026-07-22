// Ported from playlist_engine.py — Nimble Streamer Playout (server playlist)
// model + JSON build/parse/validate. Grammar: softvelum.com/nimble/playout/
// Model: root { SyncInterval, Tasks[] } -> Task { Stream, InactivityTimeout,
// Blocks[] } -> Block { Id, Name, Start, Duration, TotalDuration,
// MaxIterations, DefaultStream, Streams[] } -> Stream { Type, Source, ... }.

let _uid = 0;
export const newUid = () => `u${++_uid}`;
export const newBlockId = () =>
  Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');

// ---- time helpers ----
const DT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
export function validDatetime(s) {
  if (!s || !DT_RE.test(s.trim())) return false;
  const [d, t] = s.trim().split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  const [hh, mm, ss] = t.split(':').map(Number);
  return mo >= 1 && mo <= 12 && da >= 1 && da <= 31 && hh < 24 && mm < 60 && ss < 60;
}
export function secToMs(text) {
  if (text === null || text === undefined) return null;
  text = String(text).trim();
  if (text === '') return null;
  let total;
  if (text.includes(':')) {
    let parts = text.split(':');
    if (parts.length > 3) throw new Error("too many ':' groups");
    parts = parts.map(Number);
    while (parts.length < 3) parts.unshift(0);
    const [h, m, s] = parts;
    if ([h, m, s].some(n => Number.isNaN(n))) throw new Error('bad time');
    total = h * 3600 + m * 60 + s;
  } else {
    total = Number(text);
    if (Number.isNaN(total)) throw new Error('bad number');
  }
  if (total < 0) throw new Error('negative time');
  return Math.round(total * 1000);
}
export function msToSec(ms) {
  if (ms === null || ms === undefined) return '';
  const v = ms / 1000.0;
  return Number.isInteger(v) ? String(v) : String(v).replace(/0+$/, '').replace(/\.$/, '');
}
export function parseIntOrNull(text) {
  if (text === null || text === undefined) return null;
  text = String(text).trim();
  if (text === '') return null;
  const n = parseInt(text, 10);
  if (Number.isNaN(n)) throw new Error('bad integer');
  return n;
}

// ---- model constructors ----
export function makeStream(type = 'vod', source = '') {
  return {
    _id: newUid(), _kind: 'stream', Type: type, Source: source,
    Start: null, Duration: null, TotalDuration: null, MaxIterations: null,
    AudioStreamId: null, VideoStreamId: null, StreamTitle: null, StreamUrl: null,
    Subtitles: [], Scte35Markers: [], Source_AWS: null,
  };
}
export function makeBlock(name = '') {
  return {
    _id: newUid(), _kind: 'block', Id: newBlockId(), Name: name, Start: null,
    Duration: null, TotalDuration: null, MaxIterations: null, DefaultStream: null, Streams: [],
  };
}
export function makeTask(stream = 'live/playlist') {
  return { _id: newUid(), _kind: 'task', Stream: stream, InactivityTimeout: null, Blocks: [] };
}
export function makeModel() { return { _kind: 'root', SyncInterval: null, Tasks: [] }; }

// ---- clean JSON build (skip empty/default fields) ----
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
export function buildPlaylist(model) {
  const o = {};
  if (model.SyncInterval !== null && model.SyncInterval !== undefined) o.SyncInterval = model.SyncInterval;
  o.Tasks = (model.Tasks || []).map(cleanTask);
  return o;
}
export function buildJson(model, indent = 2) {
  return JSON.stringify(buildPlaylist(model), null, indent);
}

// ---- validation (human-readable notes; keyed for i18n at call site) ----
export function validate(model) {
  const errs = [];
  const tasks = model.Tasks || [];
  if (!tasks.length) errs.push({ k: 'pl.err.noTasks' });
  tasks.forEach((t, ti0) => {
    const ti = ti0 + 1;
    const tname = t.Stream || '(unnamed)';
    if (!(t.Stream || '').trim()) errs.push({ k: 'pl.err.taskNoStream', v: { i: ti } });
    else if (!t.Stream.includes('/')) errs.push({ k: 'pl.err.taskStreamFormat', v: { name: tname } });
    const blocks = t.Blocks || [];
    if (!blocks.length) errs.push({ k: 'pl.err.taskNoBlocks', v: { name: tname } });
    const seen = {};
    blocks.forEach((b, bi0) => {
      const bi = bi0 + 1;
      const bid = (b.Id || '').trim();
      const bname = b.Name || bid;
      if (!bid) errs.push({ k: 'pl.err.blockNoId', v: { name: tname, i: bi } });
      else if (seen[bid]) errs.push({ k: 'pl.err.blockDupId', v: { name: tname, id: bid } });
      seen[bid] = true;
      if (b.Start && !validDatetime(b.Start)) errs.push({ k: 'pl.err.blockStart', v: { name: bname } });
      const streams = b.Streams || [];
      if (!streams.length && !b.DefaultStream) errs.push({ k: 'pl.err.blockNoStreams', v: { name: bname } });
      streams.forEach((s, si0) => {
        const si = si0 + 1;
        if (!(s.Source || '').trim()) errs.push({ k: 'pl.err.streamNoSource', v: { name: bname, i: si } });
        if (!['vod', 'live'].includes(s.Type)) errs.push({ k: 'pl.err.streamType', v: { name: bname, i: si } });
        for (const mk of s.Scte35Markers || []) {
          const st = String(mk.Start || '').trim();
          if (st && !(validDatetime(st) || /^\d+$/.test(st))) errs.push({ k: 'pl.err.scte', v: { name: bname } });
        }
      });
    });
  });
  return errs;
}

// ---- parse existing JSON -> model (round-trip for editing) ----
function loadStream(d) {
  const s = makeStream(d.Type || 'vod', d.Source || '');
  for (const k of ['Start', 'Duration', 'TotalDuration', 'MaxIterations', 'AudioStreamId', 'VideoStreamId', 'StreamTitle', 'StreamUrl']) {
    if (k in d) s[k] = d[k];
  }
  if (Array.isArray(d.Subtitles)) s.Subtitles = d.Subtitles.map(x => ({ Code: x.Code || '', Name: x.Name || '', Path: x.Path || '' }));
  if (Array.isArray(d.Scte35Markers)) s.Scte35Markers = d.Scte35Markers.map(x => ({ Start: x.Start || '', Type: x.Type || 'Out', Duration: x.Duration ?? null }));
  if (d.Source_AWS && typeof d.Source_AWS === 'object') s.Source_AWS = { ...d.Source_AWS };
  return s;
}
export function parsePlaylist(data) {
  const m = makeModel();
  if (Number.isInteger(data.SyncInterval)) m.SyncInterval = data.SyncInterval;
  for (const td of data.Tasks || []) {
    const t = makeTask(td.Stream || '');
    if (td.InactivityTimeout !== null && td.InactivityTimeout !== undefined) t.InactivityTimeout = td.InactivityTimeout;
    for (const bd of td.Blocks || []) {
      const b = makeBlock(bd.Name || '');
      if (bd.Id) b.Id = bd.Id;
      for (const k of ['Name', 'Start', 'Duration', 'TotalDuration', 'MaxIterations']) if (k in bd) b[k] = bd[k];
      if (bd.DefaultStream && typeof bd.DefaultStream === 'object') b.DefaultStream = loadStream(bd.DefaultStream);
      for (const sd of bd.Streams || []) b.Streams.push(loadStream(sd));
      t.Blocks.push(b);
    }
    m.Tasks.push(t);
  }
  return m;
}
export function parseJson(text) { return parsePlaylist(JSON.parse(text)); }
