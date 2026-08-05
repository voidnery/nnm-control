import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import Modal, { backdropClose } from '../components/Modal.jsx';
import Select from '../components/Select.jsx';
import { useI18n } from '../i18n.jsx';
import IconButton from '../components/IconButton.jsx';
import { useConfirm } from '../confirm.jsx';
import { useToast } from '../toast.jsx';
import SearchInput from '../components/SearchInput.jsx';

const KINDS = [
  { value: 'republish', label: 'Republish rule' },
  { value: 'live_pull', label: 'RTMP live pull (feed reserve)' },
  { value: 'transcoder', label: 'Transcoder (account-level)' },
  { value: 'abr', label: 'ABR setting (account-level)' },
  { value: 'alias', label: 'Application alias (account-level)' },
  { value: 'udp',       label: 'UDP/SRT output (UDP streaming)' },
  { value: 'outgoing',  label: 'MPEGTS outgoing stream' },
  { value: 'hotswap',   label: 'Hot swap setting (Transcoder)' },
  { value: 'incoming',  label: 'SRT In / MPEGTS incoming stream' },
];

// Kinds that support start/stop/restart, and exactly which of those the
// WMSPanel API offers for each (mirrors ACTION_OPS in the runner).
const ACTION_KINDS = [
  { value: 'outgoing',   label: 'SRT in Nimble / MPEGTS outgoing' },
  { value: 'republish',  label: 'RTMP Push (republish rule)' },
  { value: 'live_pull',  label: 'RTMP Pull (live pull)' },
  { value: 'udp',        label: 'SRT Out (UDP/SRT output)' },
  { value: 'hotswap',    label: 'Hot swap setting' },
  { value: 'incoming',   label: 'SRT In (MPEGTS incoming)' },
  { value: 'transcoder', label: 'Transcoder (no server needed)' },
];
const ACTION_SUPPORT = {
  outgoing:   ['pause', 'resume', 'restart'],
  republish:  ['pause', 'resume', 'restart'],
  live_pull:  ['pause', 'resume', 'restart'],
  udp:        ['pause', 'resume', 'restart'],
  hotswap:    ['pause', 'resume', 'restart'],
  incoming:   ['pause', 'resume', 'restart'],
  transcoder: ['pause', 'resume'],
};
// The API has no restart endpoint for these — the panel cycles stop -> start.
const COMPOSITE_RESTART = new Set(['udp', 'hotswap', 'incoming']);

const PRESETS = [
  // Canonical WMSPanel field names (pinned from live account dump 2026-07-21)
  { key: 'fn.p.switchRepublish', label: 'Switch republish source', step: { type: 'patch', objectKind: 'republish', patch: { src_app: 'zagl_app', src_strm: 'zagl_stream' }, label: 'Switch republish source' } },
  { key: 'fn.p.switchUdp', label: 'Switch SRT/UDP output source', step: { type: 'patch', objectKind: 'udp', patch: { source_streams: [{ application: 'zagl_app', stream: 'zagl_stream' }] }, label: 'Switch SRT/UDP source' } },
  { key: 'fn.p.patchOutgoing', label: 'Patch outgoing stream',   step: { type: 'patch', objectKind: 'outgoing', patch: {}, label: 'Patch outgoing stream' } },
  // iter11 2b — "SRT in Nimble" is an `outgoing` object, and its inputs are
  // nested references to `incoming` objects. Field names pinned from the live
  // account dump; the source is picked, not typed, because an id typed wrong
  // is a stream switched to nothing.
  { key: 'fn.p.switchSources', label: 'SRT in Nimble: switch video + audio source',
    step: { type: 'patch', objectKind: 'outgoing', patch: { video_source: { id: '' }, audio_source: { id: '' } }, label: 'Switch sources' } },
  { key: 'fn.p.switchVideoSource', label: 'SRT in Nimble: switch video source',
    step: { type: 'patch', objectKind: 'outgoing', patch: { video_source: { id: '' } }, label: 'Switch video source' } },
  { key: 'fn.p.switchAudioSource', label: 'SRT in Nimble: switch audio source',
    step: { type: 'patch', objectKind: 'outgoing', patch: { audio_source: { id: '' } }, label: 'Switch audio source' } },
  { key: 'fn.p.hotswapOn', label: 'Подмена картинкой ON (hotswap)', step: { type: 'patch', objectKind: 'hotswap', patch: { emergency: true }, label: 'Substitute ON' } },
  { key: 'fn.p.hotswapOff', label: 'Подмена картинкой OFF (hotswap)', step: { type: 'patch', objectKind: 'hotswap', patch: { emergency: false }, label: 'Substitute OFF' } },
  { key: 'fn.p.pauseOutgoing', label: 'Pause outgoing',  step: { type: 'action', action: 'pause', label: 'Pause outgoing' } },
  { key: 'fn.p.resumeOutgoing', label: 'Resume outgoing', step: { type: 'action', action: 'resume', label: 'Resume outgoing' } },
  { key: 'fn.p.restartOutgoing', label: 'Restart outgoing',step: { type: 'action', action: 'restart', label: 'Restart outgoing' } },
  { key: 'fn.p.pullSwitch', label: 'Live pull: switch source URL', step: { type: 'patch', objectKind: 'live_pull', patch: { url: 'rtmp://backup-host:1935/app/stream' }, label: 'Switch pull URL' } },
  { key: 'fn.p.pullRestart', label: 'Restart live pull', step: { type: 'action', objectKind: 'live_pull', action: 'restart', label: 'Restart pull' } },
  { key: 'fn.p.tcPause', label: 'Подмена: pause transcoder', step: { type: 'action', objectKind: 'transcoder', action: 'pause', label: 'Pause transcoder' } },
  { key: 'fn.p.tcResume', label: 'Подмена: resume transcoder', step: { type: 'action', objectKind: 'transcoder', action: 'resume', label: 'Resume transcoder' } },
  { key: 'fn.p.pushStart', label: 'RTMP Push: start', step: { type: 'action', objectKind: 'republish', action: 'resume', label: 'Start RTMP Push' } },
  { key: 'fn.p.pushStop', label: 'RTMP Push: stop', step: { type: 'action', objectKind: 'republish', action: 'pause', label: 'Stop RTMP Push' } },
  { key: 'fn.p.pushRestart', label: 'RTMP Push: restart', step: { type: 'action', objectKind: 'republish', action: 'restart', label: 'Restart RTMP Push' } },
  { key: 'fn.p.pullStart', label: 'RTMP Pull: start', step: { type: 'action', objectKind: 'live_pull', action: 'resume', label: 'Start RTMP Pull' } },
  { key: 'fn.p.pullStop', label: 'RTMP Pull: stop', step: { type: 'action', objectKind: 'live_pull', action: 'pause', label: 'Stop RTMP Pull' } },
  { key: 'fn.p.udpStart', label: 'SRT Out: start', step: { type: 'action', objectKind: 'udp', action: 'resume', label: 'Start SRT Out' } },
  { key: 'fn.p.udpStop', label: 'SRT Out: stop', step: { type: 'action', objectKind: 'udp', action: 'pause', label: 'Stop SRT Out' } },
  { key: 'fn.p.inStart', label: 'SRT In: start', step: { type: 'action', objectKind: 'incoming', action: 'resume', label: 'Start SRT In' } },
  { key: 'fn.p.inStop', label: 'SRT In: stop', step: { type: 'action', objectKind: 'incoming', action: 'pause', label: 'Stop SRT In' } },
  { key: 'fn.p.udpRestart', label: 'SRT Out: restart (stop+start)', step: { type: 'action', objectKind: 'udp', action: 'restart', restartDwellSec: 40, label: 'Restart SRT Out' } },
  { key: 'fn.p.inRestart', label: 'SRT In: restart (stop+start)', step: { type: 'action', objectKind: 'incoming', action: 'restart', restartDwellSec: 40, label: 'Restart SRT In' } },
  { key: 'fn.p.delay', label: 'Delay (seconds)', step: { type: 'delay', waitSec: 10, label: 'Delay' } },
];

