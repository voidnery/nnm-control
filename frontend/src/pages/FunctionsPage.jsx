import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { backdropClose } from '../components/Modal.jsx';
import Select from '../components/Select.jsx';
import { useI18n } from '../i18n.jsx';
import { useConfirm } from '../confirm.jsx';

const KINDS = [
  { value: 'republish', label: 'Republish rule' },
  { value: 'live_pull', label: 'RTMP live pull (feed reserve)' },
  { value: 'transcoder', label: 'Transcoder (account-level)' },
  { value: 'abr', label: 'ABR setting (account-level)' },
  { value: 'alias', label: 'Application alias (account-level)' },
  { value: 'udp',       label: 'UDP/SRT output (UDP streaming)' },
  { value: 'outgoing',  label: 'MPEGTS outgoing stream' },
  { value: 'hotswap',   label: 'Hot swap setting (Transcoder)' },
];

const PRESETS = [
  // Canonical WMSPanel field names (pinned from live account dump 2026-07-21)
  { label: 'Switch republish source', step: { type: 'patch', objectKind: 'republish', patch: { src_app: 'zagl_app', src_strm: 'zagl_stream' }, label: 'Switch republish source' } },
  { label: 'Switch SRT/UDP output source', step: { type: 'patch', objectKind: 'udp', patch: { source_streams: [{ application: 'zagl_app', stream: 'zagl_stream' }] }, label: 'Switch SRT/UDP source' } },
  { label: 'Patch outgoing stream',   step: { type: 'patch', objectKind: 'outgoing', patch: {}, label: 'Patch outgoing stream' } },
  { label: 'Подмена картинкой ON (hotswap)', step: { type: 'patch', objectKind: 'hotswap', patch: { emergency: true }, label: 'Substitute ON' } },
  { label: 'Подмена картинкой OFF (hotswap)', step: { type: 'patch', objectKind: 'hotswap', patch: { emergency: false }, label: 'Substitute OFF' } },
  { label: 'Pause outgoing',  step: { type: 'action', action: 'pause', label: 'Pause outgoing' } },
  { label: 'Resume outgoing', step: { type: 'action', action: 'resume', label: 'Resume outgoing' } },
  { label: 'Restart outgoing',step: { type: 'action', action: 'restart', label: 'Restart outgoing' } },
  { label: 'Live pull: switch source URL', step: { type: 'patch', objectKind: 'live_pull', patch: { url: 'rtmp://backup-host:1935/app/stream' }, label: 'Switch pull URL' } },
  { label: 'Restart live pull', step: { type: 'action', objectKind: 'live_pull', action: 'restart', label: 'Restart pull' } },
  { label: 'Подмена: pause transcoder', step: { type: 'action', objectKind: 'transcoder', action: 'pause', label: 'Pause transcoder' } },
  { label: 'Подмена: resume transcoder', step: { type: 'action', objectKind: 'transcoder', action: 'resume', label: 'Resume transcoder' } },
  { label: 'Delay (seconds)', step: { type: 'delay', waitSec: 10, label: 'Delay' } },
];