function ObjectPicker({ servers, step, onPick }) {
  const { t } = useI18n();
  const [objects, setObjects] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const load = async () => {
    // Toggle: a second click closes the picker instead of re-fetching.
    if (objects) { setObjects(null); setQ(''); setError(''); return; }
    setError(''); setObjects(null); setQ('');
    try {
      const accountKind = ['transcoder', 'abr', 'alias'].includes(step.objectKind);
      const d = await api(`/functions/objects/${accountKind ? 'any' : step.serverId}/${step.objectKind || 'outgoing'}`);
      setObjects(d.objects);
    } catch (e) { setError(e.message); }
  };
  // Head of the label; falls back to a short id so unpinned schemas (e.g. ABR
  // settings, which carry source_streams but no name/protocol) never render
  // the literal "undefined".
  const headOf = (o) => o.name || o.protocol || o.title || (o.id ? '#' + String(o.id).slice(-6) : 'object');
  // What the object DOES, without its name.
  const shapeOf = (o) =>
    o.src_app !== undefined ? `${o.src_app}/${o.src_strm || '*'} → ${o.dest_addr || ''}` :
    o.source_streams !== undefined ? `⇐ ${(o.source_streams[0]?.application || '?')}/${(o.source_streams[0]?.stream || '?')}` :
    o.original_app !== undefined ? `${o.original_app}/${o.original_stream} → ${o.substitute_app}/${o.substitute_stream}${o.emergency ? ' [EMERGENCY]' : ''}` :
    (o.name !== undefined && o.paused !== undefined && o.server_id !== undefined) ? (o.paused ? '[paused]' : '[running]') :
    o.application !== undefined ? `${o.application}/${o.stream || ''}${o.status ? ' · ' + o.status : ''}` :
    o.protocol || '';

  // Name first, then what it does, then its description — the order every tab
  // in the panel already uses. The picker used to lead with the routing detail
  // and drop the name entirely for republish rules and hot swaps, so an
  // operator who had named a rule could not find it by that name.
  const labelOf = (o) => {
    const name = String(o.name || '').trim();
    const shape = shapeOf(o);
    const desc = String(o.description || '').trim();
    return [name, shape, desc && desc !== name ? `— ${desc}` : '']
      .filter(Boolean).join('  ') || headOf(o);
  };
  const describe = (o) => `${String(o.id).slice(-6)} · ${labelOf(o)}`;
  return (
    <div style={{ marginTop: 6 }}>
      <button className={objects ? 'active' : ''}
              disabled={!step.serverId && !['transcoder', 'abr', 'alias'].includes(step.objectKind)}
              onClick={load}>{objects ? 'Hide objects' : 'Browse objects…'}</button>
      {error && <div className="error-box">{error}</div>}
      {objects && (
        <div className="panel" style={{ marginTop: 6, padding: 8 }}>
          <SearchInput autoFocus value={q} onChange={setQ} style={{ marginBottom: 6 }} />
          <div style={{ maxHeight: 180, overflow: 'auto' }}>
            {objects.filter(o => !q || describe(o).toLowerCase().includes(q.toLowerCase())).map(o => (
              <div key={o.id} className="mono" style={{ cursor: 'pointer', padding: '3px 6px', borderRadius: 4 }}
                   onClick={() => { onPick(o, labelOf(o)); setObjects(null); setQ(''); }}
                   onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-raise)'}
                   onMouseLeave={e => e.currentTarget.style.background = ''}
                   title={labelOf(o)}>
                {describe(o)}
              </div>
            ))}
            {objects.length === 0 && <span className="hint">{t('fn.noObjects')}</span>}
          </div>
          <div className="row" style={{ marginTop: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => setObjects(null)}>{t('action.close')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

const KEY_PAIRS = [
  { value: 'src',  label: 'src_app / src_strm (republish)', keys: ['src_app', 'src_strm'] },
  { value: 'app',  label: 'application / stream (outgoing)', keys: ['application', 'stream'] },
  { value: 'udps', label: 'source_streams (SRT/UDP output)', keys: null }, // special: array form
  { value: 'sub',  label: 'substitute_app / substitute_stream (hot swap)', keys: ['substitute_app', 'substitute_stream'] },
  { value: 'orig', label: 'original_app / original_stream (hot swap)', keys: ['original_app', 'original_stream'] },
];
const defaultPairFor = (kind) => kind === 'republish' ? 'src' : kind === 'hotswap' ? 'sub' : kind === 'udp' ? 'udps' : 'app';

// Which field pairs actually exist on each kind of object. Offering all five
// everywhere is how a "switch the source" step ended up with
// `"application":"Sport_tv_obs","stream":"feed1"` in its patch: on an outgoing
// stream those two are its OWN name, so that patch renames the stream instead
// of repointing it.
const PAIRS_FOR = {
  republish: ['src'],
  udp: ['udps'],
  hotswap: ['sub', 'orig'],
  outgoing: ['app'],
  live_pull: ['app'],          // live pull genuinely carries application/stream
  incoming: [],
};
const pairsFor = (kind) => {
  const allowed = PAIRS_FOR[kind];
  return allowed === undefined ? KEY_PAIRS : KEY_PAIRS.filter(k => allowed.includes(k.value));
};

// Loading a server's SRT In / MPEG-TS In objects, shared by the step editor
// and the variant editor. One place, so the two cannot end up offering
// different lists for the same server.
function useIncoming(serverId, enabled) {
  const [sources, setSources] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!enabled || !serverId) return;
    let dead = false;
    api(`/functions/objects/${serverId}/incoming`)
      .then(d => { if (!dead) { setSources(d.objects || d || []); setErr(''); } })
      .catch(e => { if (!dead) setErr(e.message); });
    return () => { dead = true; };
  }, [serverId, enabled]);
  return { sources, err };
}

// Name and description separately so a dropdown can dim the second.
function srcOptionOf(o) {
  const name = String(o.name || '').trim();
  const extra = String(o.description || '').trim();
  return {
    value: String(o.id),
    label: name || `id ${String(o.id ?? '').slice(-8) || '?'}`,
    hint: extra && extra !== name ? extra : '',
  };
}

/**
 * Apply one source change, with audio following video.
 *
 * Shared by the step editor and the variant editor. It lived only in the step
 * editor at first, so picking a video source in a variant left the audio
 * behind — the same rule written once and used twice, rather than twice and
 * remembered once.
 *
 * @param current  the values in force before the change
 * @param field    which source is being set
 * @param id       the new source id
 * @returns the full set of source values after the change
 */
export function withSourceFollow(current, field, id) {
  const next = { ...current };
  const prev = current[field]?.id || '';
  next[field] = { id };
  // Audio follows video when it is empty or was tracking the old video value.
  // An audio deliberately pointed elsewhere is a decision, and convenience
  // must not overwrite it.
  if (field === 'video_source' && 'audio_source' in current) {
    const audio = current.audio_source?.id || '';
    if (!audio || audio === prev) next.audio_source = { id };
  }
  return next;
}

/**
 * Which override values no longer correspond to anything in the step.
 *
 * A variant names only the fields it differs in. Change the step so it no
 * longer sends a field, and the variant's override for it becomes a value
 * nobody can see and nothing will apply; change the step's own value and the
 * variant silently keeps the old one — which is the dangerous half, because
 * that old value is what goes to a live stream.
 *
 * Neither is auto-corrected: a variant exists precisely to differ, so
 * overwriting it would destroy the thing being configured. The operator is
 * told instead.
 */
export function variantDrift(steps, variant) {
  const out = [];
  for (const [idx, over] of Object.entries(variant?.overrides || {})) {
    const step = steps[Number(idx)];
    if (!step) { out.push({ index: Number(idx), kind: 'noStep' }); continue; }
    const base = step.patch || {};
    for (const key of Object.keys(over || {})) {
      if (!(key in base)) out.push({ index: Number(idx), key, kind: 'orphanField' });
    }
  }
  return out;
}

// The values a variant overrides for one step, as controls rather than JSON.
//
// A variant only names the fields it differs in, so every control starts from
// the step's own value and writes into the override only once it is changed.
// Asking for hand-typed JSON here was asking for exactly the mistake the step
// editor exists to prevent: an id typed wrong points a stream at nothing and
// still verifies as applied.
function VariantStepFields({ step, override, onChange }) {
  const { t } = useI18n();
  const base = step.patch || {};
  const wantsSource = 'video_source' in base || 'audio_source' in base;
  const { sources, err } = useIncoming(step.serverId, wantsSource);

  const valueOf = (key) => (key in (override || {}) ? override[key] : base[key]);

  // Only what the variant genuinely changes is kept: a value equal to the
  // step's own is dropped, and a variant left with nothing carries no entry.
  const commit = (values) => {
    const next = { ...(override || {}) };
    for (const [k, v] of Object.entries(values)) {
      if (JSON.stringify(v) === JSON.stringify(base[k])) delete next[k];
      else next[k] = v;
    }
    onChange(Object.keys(next).length ? next : null);
  };

  const setKey = (key, value) => commit({ [key]: value });

  const setSourceKey = (key, id) => {
    // The values in force for this variant, which is the step's patch with the
    // variant's own overrides on top — not the step's patch alone, or picking
    // a second video would compare against the wrong "previous".
    const current = {};
    for (const k of Object.keys(base)) current[k] = valueOf(k);
    commit(withSourceFollow(current, key, id));
  };

  const keys = Object.keys(base);
  if (!keys.length) return <div className="hint">{t('fn.variantNoFields')}</div>;

  return (
    <div>
      {err && <div className="hint" style={{ color: 'var(--warn)' }}>{err}</div>}
      {keys.map(key => {
        const isSource = key === 'video_source' || key === 'audio_source';
        const overridden = key in (override || {});
        return (
          <div key={key} style={{ marginBottom: 6 }}>
            <label style={{ fontSize: 12 }}>
              {key}
              {overridden && <span className="badge live" style={{ marginLeft: 6 }}>{t('fn.variantChanged')}</span>}
              {/* What the step itself sends, beside what the variant sends
                  instead — the comparison an operator is actually making. */}
              {overridden && base[key] !== undefined && (
                <span className="hint mono" style={{ marginLeft: 8, fontSize: 11 }}>
                  {t('fn.variantBaseIs')} {isSource ? (base[key]?.id || '—') : String(base[key])}
                </span>
              )}
            </label>
            {isSource ? (
              <Select searchable value={valueOf(key)?.id || ''}
                      onChange={v => setSourceKey(key, v)}
                      options={[{ value: '', label: t('fn.pickSource') },
                                ...(sources || []).map(srcOptionOf)]} />
            ) : typeof base[key] === 'object' && base[key] !== null ? (
              // Arrays and nested shapes have no honest control yet, so they
              // keep the raw form rather than a control that silently mangles
              // them.
              <textarea className="mono" rows={1} style={{ fontSize: 11 }}
                        value={JSON.stringify(valueOf(key) ?? base[key])}
                        onChange={e => { try { setKey(key, JSON.parse(e.target.value)); } catch { /* keep last valid */ } }} />
            ) : (
              <input className="mono" value={String(valueOf(key) ?? '')}
                     onChange={e => setKey(key, e.target.value)} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// What a step does, as the thing the eye should find first.
//
// Fifteen steps were fifteen identical grey panels distinguished by a grey
// badge reading `action:outgoing:restart`. Scanning them meant reading every
// one. The colour encodes the ACTION rather than the object kind, because the
// question asked of a long list is "which of these stops something", and the
// answer to "which object" is already spelled out beside it.
const STEP_TONE = {
  pause: 'var(--warn)',
  restart: 'var(--warn)',
  resume: 'var(--ok)',
  patch: 'var(--accent)',
  delay: 'var(--muted)',
};
const stepTone = (step) => STEP_TONE[step.action] || STEP_TONE[step.type] || 'var(--line)';

function StepEditor({ step, servers, onChange, onRemove, onDuplicate, index, total, onMove, collapsed, onToggle }) {
  const { t } = useI18n();
  const set = (k, v) => onChange({ ...step, [k]: v });
  // Two set() calls in one handler both read the same `step` prop — React has
  // not re-rendered between them — so the second silently discards the first.
  // That is how picking an object stored its label and lost its id, leaving
  // "SELECTED cct_feeds/feed1" on screen next to an empty targetId and a
  // function that failed preflight on every step.
  const setMany = (patch) => onChange({ ...step, ...patch });
  const [patchText, setPatchText] = useState(JSON.stringify(step.patch || {}, null, 0));
  const [patchErr, setPatchErr] = useState('');
  const [live, setLive] = useState(null);        // { streams, source }
  const [liveErr, setLiveErr] = useState('');
  const [pick, setPick] = useState('');          // "app/stream"
  const [pairKind, setPairKind] = useState(defaultPairFor(step.objectKind));
  // iter11 2a — the source pickers. Nested references to `incoming` objects,
  // so the operator picks a source rather than typing an id: an id typed wrong
  // is a stream switched to nothing, and it verifies as "applied".
  const wantsSource = step.type === 'patch' && step.objectKind === 'outgoing' &&
    ('video_source' in (step.patch || {}) || 'audio_source' in (step.patch || {}));
  // A source switch has its own pickers, and the generic app/stream inserter
  // can only add fields that do not belong — so it is not offered at all.
  const availablePairs = wantsSource ? [] : pairsFor(step.objectKind);
  const { sources, err: srcErr } = useIncoming(step.serverId, wantsSource);
  const setSource = (field, id) => {
    const patch = { ...(step.patch || {}), ...withSourceFollow(step.patch || {}, field, id) };
    onChange({ ...step, patch });
    setPatchText(JSON.stringify(patch));
  };
  // An incoming object is named, not addressed by app/stream — which is how
  // the rest of the panel labels them, and what I should have looked at
  // instead of guessing field names. The guess produced a list of "?/?".
  const srcOption = srcOptionOf;
  const applyPatchText = (t) => {
    setPatchText(t);
    try { onChange({ ...step, patch: JSON.parse(t || '{}') }); setPatchErr(''); }
    catch { setPatchErr('Invalid JSON'); }
  };
  const loadLive = async () => {
    setLiveErr(''); setLive(null);
    try { setLive(await api(`/functions/streams/${step.serverId}`)); }
    catch (e) { setLiveErr(e.message); }
  };
  const insertPick = () => {
    const slash = pick.indexOf('/');
    if (slash < 0) return;
    const app = pick.slice(0, slash);
    const stream = pick.slice(slash + 1);
    const pair = KEY_PAIRS.find(k => k.value === pairKind);
    let nextPatch;
    if (pair && pair.keys === null) {
      // SRT/UDP output: source is the source_streams array. NOTE: PIDs
      // (pmt/video/audio) are omitted — WMSPanel re-assigns them; if fixed
      // PIDs matter, copy the full array from Browse tooltip and edit here.
      nextPatch = { ...(step.patch || {}), source_streams: [{ application: app, stream }] };
    } else {
      const keys = pair?.keys || ['src_app', 'src_strm'];
      nextPatch = { ...(step.patch || {}), [keys[0]]: app, [keys[1]]: stream };
    }
    onChange({ ...step, patch: nextPatch });
    setPatchText(JSON.stringify(nextPatch, null, 0));
    setPatchErr('');
  };
  const tone = stepTone(step);
  const verb = step.type === 'delay' ? t('fn.v.delay')
    : step.action ? t(`fn.v.${step.action}`)
    : t('fn.v.patch');

  return (
    <div className="step" style={{ borderLeftColor: tone }}>
      {/* Order, verb, object, server — in the order they are looked for. The
          band is the step's identity; everything below it is its settings. */}
      <div className="row step-head" style={{ justifyContent: 'space-between', gap: 8 }}>
        <div className="row" style={{ gap: 8, alignItems: 'center', minWidth: 0 }}>
          <button className="step-fold" onClick={onToggle} title={collapsed ? t('fn.expand') : t('fn.collapse')}>
            {collapsed ? '▸' : '▾'}
          </button>
          <span className="step-no">{t('fn.stepNo', { n: index + 1 })}</span>
          <span className="step-verb" style={{ color: tone, borderColor: tone }}>{verb}</span>
          <span className="step-target mono" title={step.targetLabel || ''}>
            {step.targetLabel || <span className="hint">{t('fn.noTargetYet')}</span>}
          </span>
          {step.objectKind && <span className="hint" style={{ flexShrink: 0 }}>{step.objectKind}</span>}
        </div>
        <div className="row" style={{ gap: 6, flexShrink: 0 }}>
          {step.type !== 'delay' && !String(step.targetId || '').trim() && (
            <span className="badge err" title={t('fn.incompleteNoTarget')}>{t('fn.needsPick')}</span>
          )}
          {/* Order matters to what a function does, so it is changeable here
              rather than by deleting and re-adding further down. */}
          {onMove && <IconButton action="up" disabled={index === 0} onClick={() => onMove(-1)} />}
          {onMove && <IconButton action="down" disabled={index === total - 1} onClick={() => onMove(+1)} />}
          {onDuplicate && <IconButton action="duplicate" onClick={onDuplicate} />}
          <IconButton action="remove" danger onClick={onRemove} />
        </div>
      </div>

      {collapsed ? null : (
      <div className="step-body">
      <input style={{ maxWidth: 260 }} value={step.label} placeholder={t('fn.stepLabel')}
             onChange={e => set('label', e.target.value)} />
      {step.type === 'action' && (
        <>
          <label>{t('fn.actionTargetKind')}</label>
          <Select value={step.objectKind || 'outgoing'} onChange={v => set('objectKind', v === 'outgoing' ? '' : v)}
                  options={ACTION_KINDS} />
          <label>{t('fn.action')}</label>
          <Select value={step.action || 'pause'} onChange={v => set('action', v)}
                  options={(ACTION_SUPPORT[step.objectKind || 'outgoing'] || ['pause', 'resume'])
                    .map(a => ({ value: a, label: t('fn.action.' + a) }))} />
          {step.action === 'restart' && COMPOSITE_RESTART.has(step.objectKind || 'outgoing') && (
            <>
              <label>{t('fn.dwell')}</label>
              <input type="number" min="0" value={step.restartDwellSec ?? 40}
                     onChange={e => set('restartDwellSec', e.target.value === '' ? undefined : Number(e.target.value))} />
              <div className="hint">{t('fn.dwellHint')}</div>
            </>
          )}
        </>
      )}
      {step.type !== 'delay' && (
        <>
          <label>{t('fn.server')}</label>
          <Select value={step.serverId || ''} onChange={v => set('serverId', v)} searchable
                  options={[{ value: '', label: '— select —' }, ...servers.map(s => ({ value: s.id, label: s.name }))]} />
          {step.type === 'patch' && (
            <>
              <label>{t('fn.objectKind')}</label>
              <Select value={step.objectKind} onChange={v => set('objectKind', v)}
                      options={KINDS.map(k => ({ value: k.value, label: k.label }))} />
            </>
          )}
          {/* Two questions, and the editor used to run them together: which
              object is being changed, and what to set on it. */}
          <div className="hint" style={{ marginTop: 8, marginBottom: 2 }}><b>{t('fn.whatToChange')}</b></div>
          <label>{t('fn.targetId')}</label>
          <input className="mono" value={step.targetId || ''} onChange={e => set('targetId', e.target.value)} />
          <ObjectPicker servers={servers} step={step} onPick={(o, label) => setMany({ targetId: String(o.id), targetLabel: label })} />
          {step.targetLabel && (
            <div className="picked-row">
              <span className="picked-tag">{t('fn.selected')}</span>
              <b className="mono picked-val">{step.targetLabel}</b>
            </div>
          )}
          {step.type === 'patch' && (
            <>
              <div className="hint" style={{ marginTop: 10, marginBottom: 2 }}><b>{t('fn.changeToWhat')}</b></div>
              {/* Only offered where the object actually has such a pair. The
                  step's own pickers replace it for a source switch, where
                  application/stream would mean the outgoing stream's own name
                  and the patch would rename it instead of repointing it. */}
              {availablePairs.length > 0 && (<>
              <label>{t('fn.sourcePicker')}</label>
              <div className="row">
                <button disabled={!step.serverId} onClick={loadLive}>{t('fn.loadStreams')}</button>
                {live && <span className="hint">{live.streams.length} found ({live.source === 'wmspanel-streams' ? 'active streams' : 'from configured objects'})</span>}
              </div>
              {liveErr && <div className="error-box">{liveErr}</div>}
              {live && (
                <div className="row" style={{ marginTop: 6 }}>
                  <div style={{ flex: 2 }}>
                    <Select value={pick} onChange={setPick} searchable placeholder={t('fn.appStream')}
                            options={live.streams.map(st => ({ value: `${st.app}/${st.stream}`, label: `${st.app}/${st.stream}` }))} />
                  </div>
                  <div style={{ flex: 3 }}>
                    <Select value={pairKind} onChange={setPairKind}
                            options={availablePairs.map(k => ({ value: k.value, label: k.label }))} />
                  </div>
                  {/* Pulsing only while something is chosen and not yet
                      applied. A button that always pulses is a button nobody
                      sees after a day — and the trap here is specific:
                      picking a stream changes nothing until this is pressed,
                      so the moment worth marking is exactly that gap. */}
                  <button className={pick.includes('/') ? 'pending' : ''}
                          disabled={!pick.includes('/')} onClick={insertPick}>{t('fn.insert')}</button>
                </div>
              )}
              </>)}
              {wantsSource && (
                <div className="panel" style={{ marginBottom: 6 }}>
                  <div className="hint" style={{ marginBottom: 4 }}>{t('fn.sourceHint')}</div>

                  {srcErr && <div className="hint" style={{ color: 'var(--warn)' }}>{srcErr}</div>}
                  {['video_source', 'audio_source'].filter(f => f in (step.patch || {})).map(f => (
                    <div key={f} style={{ marginBottom: 4 }}>
                      <label>{t(f === 'video_source' ? 'fn.videoSource' : 'fn.audioSource')}</label>
                      <Select searchable value={step.patch[f]?.id || ''} onChange={v => setSource(f, v)}
                              options={[{ value: '', label: t('fn.pickSource') },
                                        ...(sources || []).map(srcOption)]} />
                    </div>
                  ))}
                </div>
              )}
              <label>Patch (JSON: fields to change; snapshot/rollback is automatic)</label>
              <textarea className="mono" rows={2} value={patchText} onChange={e => applyPatchText(e.target.value)} />
              {patchErr && <div className="hint" style={{ color: 'var(--warn)' }}>{patchErr}</div>}
            </>
          )}
        </>
      )}
      {step.type === 'delay' && (
        <>
          <label>{t('fn.waitSeconds')}</label>
          <input type="number" value={step.waitSec || 0} onChange={e => set('waitSec', Number(e.target.value))} />
        </>
      )}
      </div>
      )}
    </div>
  );
}

// Choosing which set of values to run with, and seeing what that means before
// committing. The preview comes from the server, resolved by the SAME function
// the executor uses — a preview computed a second way would eventually
// disagree with the run, and the operator would be reading a reassurance
// rather than a fact.
function VariantPicker({ fn, onCancel, onPick }) {
  const { t } = useI18n();
  const [sel, setSel] = useState(fn.variants[0]?.id || '');
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  // Switching between variants re-asks the server, and each answer is worth
  // keeping: an operator comparing two variants flips between them several
  // times before deciding.
  const cache = useRef(new Map());

  useEffect(() => {
    if (!sel) return;
    let dead = false;

    // Clearing the preview before fetching emptied the table, which collapsed
    // the dialog and then re-expanded it a moment later — read as the whole
    // window blinking. The previous answer stays on screen until the new one
    // arrives; the same reason the log views keep their last result.
    const hit = cache.current.get(sel);
    if (hit) { setPreview(hit); setErr(''); }
    setLoading(true);

    api(`/functions/${fn._id}/preview?variantId=${encodeURIComponent(sel)}`)
      .then(d => {
        if (dead) return;
        cache.current.set(sel, d);
        setPreview(d); setErr('');
      })
      .catch(e => { if (!dead) setErr(e.message); })
      .finally(() => { if (!dead) setLoading(false); });

    return () => { dead = true; };
  }, [fn._id, sel]);

  // The preview on screen belongs to the variant it was fetched for. While a
  // different one is loading, saying so beats showing another variant's values
  // as though they were this one's.
  const showing = preview?.variant?.id;
  const stale = Boolean(showing && showing !== sel);

  // Hand-rolled backdrop markup rendered wherever it happened to sit in the
  // tree — at the bottom of the page, under the run history. Modal portals to
  // document.body, which is the whole reason it exists.
  return (
    <Modal onClose={onCancel} size="wide">
      <>
        <h3 style={{ marginTop: 0 }}>{t('fn.pickVariant', { name: fn.name })}</h3>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {fn.variants.map(v => (
            <button key={v.id} className={sel === v.id ? 'primary' : ''} onClick={() => setSel(v.id)}>{v.name}</button>
          ))}
        </div>
        {err && <div className="error-box">{err}</div>}
        {/* A fixed floor under the table, so the first load does not resize the
            dialog either. */}
        {(preview || loading) && (
          <div className="panel" style={{ minHeight: 120, opacity: stale ? 0.55 : 1, transition: 'opacity .12s' }}>
            <div className="hint" style={{ marginBottom: 4 }}>
              {t('fn.previewHint')}
              {stale && <> · {t('fn.previewLoading')}</>}
            </div>
            <table>
              <tbody>
                {(preview?.steps || []).map(st => (
                  <tr key={st.index} className="tally">
                    <td className="mono" style={{ width: 24, fontSize: 12 }}>{st.index + 1}</td>
                    <td style={{ fontSize: 12 }}>{st.label || st.type}{st.targetLabel ? ` · ${st.targetLabel}` : ''}</td>
                    <td style={{ fontSize: 12, wordBreak: 'break-word' }}>
                      {/* Names, not ids. This is the last thing read before a
                          function touches live streams, and a wall of
                          24-character ids is not something anyone can check. */}
                      {st.type !== 'patch' ? <span className="hint">—</span> : (
                        <>
                          {Object.keys(st.resolved || {}).length > 0 && (
                            <div>
                              {st.resolved.video_source && (
                                <div>{t('fn.videoSource')}: <b>{st.resolved.video_source}</b></div>
                              )}
                              {st.resolved.audio_source && (
                                <div>{t('fn.audioSource')}: <b>{st.resolved.audio_source}</b></div>
                              )}
                            </div>
                          )}
                          {/* Anything the preview could not name stays visible
                              as it will be sent — hidden fields are how a patch
                              carries something nobody meant. */}
                          {(() => {
                            const named = new Set(Object.keys(st.resolved || {}));
                            const rest = Object.fromEntries(
                              Object.entries(st.patch || {}).filter(([k]) => !named.has(k)));
                            return Object.keys(rest).length
                              ? <div className="mono hint" style={{ fontSize: 11 }}>{JSON.stringify(rest)}</div>
                              : null;
                          })()}
                        </>
                      )}
                      {st.overridden?.length > 0 && (
                        <span className="badge live" style={{ marginLeft: 6 }}>{st.overridden.join(', ')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={onCancel}>{t('action.cancel')}</button>
          <button className="primary" disabled={!sel} onClick={() => onPick(sel)}>{t('fn.run')}</button>
        </div>
      </>
    </Modal>
  );
}

function Builder({ initial, servers, onClose, onSaved }) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const { user } = useAuth();
  const backDown = useRef(false);
  const w = user?.preferences?.functionModalWidth || 'default';
  const widthClass = w === 'default' ? '' : 'w-' + w;
  const isEdit = Boolean(initial._id);
  const [name, setName] = useState(initial.name || '');
  const [description, setDescription] = useState(initial.description || '');
  const [steps, setSteps] = useState(initial.steps || []);
  // Folded steps, by index. A function of fifteen steps is a page of forms
  // otherwise, and the one being edited is somewhere in the middle of it.
  const [folded, setFolded] = useState(new Set());
  // iter11 2b — one skeleton, several sets of values. An empty list means the
  // function runs exactly as it always did.
  const [variants, setVariants] = useState(initial.variants || []);

  // Variant overrides are keyed by step POSITION, so any change to the order
  // or the number of steps silently re-points every override after it.
  //
  // Deleting the third of six steps left the fourth variant's values attached
  // to what had been the fifth — reported as "drifted from the step", which
  // was true and unexplainable — and left an override for a position that no
  // longer existed, which is why a variant showed six values against five
  // steps. Reordering, added in v0.43.0, made it worse: it re-points overrides
  // without changing the count, so nothing looks wrong at all.
  //
  // The keys are moved with the steps. The alternative — keying by a stable
  // step id — is the better shape and needs a migration of every stored
  // function; this keeps the two in step today.
  const remapVariants = (fn) => setVariants(all => all.map(v => {
    const next = {};
    for (const [k, over] of Object.entries(v.overrides || {})) {
      const to = fn(Number(k));
      // null means the step it belonged to is gone. Dropping the override is
      // right: keeping it would leave a value with nothing to apply to, which
      // is the six-against-five case.
      if (to != null) next[String(to)] = over;
    }
    return { ...v, overrides: next };
  }));
  const [openVariant, setOpenVariant] = useState(null);
  const [error, setError] = useState('');

  const addPreset = (preset) => setSteps(st => [...st, { serverId: '', targetId: '', waitSec: 0, ...JSON.parse(JSON.stringify(preset.step)) }]);

  // The same rule the backend applies on save, run as the operator edits: a
  // step whose object was never picked saves cleanly and then fails preflight
  // on a live fleet, which is the worst place to find out.
  const incomplete = useMemo(() => steps
    .map((st, i) => ({ st, i }))
    .filter(({ st }) => st.type !== 'delay' && (!st.serverId || !String(st.targetId || '').trim())),
  [steps]);

  const drift = useMemo(() => Object.fromEntries(
    variants.map(v => [v.id, variantDrift(steps, v)]),
  ), [steps, variants]);

  const addVariant = () => setVariants(v => {
    // The first variant is what the function already does. Starting it empty
    // meant an operator who had configured everything for input A had to type
    // A in again before they could add B — and an empty first variant runs the
    // base steps, which looks identical until it is not.
    const seed = {};
    if (v.length === 0) {
      steps.forEach((st, i) => {
        if (st.type === 'patch' && st.patch && Object.keys(st.patch).length) {
          seed[String(i)] = JSON.parse(JSON.stringify(st.patch));
        }
      });
    }
    return [...v, {
      id: `v${Math.random().toString(36).slice(2, 8)}`,
      name: `${t('fn.variant')} ${v.length + 1}`,
      overrides: seed,
    }];
  });
  const patchVariant = (id, patch) => setVariants(v => v.map(x => (x.id === id ? { ...x, ...patch } : x)));
  const dropVariant = (id) => setVariants(v => v.filter(x => x.id !== id));
  // Controls hand back an object (or null to stop overriding), not text.
  const setOverrideObject = (vid, stepIdx, next) => {
    setVariants(vs => vs.map(v => {
      if (v.id !== vid) return v;
      const o = { ...(v.overrides || {}) };
      if (!next) delete o[String(stepIdx)];
      else o[String(stepIdx)] = next;
      return { ...v, overrides: o };
    }));
  };

  const save = async () => {
    setError('');
    // A function with no steps is legal — someone may be building it over two
    // sittings — but it is almost always a slip, and the old failure for it was
    // a 500 that explained nothing.
    if (steps.length === 0 && !(await confirm(t('fn.confirmEmpty')))) return;
    try {
      const body = { name, description, steps, variants };
      if (isEdit) await api(`/functions/${initial._id}`, { method: 'PUT', body });
      else await api('/functions', { method: 'POST', body });
      onSaved();
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="modal-back" onMouseDown={e => { if (e.target === e.currentTarget) backDown.current = true; }}
         onMouseUp={e => { if (backDown.current && e.target === e.currentTarget) onClose(); backDown.current = false; }}>
      <div className={'modal ' + widthClass} onMouseDown={e => e.stopPropagation()}>
        <h3>{isEdit ? 'Edit function' : 'New function'}</h3>
        <label>{t('fn.name')}</label>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Подмена потоков картинкой" />
        <label>{t('fn.description')}</label>
        <input value={description} onChange={e => setDescription(e.target.value)} />
        {/* iter11 2b — the same steps, several sets of values. Only the fields
            that differ are named per variant; everything else falls through to
            the step's own patch, so adding a stream to the function adds it to
            every variant at once instead of once per copy. */}
        <div className="panel" style={{ marginTop: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <b>{t('fn.variants')}</b>
              <div className="hint">{variants.length === 0 ? t('fn.variantsNone') : t('fn.variantsHint')}</div>
            </div>
            <button onClick={addVariant}>{t('fn.addVariant')}</button>
          </div>
          {/* Changing a step does not change the variants that override it —
              and a variant holding a stale value is what will be sent to a
              live stream. Saying so is the only safe option: correcting it
              automatically would overwrite the difference the variant exists
              to express. */}
          {variants.some(v => drift[v.id]?.length) && (
            <div className="error-box" style={{ marginTop: 8 }}>{t('fn.driftWarn')}</div>
          )}
          {variants.map(v => (
            <div key={v.id} className="panel" style={{ marginTop: 8 }}>
              <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                <input style={{ flex: 1 }} value={v.name} onChange={e => patchVariant(v.id, { name: e.target.value })} />
                {drift[v.id]?.length > 0 && (
                  <>
                    <span className="badge err" title={t('fn.driftHint')}>{t('fn.driftBadge')}</span>
                    {/* Existing functions carry overrides left behind by the
                        keying bug — values attached to a position that no
                        longer holds the step they were written for. They
                        cannot be repaired automatically, because there is no
                        way to know which step they were meant for; they can
                        be dropped, and dropping them is what makes the badge
                        mean something again. */}
                    <button onClick={() => patchVariant(v.id, {
                      overrides: Object.fromEntries(
                        Object.entries(v.overrides || {})
                          .map(([k, over]) => {
                            const step = steps[Number(k)];
                            if (!step) return null;              // the step is gone
                            const base = step.patch || {};
                            const kept = Object.fromEntries(
                              Object.entries(over || {}).filter(([f]) => f in base));
                            return Object.keys(kept).length ? [k, kept] : null;
                          })
                          .filter(Boolean)),
                    })} title={t('fn.dropStaleHint')}>{t('fn.dropStale')}</button>
                  </>
                )}
                <button onClick={() => setOpenVariant(openVariant === v.id ? null : v.id)}>
                  {openVariant === v.id ? t('fn.hideValues') : t('fn.editValues', { n: Object.keys(v.overrides || {}).length })}
                </button>
                <IconButton action="remove" danger onClick={() => dropVariant(v.id)} />
              </div>
              {openVariant === v.id && (
                <div style={{ marginTop: 6 }}>
                  <label style={{ marginTop: 12 }}>{t('fn.stepsHint')}</label>
        {steps.length === 0 && <div className="hint">{t('fn.noSteps')}</div>}
        {steps.map((st, i) => (
                    st.type === 'patch' ? (
                      <div key={i} className="panel" style={{ marginBottom: 6, padding: 8 }}>
                        <label style={{ fontSize: 12 }}>
                          {i + 1}. {st.label || st.objectKind} {st.targetLabel ? `· ${st.targetLabel}` : ''}
                        </label>
                        <VariantStepFields
                          step={st}
                          override={v.overrides?.[String(i)] || null}
                          onChange={(next) => setOverrideObject(v.id, i, next)} />
                      </div>
                    ) : null
                  ))}
                  {!steps.some(st => st.type === 'patch') && (
                    <div className="hint">{t('fn.variantNoPatchSteps')}</div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>


        {/* At fifteen steps the useful view is the list of what happens, not
            fifteen open forms. Folding is per step and for all of them. */}
        {steps.length > 1 && (
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', margin: '4px 0 8px' }}>
            <span className="hint">{t('fn.stepCount', { n: steps.length })}</span>
            <button onClick={() => setFolded(f => (f.size === steps.length
              ? new Set()
              : new Set(steps.map((_, i) => i))))}>
              {folded.size === steps.length ? t('fn.unfoldAll') : t('fn.foldAll')}
            </button>
          </div>
        )}
        {steps.map((st, i) => (
          <StepEditor key={i} step={st} servers={servers}
                      index={i} total={steps.length}
                      collapsed={folded.has(i)}
                      onToggle={() => setFolded(f => {
                        const n = new Set(f);
                        if (n.has(i)) n.delete(i); else n.add(i);
                        return n;
                      })}
                      onMove={(dir) => {
                        const to = i + dir;
                        if (to < 0 || to >= steps.length) return;
                        remapVariants(k => (k === i ? to : (k === to ? i : k)));
                        setSteps(all => {
                          const list = [...all];
                          [list[i], list[to]] = [list[to], list[i]];
                          return list;
                        });
                      }}
                      onChange={next => setSteps(all => all.map((s, j) => j === i ? next : s))}
                      onRemove={() => {
                        remapVariants(k => (k === i ? null : (k > i ? k - 1 : k)));
                        setSteps(all => all.filter((_, j) => j !== i));
                      }}
                      onDuplicate={() => {
                        // The copy lands at i+1, so everything from there down
                        // moves one place. The copy itself gets no overrides:
                        // a variant names the fields it differs in, and
                        // inheriting them would silently give the new step
                        // values nobody chose for it.
                        remapVariants(k => (k > i ? k + 1 : k));
                        setSteps(all => [
                        ...all.slice(0, i + 1),
                        // Deep-copied: a shallow copy would share the patch
                        // object, and editing one step would silently edit its
                        // twin. Inserted next to the original, because a copy
                        // made to be tweaked belongs beside what it came from.
                        JSON.parse(JSON.stringify({ ...all[i], label: `${all[i].label || ''} (copy)`.trim() })),
                        ...all.slice(i + 1),
                        ]);
                      }} />
        ))}
        {/* Back below the list: the palette is nine rows of buttons, and above
            the steps it pushed the thing being edited off the screen. It sits
            where it appends to now. */}
        <div className="panel" style={{ marginTop: 10, marginBottom: 4 }}>
          <div className="hint" style={{ marginBottom: 6 }}>{t('fn.addStep')}</div>
          {/* Grouped by the object kind of the step itself, so a preset added
              later lands in its group without anyone maintaining a list. A
              flat row of twenty-seven buttons is a wall to read every time. */}
          {(() => {
            const groups = new Map();
            for (const p of PRESETS) {
              const kind = p.step?.objectKind || (p.step?.type === 'delay' ? 'other' : 'other');
              if (!groups.has(kind)) groups.set(kind, []);
              groups.get(kind).push(p);
            }
            // A stated order rather than insertion order: the protocols an
            // operator reaches for most come first, and "other" last wherever
            // it was declared.
            const ORDER = ['incoming', 'udp', 'outgoing', 'republish', 'live_pull',
                           'hotswap', 'transcoder', 'other'];
            const seen = [...ORDER.filter(k => groups.has(k)),
                          ...[...groups.keys()].filter(k => !ORDER.includes(k))];
            return seen.map(kind => (
              <div key={kind} style={{ marginBottom: 8 }}>
                <div className="hint" style={{ fontSize: 11, marginBottom: 3 }}>{t(`fn.g.${kind}`)}</div>
                <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  {groups.get(kind).map(p => (
                    <button key={p.label} onClick={() => addPreset(p)}>+ {p.key ? t(p.key) : p.label}</button>
                  ))}
                </div>
              </div>
            ));
          })()}
        </div>

        {incomplete.length > 0 && (
          <div className="error-box" style={{ marginTop: 10 }}>
            {t('fn.incompleteWarn')}
            <div className="mono" style={{ fontSize: 12, marginTop: 4 }}>
              {incomplete.map(({ st, i }) => (
                <div key={i}>
                  {t('fn.stepN', { n: i + 1 })}: {st.label || st.objectKind || st.type}
                  {' — '}
                  {!st.serverId ? t('fn.incompleteNoServer') : t('fn.incompleteNoTarget')}
                </div>
              ))}
            </div>
          </div>
        )}
        {error && <div className="error-box">{error}</div>}
        <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>{t('action.cancel')}</button>
          <button className="primary" disabled={!name || steps.length === 0} onClick={save}>{t('action.save')}</button>
        </div>
      </div>
    </div>
  );
}

const STEP_ICON = {
  pending: '·', applying: '▶', verifying: '⟳', done: '✓',
  error: '✕', rolling_back: '↩', rolled_back: '↩✓', rollback_failed: '↩✕',
};

function RunView({ runId, onClose }) {
  const { t } = useI18n();
  const [run, setRun] = useState(null);
  const timer = useRef(null);
  useEffect(() => {
    const load = () => api(`/functions/runs/${runId}`).then(r => {
      setRun(r);
      if (r.status !== 'running' && timer.current) { clearInterval(timer.current); timer.current = null; }
    }).catch(() => {});
    load();
    timer.current = setInterval(load, 1500);
    return () => timer.current && clearInterval(timer.current);
  }, [runId]);

  if (!run) return null;
  const statusColor = run.status === 'success' ? 'var(--ok)'
    : run.status === 'running' ? 'var(--accent)' : 'var(--danger)';
  return (
    <div className="modal-back" {...backdropClose(run.status !== 'running' ? onClose : () => {})}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>{run.functionName}</h3>
        <div className="mono" style={{ color: statusColor, marginBottom: 10 }}>
          {run.status === 'running' ? 'RUNNING…' : run.status.toUpperCase()}
          {run.status === 'preflight_failed' && <span className="hint" style={{ marginLeft: 10 }}>— nothing was changed</span>}
        </div>
        {run.steps.map(st => (
          <div key={st.index} className={'run-step ' + st.status}>
            <span className="run-icon">{STEP_ICON[st.status] || '·'}</span>
            <span><b>Step {st.index + 1}.</b> {st.label}</span>
            {st.detail && <div className="hint" style={{ marginLeft: 26 }}>{st.detail}</div>}
          </div>
        ))}
        {run.cancelReason && <div className="error-box">Cancelled: {run.cancelReason}</div>}
        {run.status !== 'running' && (
          <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
            <button onClick={onClose}>{t('action.close')}</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function FunctionsPage() {
  const confirm = useConfirm();
  const { t } = useI18n();
  const { can } = useAuth();
  const [fns, setFns] = useState([]);
  const [servers, setServers] = useState([]);
  const [runs, setRuns] = useState([]);
  const [builder, setBuilder] = useState(null);
  const [activeRun, setActiveRun] = useState(null);
  const [pickVariant, setPickVariant] = useState(null);
  const { push } = useToast();
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setFns(await api('/functions'));
      setServers(await api('/servers').catch(() => []));
      if (can('functions.execute')) setRuns(await api('/functions/runs').catch(() => []));
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  // A function with variants must not be runnable without choosing one:
  // running the wrong inputs is the failure this feature exists to prevent,
  // so the backend refuses too rather than trusting the UI to have asked.
  const run = async (fn, variantId = '') => {
    if ((fn.variants?.length || 0) > 0 && !variantId) { setPickVariant(fn); return; }
    const which = variantId ? fn.variants.find(v => v.id === variantId)?.name : '';
    if (!(await confirm(t('fn.confirmRun', { name: fn.name + (which ? ` · ${which}` : '') })))) return;
    try {
      const r = await api(`/functions/${fn._id}/run`, { method: 'POST', body: { variantId } });
      setPickVariant(null);
      setActiveRun(r.runId);
    } catch (e) { setError(e.message); setPickVariant(null); }
  };

  const remove = async (fn) => {
    if (!(await confirm(t('fn.confirmDelete', { name: fn.name })))) return;
    await api(`/functions/${fn._id}`, { method: 'DELETE' });
    load();
  };

  return (
    <div>
      <h1>{t('page.functions.title')}</h1>
      <div className="sub">Engineering macros: ordered transactional steps over WMSPanel-managed streams, with verification and automatic rollback.</div>
      {error && <div className="error-box">{error}</div>}
      {can('functions.manage') && (
        <button className="primary" style={{ marginBottom: 14 }} onClick={() => setBuilder({})}>+ {t('new.function')}</button>
      )}
      <div className="panel">
        <table>
          <thead><tr><th>{t('fn.name')}</th><th>{t('fn.description')}</th><th>{t('fn.steps')}</th><th></th></tr></thead>
          <tbody>
            {fns.map(fn => (
              <tr key={fn._id}>
                <td><b>{fn.name}</b></td>
                <td className="hint">{fn.description}</td>
                <td>{fn.steps.map((s, i) => <span key={i} className="badge" style={{ margin: '1px 3px 1px 0' }}>{s.label || s.type}</span>)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {can('functions.execute') && (
                    <button className="primary" onClick={() => run(fn)}>
                      {t('fn.run')}{fn.variants?.length ? ` (${fn.variants.length})` : ''}
                    </button>
                  )}{' '}
                  {can('functions.manage') && <><IconButton action="edit" onClick={() => setBuilder(fn)} />{' '}
                  <IconButton action="remove" danger onClick={() => remove(fn)} /></>}
                </td>
              </tr>
            ))}
            {fns.length === 0 && <tr><td colSpan={4} className="hint">{t('fn.noFunctions')}</td></tr>}
          </tbody>
        </table>
      </div>
      {can('functions.execute') && runs.length > 0 && (
        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>{t('fn.runHistory')}</h2>
            {/* The history is a log, not a record. The minimum age is enforced
                on the server, so this cannot be turned into "delete today". */}
            <div className="row" style={{ flexShrink: 0 }}>
              <button onClick={async () => {
                if (!(await confirm(t('fn.pruneConfirm')))) return;
                try {
                  const r = await api('/functions/runs?olderThanDays=3', { method: 'DELETE' });
                  push({ type: 'ok', message: t('fn.pruned', { n: r.deleted }) });
                  load();
                } catch (e) { setError(e.message); }
              }}>{t('fn.pruneRuns')}</button>
            </div>
          </div>
          <table>
            <thead><tr><th>{t('fn.function')}</th><th>{t('fn.by')}</th><th>{t('fn.started')}</th><th>{t('fn.status')}</th><th></th></tr></thead>
            <tbody>
              {runs.map(r => (
                <tr key={r._id}>
                  <td>{r.functionName}</td>
                  <td className="mono">{r.startedBy}</td>
                  <td className="hint">{new Date(r.startedAt).toLocaleString()}</td>
                  <td><span className={'lamp ' + (r.status === 'success' ? 'on' : r.status === 'running' ? 'warn' : 'off')} />{r.status}</td>
                  <td style={{ textAlign: 'right' }}><button onClick={() => setActiveRun(r._id)}>{t('fn.trace')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {builder && <Builder initial={builder} servers={servers}
                           onClose={() => setBuilder(null)} onSaved={() => { setBuilder(null); load(); }} />}
      {pickVariant && (
        <VariantPicker fn={pickVariant} onCancel={() => setPickVariant(null)}
                       onPick={(vid) => run(pickVariant, vid)} />
      )}
      {activeRun && <RunView runId={activeRun} onClose={() => { setActiveRun(null); load(); }} />}
    </div>
  );
}