function ObjectPicker({ servers, step, onPick }) {
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
  const labelOf = (o) =>
    o.src_app !== undefined ? `${o.src_app}/${o.src_strm || '*'} → ${o.dest_addr || ''}` :
    o.source_streams !== undefined ? `${headOf(o)} ⇐ ${(o.source_streams[0]?.application || '?')}/${(o.source_streams[0]?.stream || '?')}` :
    o.original_app !== undefined ? `${o.original_app}/${o.original_stream} → ${o.substitute_app}/${o.substitute_stream}${o.emergency ? ' [EMERGENCY]' : ''}` :
    (o.name !== undefined && o.paused !== undefined && o.server_id !== undefined) ? `${o.name}${o.paused ? ' [paused]' : ' [running]'}` :
    o.application !== undefined ? `${o.application}/${o.stream || ''}${o.status ? ' · ' + o.status : ''}` :
    o.name || o.protocol || '';
  const describe = (o) => `${String(o.id).slice(-6)} · ${labelOf(o)}`;
  return (
    <div style={{ marginTop: 6 }}>
      <button className={objects ? 'active' : ''}
              disabled={!step.serverId && !['transcoder', 'abr', 'alias'].includes(step.objectKind)}
              onClick={load}>{objects ? 'Hide objects' : 'Browse objects…'}</button>
      {error && <div className="error-box">{error}</div>}
      {objects && (
        <div className="panel" style={{ marginTop: 6, padding: 8 }}>
          <input autoFocus placeholder="Filter…" value={q} onChange={e => setQ(e.target.value)} style={{ marginBottom: 6 }} />
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
            {objects.length === 0 && <span className="hint">No objects of this kind on the server.</span>}
          </div>
          <div className="row" style={{ marginTop: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => setObjects(null)}>Close</button>
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

function StepEditor({ step, servers, onChange, onRemove }) {
  const set = (k, v) => onChange({ ...step, [k]: v });
  const [patchText, setPatchText] = useState(JSON.stringify(step.patch || {}, null, 0));
  const [patchErr, setPatchErr] = useState('');
  const [live, setLive] = useState(null);        // { streams, source }
  const [liveErr, setLiveErr] = useState('');
  const [pick, setPick] = useState('');          // "app/stream"
  const [pairKind, setPairKind] = useState(defaultPairFor(step.objectKind));
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
  return (
    <div className="panel" style={{ padding: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <input style={{ maxWidth: 260 }} value={step.label} placeholder="Step label"
               onChange={e => set('label', e.target.value)} />
        <span className="badge">{step.type}{step.objectKind ? ':' + step.objectKind : ''}{step.action ? ':' + step.action : ''}</span>
        <button className="danger" onClick={onRemove}>Remove</button>
      </div>
      {step.type === 'action' && (
        <>
          <label>Action target kind</label>
          <Select value={step.objectKind || 'outgoing'} onChange={v => set('objectKind', v === 'outgoing' ? '' : v)}
                  options={[
                    { value: 'outgoing', label: 'MPEGTS outgoing (pause/resume/restart)' },
                    { value: 'live_pull', label: 'RTMP live pull (restart only)' },
                    { value: 'transcoder', label: 'Transcoder (pause/resume; no server needed)' },
                  ]} />
        </>
      )}
      {step.type !== 'delay' && (
        <>
          <label>Server</label>
          <Select value={step.serverId || ''} onChange={v => set('serverId', v)} searchable
                  options={[{ value: '', label: '— select —' }, ...servers.map(s => ({ value: s.id, label: s.name }))]} />
          {step.type === 'patch' && (
            <>
              <label>Object kind</label>
              <Select value={step.objectKind} onChange={v => set('objectKind', v)}
                      options={KINDS.map(k => ({ value: k.value, label: k.label }))} />
            </>
          )}
          <label>Target object id</label>
          <input className="mono" value={step.targetId || ''} onChange={e => set('targetId', e.target.value)} />
          <ObjectPicker servers={servers} step={step} onPick={(o, label) => { set('targetId', String(o.id)); set('targetLabel', label); }} />
          {step.targetLabel && (
            <div className="picked-row">
              <span className="picked-tag">Selected</span>
              <b className="mono picked-val">{step.targetLabel}</b>
            </div>
          )}
          {step.type === 'patch' && (
            <>
              <label>Source picker (apps/streams on the selected server)</label>
              <div className="row">
                <button disabled={!step.serverId} onClick={loadLive}>Load streams</button>
                {live && <span className="hint">{live.streams.length} found ({live.source === 'wmspanel-streams' ? 'active streams' : 'from configured objects'})</span>}
              </div>
              {liveErr && <div className="error-box">{liveErr}</div>}
              {live && (
                <div className="row" style={{ marginTop: 6 }}>
                  <div style={{ flex: 2 }}>
                    <Select value={pick} onChange={setPick} searchable placeholder="app/stream…"
                            options={live.streams.map(st => ({ value: `${st.app}/${st.stream}`, label: `${st.app}/${st.stream}` }))} />
                  </div>
                  <div style={{ flex: 3 }}>
                    <Select value={pairKind} onChange={setPairKind}
                            options={KEY_PAIRS.map(k => ({ value: k.value, label: k.label }))} />
                  </div>
                  <button disabled={!pick.includes('/')} onClick={insertPick}>Insert</button>
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
          <label>Wait (seconds)</label>
          <input type="number" value={step.waitSec || 0} onChange={e => set('waitSec', Number(e.target.value))} />
        </>
      )}
    </div>
  );
}

function Builder({ initial, servers, onClose, onSaved }) {
  const { user } = useAuth();
  const backDown = useRef(false);
  const w = user?.preferences?.functionModalWidth || 'default';
  const widthClass = w === 'default' ? '' : 'w-' + w;
  const isEdit = Boolean(initial._id);
  const [name, setName] = useState(initial.name || '');
  const [description, setDescription] = useState(initial.description || '');
  const [steps, setSteps] = useState(initial.steps || []);
  const [error, setError] = useState('');

  const addPreset = (preset) => setSteps(st => [...st, { serverId: '', targetId: '', waitSec: 0, ...JSON.parse(JSON.stringify(preset.step)) }]);
  const save = async () => {
    setError('');
    try {
      const body = { name, description, steps };
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
        <label>Name</label>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Подмена потоков картинкой" />
        <label>Description</label>
        <input value={description} onChange={e => setDescription(e.target.value)} />
        <label>Steps (executed in order; on failure everything rolls back in reverse)</label>
        {steps.map((st, i) => (
          <StepEditor key={i} step={st} servers={servers}
                      onChange={next => setSteps(all => all.map((s, j) => j === i ? next : s))}
                      onRemove={() => setSteps(all => all.filter((_, j) => j !== i))} />
        ))}
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {PRESETS.map(p => <button key={p.label} onClick={() => addPreset(p)}>+ {p.label}</button>)}
        </div>
        {error && <div className="error-box">{error}</div>}
        <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!name || steps.length === 0} onClick={save}>Save</button>
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
            <button onClick={onClose}>Close</button>
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
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setFns(await api('/functions'));
      setServers(await api('/servers').catch(() => []));
      if (can('functions.execute')) setRuns(await api('/functions/runs').catch(() => []));
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const run = async (fn) => {
    if (!(await confirm(`Execute function "${fn.name}"? Steps will apply and verify sequentially; any failure rolls everything back.`))) return;
    try {
      const r = await api(`/functions/${fn._id}/run`, { method: 'POST' });
      setActiveRun(r.runId);
    } catch (e) { setError(e.message); }
  };

  const remove = async (fn) => {
    if (!(await confirm(`Delete function "${fn.name}"?`))) return;
    await api(`/functions/${fn._id}`, { method: 'DELETE' });
    load();
  };

  return (
    <div>
      <h1>{t('page.functions.title')}</h1>
      <div className="sub">Engineering macros: ordered transactional steps over WMSPanel-managed streams, with verification and automatic rollback.</div>
      {error && <div className="error-box">{error}</div>}
      {can('functions.manage') && (
        <button className="primary" style={{ marginBottom: 14 }} onClick={() => setBuilder({})}>+ New function</button>
      )}
      <div className="panel">
        <table>
          <thead><tr><th>Name</th><th>Description</th><th>Steps</th><th></th></tr></thead>
          <tbody>
            {fns.map(fn => (
              <tr key={fn._id}>
                <td><b>{fn.name}</b></td>
                <td className="hint">{fn.description}</td>
                <td>{fn.steps.map((s, i) => <span key={i} className="badge" style={{ margin: '1px 3px 1px 0' }}>{s.label || s.type}</span>)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {can('functions.execute') && <button className="primary" onClick={() => run(fn)}>Run</button>}{' '}
                  {can('functions.manage') && <><button onClick={() => setBuilder(fn)}>Edit</button>{' '}
                  <button className="danger" onClick={() => remove(fn)}>Delete</button></>}
                </td>
              </tr>
            ))}
            {fns.length === 0 && <tr><td colSpan={4} className="hint">No functions yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {can('functions.execute') && runs.length > 0 && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Run history</h2>
          <table>
            <thead><tr><th>Function</th><th>By</th><th>Started</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {runs.map(r => (
                <tr key={r._id}>
                  <td>{r.functionName}</td>
                  <td className="mono">{r.startedBy}</td>
                  <td className="hint">{new Date(r.startedAt).toLocaleString()}</td>
                  <td><span className={'lamp ' + (r.status === 'success' ? 'on' : r.status === 'running' ? 'warn' : 'off')} />{r.status}</td>
                  <td style={{ textAlign: 'right' }}><button onClick={() => setActiveRun(r._id)}>Trace</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {builder && <Builder initial={builder} servers={servers}
                           onClose={() => setBuilder(null)} onSaved={() => { setBuilder(null); load(); }} />}
      {activeRun && <RunView runId={activeRun} onClose={() => { setActiveRun(null); load(); }} />}
    </div>
  );
}
