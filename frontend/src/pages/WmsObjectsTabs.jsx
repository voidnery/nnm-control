import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { backdropClose } from '../components/Modal.jsx';
import Select from '../components/Select.jsx';
import { useConfirm } from '../confirm.jsx';

// WMSPanel stream-object tabs (canonical schemas pinned from the live dump):
// - UDP/SRT outputs: source_streams[{application, stream, pmt/video/audio pid}]
// - MPEGTS outgoing: application/stream + native delivery status ('synced')
// - Hot swap: original/substitute pairs + emergency toggle
// Manual edits here are direct PUTs; WMSPanel delivers them to Nimble on its
// ~30s sync cycle — use Refresh to observe.

function useObjects(serverId, kind) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = async () => {
    setError('');
    try { setData(await api(`/wmspanel/server/${serverId}/${kind}`)); }
    catch (e) { setError(e.message); setData({}); }
  };
  useEffect(() => { load(); }, [serverId]);
  return { data, error, setError, load };
}

const SyncNote = () => (
  <div className="hint" style={{ marginBottom: 10 }}>
    Changes are delivered to the Nimble instance on WMSPanel's ~30s sync cycle — hit Refresh to observe.
  </div>
);

// ---------------------------------------------------------------- UDP / SRT
export function UdpTab({ serverId }) {
  const confirm = useConfirm();
  const { can } = useAuth();
  const { data, error, setError, load } = useObjects(serverId, 'udp');
  const [incoming, setIncoming] = useState([]);
  const [edit, setEdit] = useState(null); // { id, name, mode: 'incoming'|'streams', source_id, sources: [...] }
  const [busy, setBusy] = useState(false);
  const settings = data?.settings || [];

  useEffect(() => {
    // source_id values reference MPEGTS incoming streams — resolve to names
    api(`/wmspanel/server/${serverId}/incoming`).then(d => setIncoming(d.streams || [])).catch(() => setIncoming([]));
  }, [serverId]);
  const incomingName = (id) => incoming.find(x => String(x.id) === String(id))?.name || String(id || '').slice(-6);

  const openEdit = (o) => setEdit({
    id: o.id, name: o.name || o.id,
    mode: o.source_id ? 'incoming' : 'streams',
    source_id: o.source_id || '',
    sources: (o.source_streams || []).map(ss => ({ ...ss })),
  });

  const [cfgModal, setCfgModal] = useState(null); // create or settings-edit
  const openCfg = (o) => setCfgModal(o ? {
    id: o.id, name: o.name || '', description: o.description || '',
    protocol: o.protocol || 'srt', ip: o.ip || '', port: o.port || 10000,
    ttl: o.ttl ?? 1,
    parameters: Object.keys(o.parameters || {}).length ? JSON.stringify(o.parameters) : '',
  } : { name: '', description: '', protocol: 'srt', ip: '0.0.0.0', port: 10000, ttl: 1, parameters: '' });
  const saveCfg = async () => {
    setBusy(true); setError('');
    const body = {
      name: cfgModal.name, description: cfgModal.description,
      protocol: cfgModal.protocol, ip: cfgModal.ip, port: Number(cfgModal.port), ttl: Number(cfgModal.ttl),
    };
    try {
      if (cfgModal.parameters?.trim()) body.parameters = JSON.parse(cfgModal.parameters);
      if (cfgModal.id) await api(`/wmspanel/server/${serverId}/udp/${cfgModal.id}`, { method: 'PUT', body });
      else await api(`/wmspanel/server/${serverId}/udp`, { method: 'POST', body });
      setCfgModal(null); await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const removeUdp = async (o) => {
    if (!(await confirm(`Delete SRT/UDP output "${o.name || o.id}" (${o.ip}:${o.port})?`))) return;
    setBusy(true); setError('');
    try { await api(`/wmspanel/server/${serverId}/udp/${o.id}`, { method: 'DELETE' }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true); setError('');
    try {
      // Two source modes (from live data: 604/755 outputs use source_id -> an
      // MPEGTS incoming stream; 151 use source_streams app/stream entries).
      // We send ONLY the chosen mode's field. Existing entries keep their
      // PIDs; newly added ones get PIDs assigned by WMSPanel.
      const body = edit.mode === 'incoming'
        ? { source_id: edit.source_id }
        : { source_streams: edit.sources.filter(x => x.application && x.stream) };
      await api(`/wmspanel/server/${serverId}/udp/${edit.id}`, { method: 'PUT', body });
      setEdit(null); await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const togglePause = async (o) => {
    setBusy(true); setError('');
    try {
      await api(`/wmspanel/server/${serverId}/udp/${o.id}`, { method: 'PUT', body: { paused: !o.paused } });
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!data) return <div className="hint">Loading…</div>;
  return (
    <div>
      <SyncNote />
      {error && <div className="error-box">{error}</div>}
      <div className="panel">
        <table>
          <thead><tr><th>Name</th><th>Proto</th><th>Destination</th><th>Source</th><th>State</th><th></th></tr></thead>
          <tbody>
            {settings.map(o => (
              <tr key={o.id}>
                <td><b>{o.name || String(o.id).slice(-6)}</b>{o.description && <div className="hint">{o.description}</div>}</td>
                <td><span className="badge">{o.protocol}</span></td>
                <td className="mono">{o.ip}:{o.port}</td>
                <td className="mono">
                  {o.source_id
                    ? <><span className="badge" style={{ marginRight: 4 }}>in</span>{incomingName(o.source_id)}</>
                    : (o.source_streams || []).length
                      ? (o.source_streams || []).map((ss, i) => <div key={i}>{ss.application}/{ss.stream}</div>)
                      : <span className="hint">— no source —</span>}
                </td>
                <td><span className={'lamp ' + (o.paused ? 'off' : 'on')} />{o.paused ? 'paused' : 'active'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {can('wmsobjects.manage') && <>
                    <button disabled={busy} onClick={() => openEdit(o)}>Edit source</button>{' '}
                    <button disabled={busy} onClick={() => openCfg(o)}>Settings</button>{' '}
                    <button disabled={busy} onClick={() => togglePause(o)}>{o.paused ? 'Resume' : 'Pause'}</button>{' '}
                    <button className="danger" disabled={busy} onClick={() => removeUdp(o)}>Delete</button>
                  </>}
                </td>
              </tr>
            ))}
            {settings.length === 0 && <tr><td colSpan={6} className="hint">No UDP/SRT outputs on this server.</td></tr>}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={load} disabled={busy}>Refresh</button>
          {can('wmsobjects.manage') && <button className="primary" disabled={busy} onClick={() => openCfg(null)}>+ New output</button>}
        </div>
      </div>
      {cfgModal && (
        <div className="modal-back" {...backdropClose(() => setCfgModal(null))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{cfgModal.id ? `Settings of ${cfgModal.name}` : 'New SRT/UDP output'}</h3>
            <label>Name</label>
            <input value={cfgModal.name} onChange={e => setCfgModal(m => ({ ...m, name: e.target.value }))} />
            <label>Description</label>
            <input value={cfgModal.description} onChange={e => setCfgModal(m => ({ ...m, description: e.target.value }))} />
            <div className="field-inline">
              <div>
                <label>Protocol</label>
                <Select value={cfgModal.protocol} onChange={v => setCfgModal(m => ({ ...m, protocol: v }))}
                        options={['srt', 'udp', 'rist'].map(x => ({ value: x, label: x }))} />
              </div>
              <div><label>TTL</label><input type="number" value={cfgModal.ttl} onChange={e => setCfgModal(m => ({ ...m, ttl: e.target.value }))} /></div>
            </div>
            <div className="field-inline">
              <div><label>IP</label><input className="mono" value={cfgModal.ip} onChange={e => setCfgModal(m => ({ ...m, ip: e.target.value }))} /></div>
              <div><label>Port</label><input type="number" value={cfgModal.port} onChange={e => setCfgModal(m => ({ ...m, port: e.target.value }))} /></div>
            </div>
            <label>Parameters (JSON, e.g. {'{"latency":"1000","maxbw":"0"}'})</label>
            <input className="mono" value={cfgModal.parameters} onChange={e => setCfgModal(m => ({ ...m, parameters: e.target.value }))} />
            {!cfgModal.id && <div className="hint" style={{ marginTop: 6 }}>Source is set after creation via "Edit source".</div>}
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setCfgModal(null)}>Cancel</button>
              <button className="primary" disabled={busy || !cfgModal.name || !cfgModal.ip || !cfgModal.port} onClick={saveCfg}>
                {cfgModal.id ? 'Apply' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
      {edit && (
        <div className="modal-back" {...backdropClose(() => setEdit(null))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Source of {edit.name}</h3>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="radio" style={{ width: 'auto' }} checked={edit.mode === 'incoming'}
                     onChange={() => setEdit(m => ({ ...m, mode: 'incoming' }))} />
              MPEGTS incoming stream (raw passthrough)
            </label>
            {edit.mode === 'incoming' && (
              <Select value={edit.source_id} onChange={v => setEdit(m => ({ ...m, source_id: v }))} searchable
                      options={[{ value: '', label: '— select incoming stream —' }, ...incoming.map(x => ({ value: x.id, label: `${x.name} (${x.protocol}, ${x.status})` }))]} />
            )}
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <input type="radio" style={{ width: 'auto' }} checked={edit.mode === 'streams'}
                     onChange={() => setEdit(m => ({ ...m, mode: 'streams' }))} />
              Application/stream entries (remux)
            </label>
            {edit.mode === 'streams' && (
              <>
                {edit.sources.map((ss, i) => (
                  <div key={i} className="panel" style={{ padding: 10 }}>
                    <div className="row">
                      <input placeholder="application" value={ss.application || ''} onChange={e =>
                        setEdit(m => ({ ...m, sources: m.sources.map((x, j) => j === i ? { ...x, application: e.target.value } : x) }))} />
                      <input placeholder="stream" value={ss.stream || ''} onChange={e =>
                        setEdit(m => ({ ...m, sources: m.sources.map((x, j) => j === i ? { ...x, stream: e.target.value } : x) }))} />
                      <button onClick={() => setEdit(m => ({ ...m, sources: m.sources.filter((_, j) => j !== i) }))}>×</button>
                    </div>
                    <div className="hint mono">
                      PIDs: {ss.pmt_pid !== undefined ? `pmt=${ss.pmt_pid} video=${ss.video_pid} audio=${ss.audio_pid} (preserved)` : 'assigned by WMSPanel on create'}
                    </div>
                  </div>
                ))}
                <button onClick={() => setEdit(m => ({ ...m, sources: [...m.sources, { application: '', stream: '' }] }))}>+ add entry</button>
              </>
            )}
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setEdit(null)}>Cancel</button>
              <button className="primary" onClick={save}
                      disabled={busy || (edit.mode === 'incoming' ? !edit.source_id : edit.sources.filter(x => x.application && x.stream).length === 0)}>
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- Outgoing
export function OutgoingTab({ serverId }) {
  const confirm = useConfirm();
  const { can } = useAuth();
  const { data, error, setError, load } = useObjects(serverId, 'outgoing');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null); // create/edit
  const [incoming, setIncoming] = useState([]);
  const streams = data?.streams || [];

  useEffect(() => {
    // source picker options (id -> name) for video/audio sources
    api(`/wmspanel/server/${serverId}/incoming`).then(d => setIncoming(d.streams || [])).catch(() => setIncoming([]));
  }, [serverId]);

  const save = async () => {
    setBusy(true); setError('');
    const body = {
      application: modal.application, stream: modal.stream,
      description: modal.description || '',
    };
    if (modal.video_source) body.video_source = { id: modal.video_source };
    if (modal.audio_source) body.audio_source = { id: modal.audio_source };
    try {
      if (modal.id) await api(`/wmspanel/server/${serverId}/outgoing/${modal.id}`, { method: 'PUT', body });
      else await api(`/wmspanel/server/${serverId}/outgoing`, { method: 'POST', body });
      setModal(null); await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const remove = async (o) => {
    if (!(await confirm(`Delete outgoing ${o.application}/${o.stream}?`))) return;
    setBusy(true); setError('');
    try { await api(`/wmspanel/server/${serverId}/outgoing/${o.id}`, { method: 'DELETE' }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const srcName = (ref) => {
    if (!ref?.id) return '';
    const src = incoming.find(x => String(x.id) === String(ref.id));
    return src ? src.name : String(ref.id).slice(-6);
  };

  const act = async (o, action) => {
    setBusy(true); setError('');
    try { await api(`/wmspanel/server/${serverId}/outgoing/${o.id}/${action}`, { method: 'POST' }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!data) return <div className="hint">Loading…</div>;
  return (
    <div>
      <SyncNote />
      {error && <div className="error-box">{error}</div>}
      <div className="panel">
        <table>
          <thead><tr><th>Output</th><th>Delivery</th><th>State</th><th></th></tr></thead>
          <tbody>
            {streams.map(o => (
              <tr key={o.id}>
                <td className="mono"><b>{o.application}/{o.stream}</b>{o.description && <div className="hint">{o.description}</div>}</td>
                <td>
                  <span className={'lamp ' + (o.status === 'synced' ? 'on' : 'warn')} />
                  {o.status || '—'}
                  <div className="hint">src: {srcName(o.video_source) || '—'}{o.audio_source?.id && o.audio_source.id !== o.video_source?.id ? ' / ' + srcName(o.audio_source) : ''}</div>
                </td>
                <td>{String(o.paused) === 'true' ? 'paused' : 'active'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {can('wmsobjects.manage') && <>
                    {String(o.paused) === 'true'
                      ? <button disabled={busy} onClick={() => act(o, 'resume')}>Resume</button>
                      : <button disabled={busy} onClick={() => act(o, 'pause')}>Pause</button>}{' '}
                    <button disabled={busy} onClick={() => act(o, 'restart')}>Restart</button>{' '}
                    <button disabled={busy} onClick={() => setModal({
                      id: o.id, application: o.application, stream: o.stream,
                      description: o.description || '',
                      video_source: o.video_source?.id || '', audio_source: o.audio_source?.id || '',
                    })}>Edit</button>{' '}
                    <button className="danger" disabled={busy} onClick={() => remove(o)}>Delete</button>
                  </>}
                </td>
              </tr>
            ))}
            {streams.length === 0 && <tr><td colSpan={4} className="hint">No MPEGTS outgoing streams on this server.</td></tr>}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={load} disabled={busy}>Refresh</button>
          {can('wmsobjects.manage') && (
            <button className="primary" disabled={busy}
                    onClick={() => setModal({ application: '', stream: '', description: '', video_source: '', audio_source: '' })}>
              + New outgoing
            </button>
          )}
        </div>
      </div>
      {modal && (
        <div className="modal-back" {...backdropClose(() => setModal(null))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{modal.id ? `Edit ${modal.application}/${modal.stream}` : 'New outgoing stream'}</h3>
            <div className="field-inline">
              <div><label>Application</label><input value={modal.application} onChange={e => setModal(m => ({ ...m, application: e.target.value }))} /></div>
              <div><label>Stream</label><input value={modal.stream} onChange={e => setModal(m => ({ ...m, stream: e.target.value }))} /></div>
            </div>
            <label>Description</label>
            <input value={modal.description} onChange={e => setModal(m => ({ ...m, description: e.target.value }))} />
            <label>Video source (incoming stream)</label>
            <Select value={modal.video_source} onChange={v => setModal(m => ({ ...m, video_source: v }))} searchable
                    options={[{ value: '', label: '— keep / none —' }, ...incoming.map(x => ({ value: x.id, label: `${x.name} (${x.status})` }))]} />
            <label>Audio source (incoming stream)</label>
            <Select value={modal.audio_source} onChange={v => setModal(m => ({ ...m, audio_source: v }))} searchable
                    options={[{ value: '', label: '— same as video / none —' }, ...incoming.map(x => ({ value: x.id, label: `${x.name} (${x.status})` }))]} />
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setModal(null)}>Cancel</button>
              <button className="primary" disabled={busy || !modal.application || !modal.stream} onClick={save}>
                {modal.id ? 'Apply' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Hotswap
export function HotswapTab({ serverId }) {
  const confirm = useConfirm();
  const { can } = useAuth();
  const { data, error, setError, load } = useObjects(serverId, 'hotswap');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editModal, setEditModal] = useState(null);
  const [form, setForm] = useState({ original_app: '', original_stream: '', substitute_app: '', substitute_stream: '' });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const settings = data?.settings || [];

  const put = async (o, patch) => {
    setBusy(true); setError('');
    try { await api(`/wmspanel/server/${serverId}/hotswap/${o.id}`, { method: 'PUT', body: patch }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const create = async () => {
    setBusy(true); setError('');
    try {
      await api(`/wmspanel/server/${serverId}/hotswap`, { method: 'POST', body: { ...form, emergency: false, paused: false } });
      setCreating(false);
      setForm({ original_app: '', original_stream: '', substitute_app: '', substitute_stream: '' });
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const remove = async (o) => {
    if (!(await confirm(`Delete hot swap ${o.original_app}/${o.original_stream}?`))) return;
    setBusy(true); setError('');
    try { await api(`/wmspanel/server/${serverId}/hotswap/${o.id}`, { method: 'DELETE' }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!data) return <div className="hint">Loading…</div>;
  return (
    <div>
      <div className="hint" style={{ marginBottom: 10 }}>
        Hot swap = картинка-подмена на стороне Nimble: при включённом <b>EMERGENCY</b> viewers получают
        substitute-поток вместо оригинала; выключение возвращает оригинал. Правила и выходы не трогаются.
      </div>
      {error && <div className="error-box">{error}</div>}
      <div className="panel">
        <table>
          <thead><tr><th>Original</th><th>Substitute</th><th>Emergency</th><th>State</th><th></th></tr></thead>
          <tbody>
            {settings.map(o => (
              <tr key={o.id} style={o.emergency ? { background: '#2a1416' } : undefined}>
                <td className="mono"><b>{o.original_app}/{o.original_stream}</b></td>
                <td className="mono">{o.substitute_app}/{o.substitute_stream}</td>
                <td>
                  <span className={'lamp ' + (o.emergency ? 'off' : 'on')} />
                  {o.emergency ? 'SUBSTITUTE ACTIVE' : 'original on air'}
                </td>
                <td>{o.paused ? 'paused' : 'armed'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {can('wmsobjects.manage') && <>
                    <button className={o.emergency ? 'primary' : 'danger'} disabled={busy}
                            onClick={() => put(o, { emergency: !o.emergency })}>
                      {o.emergency ? 'Back to original' : 'EMERGENCY ON'}
                    </button>{' '}
                    <button disabled={busy} onClick={() => setEditModal({
                      id: o.id, original_app: o.original_app, original_stream: o.original_stream,
                      substitute_app: o.substitute_app, substitute_stream: o.substitute_stream,
                      paused: Boolean(o.paused),
                    })}>Edit</button>{' '}
                    <button className="danger" disabled={busy} onClick={() => remove(o)}>Delete</button>
                  </>}
                </td>
              </tr>
            ))}
            {settings.length === 0 && <tr><td colSpan={5} className="hint">No hot swap settings on this server.</td></tr>}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={load} disabled={busy}>Refresh</button>
          {can('wmsobjects.manage') && <button onClick={() => setCreating(v => !v)}>{creating ? 'Close form' : '+ New hot swap'}</button>}
        </div>
      </div>
      {creating && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>New hot swap</h2>
          <div className="field-inline">
            <div><label>Original app</label><input value={form.original_app} onChange={e => set('original_app', e.target.value)} /></div>
            <div><label>Original stream</label><input value={form.original_stream} onChange={e => set('original_stream', e.target.value)} /></div>
          </div>
          <div className="field-inline">
            <div><label>Substitute app</label><input value={form.substitute_app} onChange={e => set('substitute_app', e.target.value)} /></div>
            <div><label>Substitute stream</label><input value={form.substitute_stream} onChange={e => set('substitute_stream', e.target.value)} /></div>
          </div>
          <button className="primary" style={{ marginTop: 12 }}
                  disabled={busy || !form.original_app || !form.original_stream || !form.substitute_app || !form.substitute_stream}
                  onClick={create}>{busy ? 'Creating…' : 'Create (created disarmed)'}</button>
        </div>
      )}
      {editModal && (
        <div className="modal-back" {...backdropClose(() => setEditModal(null))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Edit hot swap</h3>
            <div className="field-inline">
              <div><label>Original app</label><input value={editModal.original_app} onChange={e => setEditModal(m => ({ ...m, original_app: e.target.value }))} /></div>
              <div><label>Original stream</label><input value={editModal.original_stream} onChange={e => setEditModal(m => ({ ...m, original_stream: e.target.value }))} /></div>
            </div>
            <div className="field-inline">
              <div><label>Substitute app</label><input value={editModal.substitute_app} onChange={e => setEditModal(m => ({ ...m, substitute_app: e.target.value }))} /></div>
              <div><label>Substitute stream</label><input value={editModal.substitute_stream} onChange={e => setEditModal(m => ({ ...m, substitute_stream: e.target.value }))} /></div>
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={editModal.paused}
                     onChange={e => setEditModal(m => ({ ...m, paused: e.target.checked }))} /> Paused (disarmed)
            </label>
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setEditModal(null)}>Cancel</button>
              <button className="primary" disabled={busy} onClick={async () => {
                const { id, ...body } = editModal;
                await put({ id }, body);
                setEditModal(null);
              }}>Apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- Live streams
// Confirmed endpoint /server/{sid}/live/streams — the same data WMSPanel
// shows in "Живые потоки": all protocols, codecs, resolution, bandwidth,
// publisher IP and publish time. 1 API call per refresh.
const fmtUptime = (ts) => {
  if (!ts) return '—';
  let sec = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  const d = Math.floor(sec / 86400); sec %= 86400;
  const h = Math.floor(sec / 3600); sec %= 3600;
  const m = Math.floor(sec / 60);
  return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm';
};

export function WmsStreamsTab({ serverId }) {
  const confirm = useConfirm();
  const { can } = useAuth();
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [auto, setAuto] = useState(false);
  const [loadedAt, setLoadedAt] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError('');
    try {
      setData(await api(`/wmspanel/server/${serverId}/streams`));
      setLoadedAt(new Date());
    } catch (e) {
      setError(e.message + (e.data?.upstream ? ' :: ' + JSON.stringify(e.data.upstream) : ''));
      setData({ streams: [] });
    }
  };
  useEffect(() => { load(); }, [serverId]);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [auto, serverId]);

  // Live/running streams cannot be deleted (matches WMSPanel). Only DOWN
  // (offline) entries can be cleared, exactly like "Живые потоки".
  const downStreams = (data?.streams || []).filter(st => st.status !== 'online');
  const deleteAllDown = async () => {
    if (downStreams.length === 0) return;
    if (!(await confirm(`Remove ${downStreams.length} offline stream(s) from the list? Running streams are untouched.`))) return;
    setBusy(true); setError('');
    try {
      for (const st of downStreams) {
        try { await api(`/wmspanel/server/${serverId}/streams/${st.id}`, { method: 'DELETE' }); } catch { /* skip individual */ }
      }
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!data) return <div className="hint">Loading…</div>;
  const q = filter.trim().toLowerCase();
  const list = (data.streams || []).filter(st =>
    !q || (st.application + '/' + st.stream + ' ' + (st.description || '') + ' ' + (st.tags || []).join(' ')).toLowerCase().includes(q));
  const byApp = {};
  for (const st of list) (byApp[st.application || '?'] ||= []).push(st);

  return (
    <div>
      <div className="row" style={{ marginBottom: 10, alignItems: 'center' }}>
        <input style={{ maxWidth: 280 }} placeholder="Filter app/stream/tag…" value={filter} onChange={e => setFilter(e.target.value)} />
        <button onClick={load} disabled={busy}>{t('action.refresh')}</button>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
          <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />
          Auto (30s)
        </label>
        {can('wmsobjects.manage') && (
          <button disabled={busy || downStreams.length === 0} onClick={deleteAllDown}>
            Delete all down streams{downStreams.length ? ` (${downStreams.length})` : ''}
          </button>
        )}
        <span className="hint" style={{ marginLeft: 'auto' }}>
          {list.length} of {(data.streams || []).length} streams
          {loadedAt && <> · loaded {loadedAt.toLocaleTimeString()}</>}
        </span>
      </div>
      {error && <div className="error-box">{error}</div>}
      {Object.entries(byApp).sort(([a], [b]) => a.localeCompare(b)).map(([app, streams]) => (
        <div className="panel" key={app}>
          <h2 style={{ marginTop: 0 }}>{app} <span className="hint">({streams.length})</span></h2>
          <table>
            <thead><tr><th>Stream</th><th>Proto</th><th>Codecs</th><th>Res</th><th>Bitrate</th><th>Publisher</th><th>Uptime</th></tr></thead>
            <tbody>
              {streams.sort((a, b) => String(a.stream).localeCompare(String(b.stream))).map(st => (
                <tr key={st.id}>
                  <td className="mono">
                    <span className={'lamp ' + (st.status === 'online' ? 'on' : 'off')} /><b>{st.stream}</b>
                    {(st.tags || []).map(t => <span key={t} className="badge" style={{ marginLeft: 4 }}>{t}</span>)}
                    {st.description && <div className="hint">{st.description}</div>}
                  </td>
                  <td><span className="badge">{st.protocol}</span></td>
                  <td className="hint mono">{[st.video_codec, st.audio_codec].filter(Boolean).join(' / ') || '—'}</td>
                  <td className="mono">{st.resolution || '—'}</td>
                  <td className="mono">{st.bandwidth ? (st.bandwidth / 1e6).toFixed(1) + ' Mbps' : '—'}</td>
                  <td className="mono hint">{st.publisher_ip || '—'}</td>
                  <td className="mono">{st.status === 'online' ? fmtUptime(st.publish_time) : '—'}</td>

                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {list.length === 0 && !error && <div className="panel hint">No live streams{q ? ' matching the filter' : ''}.</div>}
    </div>
  );
}

// ------------------------------------------------------------- MPEGTS In
// Settings editor for "MPEGTS на вход" (schema pinned from live dump) with
// telemetry: status lamp, bandwidth, codecs parsed from PMT/PIDs. This is a
// SETTINGS view, not the full "Живые потоки" aggregate (that one covers all
// protocols + codecs/uptime and needs a dedicated API — being pinned via the
// probe dump).
const fmtMbps = (b) => (b ? (b / 1e6).toFixed(2) + ' Mbps' : '—');
const codecsOf = (o) => {
  const types = (o.pmts || []).flatMap(p => (p.pids || []).map(x => x.type)).filter(Boolean);
  return [...new Set(types)].join(', ');
};

export function MpegtsInTab({ serverId }) {
  const confirm = useConfirm();
  const { can } = useAuth();
  const { data, error, setError, load } = useObjects(serverId, 'incoming');
  const [filter, setFilter] = useState('');
  const [modal, setModal] = useState(null); // {} for create, object for edit
  const [busy, setBusy] = useState(false);
  const streams = (data?.streams || []).filter(o =>
    !filter || (o.name + ' ' + (o.description || '')).toLowerCase().includes(filter.toLowerCase()));

  const save = async () => {
    setBusy(true); setError('');
    const body = {
      name: modal.name, description: modal.description || '',
      protocol: modal.protocol, ip: modal.ip, port: Number(modal.port),
      receive_mode: modal.receive_mode,
    };
    try {
      if (modal.parameters?.trim()) body.parameters = JSON.parse(modal.parameters);
      if (modal.id) await api(`/wmspanel/server/${serverId}/incoming/${modal.id}`, { method: 'PUT', body });
      else await api(`/wmspanel/server/${serverId}/incoming`, { method: 'POST', body });
      setModal(null); await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const remove = async (o) => {
    if (!(await confirm(`Delete incoming stream "${o.name}"? Outgoing streams using it as source will lose it.`))) return;
    setBusy(true); setError('');
    try { await api(`/wmspanel/server/${serverId}/incoming/${o.id}`, { method: 'DELETE' }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!data) return <div className="hint">Loading…</div>;
  return (
    <div>
      <SyncNote />
      {error && <div className="error-box">{error}</div>}
      <div className="row" style={{ marginBottom: 10 }}>
        <input style={{ maxWidth: 260 }} placeholder="Filter name/description…" value={filter} onChange={e => setFilter(e.target.value)} />
        <button onClick={load} disabled={busy}>Refresh</button>
        {can('wmsobjects.manage') && (
          <button className="primary" disabled={busy}
                  onClick={() => setModal({ name: '', description: '', protocol: 'srt', ip: '0.0.0.0', port: 10000, receive_mode: 'listen', parameters: '' })}>
            + New incoming
          </button>
        )}
        <span className="hint">{streams.length} of {(data?.streams || []).length}</span>
      </div>
      <div className="panel">
        <table>
          <thead><tr><th>Name</th><th>Proto</th><th>Endpoint</th><th>Mode</th><th>Codecs</th><th>Bitrate</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {streams.map(o => (
              <tr key={o.id}>
                <td><b>{o.name}</b>{o.description && <div className="hint">{o.description}</div>}</td>
                <td><span className="badge">{o.protocol}</span></td>
                <td className="mono">{o.ip}:{o.port}</td>
                <td>{o.receive_mode}</td>
                <td className="hint">{codecsOf(o) || '—'}</td>
                <td className="mono">{fmtMbps(o.bandwidth)}</td>
                <td><span className={'lamp ' + (o.status === 'online' ? 'on' : o.status === 'paused' ? 'warn' : 'off')} />{o.status}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {can('wmsobjects.manage') && <>
                    <button disabled={busy} onClick={() => setModal({
                      id: o.id, name: o.name, description: o.description || '',
                      protocol: o.protocol, ip: o.ip, port: o.port,
                      receive_mode: o.receive_mode,
                      parameters: Object.keys(o.parameters || {}).length ? JSON.stringify(o.parameters) : '',
                    })}>Edit</button>{' '}
                    <button className="danger" disabled={busy} onClick={() => remove(o)}>Delete</button>
                  </>}
                </td>
              </tr>
            ))}
            {streams.length === 0 && <tr><td colSpan={8} className="hint">No incoming MPEGTS/SRT streams{filter ? ' matching filter' : ''}.</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && (
        <div className="modal-back" {...backdropClose(() => setModal(null))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{modal.id ? `Edit ${modal.name}` : 'New incoming stream'}</h3>
            <label>Name</label>
            <input value={modal.name} onChange={e => setModal(m => ({ ...m, name: e.target.value }))} />
            <label>Description</label>
            <input value={modal.description} onChange={e => setModal(m => ({ ...m, description: e.target.value }))} />
            <div className="field-inline">
              <div>
                <label>Protocol</label>
                <Select value={modal.protocol} onChange={v => setModal(m => ({ ...m, protocol: v }))}
                        options={['srt', 'udp', 'rist', 'http', 'hls'].map(x => ({ value: x, label: x }))} />
              </div>
              <div>
                <label>Receive mode</label>
                <Select value={modal.receive_mode} onChange={v => setModal(m => ({ ...m, receive_mode: v }))}
                        options={['listen', 'pull'].map(x => ({ value: x, label: x }))} />
              </div>
            </div>
            <div className="field-inline">
              <div><label>IP</label><input className="mono" value={modal.ip} onChange={e => setModal(m => ({ ...m, ip: e.target.value }))} /></div>
              <div><label>Port</label><input type="number" value={modal.port} onChange={e => setModal(m => ({ ...m, port: e.target.value }))} /></div>
            </div>
            <label>Parameters (JSON, e.g. {'{"latency":"1000"}'} — empty = none)</label>
            <input className="mono" value={modal.parameters} onChange={e => setModal(m => ({ ...m, parameters: e.target.value }))} />
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setModal(null)}>Cancel</button>
              <button className="primary" disabled={busy || !modal.name || !modal.ip || !modal.port} onClick={save}>
                {modal.id ? 'Apply' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- Live Pull
// RTMP pull feeds with fallback_urls — the built-in feed reserve mechanism.
export function LivePullTab({ serverId }) {
  const confirm = useConfirm();
  const { can } = useAuth();
  const { data, error, setError, load } = useObjects(serverId, 'livepull');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null);
  const settings = data?.settings || [];

  const act = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const save = () => act(async () => {
    const body = {
      url: modal.url,
      fallback_urls: modal.fallback_urls.split('\n').map(x => x.trim()).filter(Boolean),
      application: modal.application, stream: modal.stream,
      description: modal.description || '',
    };
    if (modal.id) await api(`/wmspanel/server/${serverId}/livepull/${modal.id}`, { method: 'PUT', body });
    else await api(`/wmspanel/server/${serverId}/livepull`, { method: 'POST', body });
    setModal(null);
  });

  if (!data) return <div className="hint">Loading…</div>;
  return (
    <div>
      <SyncNote />
      {error && <div className="error-box">{error}</div>}
      <div className="row" style={{ marginBottom: 10 }}>
        <button onClick={load} disabled={busy}>Refresh</button>
        {can('wmsobjects.manage') && (
          <button className="primary" disabled={busy}
                  onClick={() => setModal({ url: '', fallback_urls: '', application: '', stream: '', description: '' })}>
            + New pull
          </button>
        )}
      </div>
      <div className="panel">
        <table>
          <thead><tr><th>Local app/stream</th><th>Source URL</th><th>Fallbacks</th><th>State</th><th></th></tr></thead>
          <tbody>
            {settings.map(o => (
              <tr key={o.id}>
                <td className="mono"><b>{o.application}/{o.stream}</b>{o.description && <div className="hint">{o.description}</div>}</td>
                <td className="mono hint" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.url}</td>
                <td>{(o.fallback_urls || []).length ? <span className="badge">{o.fallback_urls.length} fallback</span> : <span className="hint">—</span>}</td>
                <td><span className={'lamp ' + (o.paused ? 'off' : 'on')} />{o.paused ? 'paused' : 'active'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {can('wmsobjects.manage') && <>
                    <button disabled={busy} onClick={() => act(() => api(`/wmspanel/server/${serverId}/livepull/${o.id}/restart`, { method: 'POST' }))}>Restart</button>{' '}
                    <button disabled={busy} onClick={() => act(() => api(`/wmspanel/server/${serverId}/livepull/${o.id}`, { method: 'PUT', body: { paused: !o.paused } }))}>
                      {o.paused ? 'Resume' : 'Pause'}
                    </button>{' '}
                    <button disabled={busy} onClick={() => setModal({
                      id: o.id, url: o.url, fallback_urls: (o.fallback_urls || []).join('\n'),
                      application: o.application, stream: o.stream, description: o.description || '',
                    })}>Edit</button>{' '}
                    <button className="danger" disabled={busy} onClick={async () => {
                      if (await confirm(`Delete pull ${o.application}/${o.stream}?`))
                        act(() => api(`/wmspanel/server/${serverId}/livepull/${o.id}`, { method: 'DELETE' }));
                    }}>Delete</button>
                  </>}
                </td>
              </tr>
            ))}
            {settings.length === 0 && <tr><td colSpan={5} className="hint">No RTMP pull settings on this server.</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && (
        <div className="modal-back" {...backdropClose(() => setModal(null))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{modal.id ? `Edit pull ${modal.application}/${modal.stream}` : 'New RTMP pull'}</h3>
            <label>Source URL</label>
            <input className="mono" value={modal.url} onChange={e => setModal(m => ({ ...m, url: e.target.value }))}
                   placeholder="rtmp://host:1935/app/stream" />
            <label>Fallback URLs (one per line — reserve sources, tried in order)</label>
            <textarea className="mono" rows={3} value={modal.fallback_urls}
                      onChange={e => setModal(m => ({ ...m, fallback_urls: e.target.value }))} />
            <div className="field-inline">
              <div><label>Local application</label><input value={modal.application} onChange={e => setModal(m => ({ ...m, application: e.target.value }))} /></div>
              <div><label>Local stream</label><input value={modal.stream} onChange={e => setModal(m => ({ ...m, stream: e.target.value }))} /></div>
            </div>
            <label>Description</label>
            <input value={modal.description} onChange={e => setModal(m => ({ ...m, description: e.target.value }))} />
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setModal(null)}>Cancel</button>
              <button className="primary" disabled={busy || !modal.url || !modal.application || !modal.stream} onClick={save}>
                {modal.id ? 'Apply' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- Applications
// live/app settings incl. push credentials (masked with reveal toggle).
export function AppsTab({ serverId }) {
  const confirm = useConfirm();
  const { can } = useAuth();
  const { data, error, setError, load } = useObjects(serverId, 'apps');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null);
  const [reveal, setReveal] = useState({});
  const apps = data?.applications || [];

  const save = async () => {
    setBusy(true); setError('');
    const body = {
      application: modal.application,
      chunk_duration: Number(modal.chunk_duration),
      chunk_count: Number(modal.chunk_count),
      protocols: modal.protocols.split(',').map(x => x.trim()).filter(Boolean),
    };
    if (modal.push_login !== '') body.push_login = modal.push_login;
    if (modal.push_password !== '') body.push_password = modal.push_password;
    try {
      if (modal.id) await api(`/wmspanel/server/${serverId}/apps/${modal.id}`, { method: 'PUT', body });
      else await api(`/wmspanel/server/${serverId}/apps`, { method: 'POST', body });
      setModal(null); await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!data) return <div className="hint">Loading…</div>;
  return (
    <div>
      <SyncNote />
      {error && <div className="error-box">{error}</div>}
      <div className="row" style={{ marginBottom: 10 }}>
        <button onClick={load} disabled={busy}>Refresh</button>
        {can('wmsobjects.manage') && (
          <button className="primary" disabled={busy}
                  onClick={() => setModal({ application: '', chunk_duration: 6, chunk_count: 4, protocols: 'HLS,RTMP', push_login: '', push_password: '' })}>
            + New application
          </button>
        )}
      </div>
      <div className="panel">
        <table>
          <thead><tr><th>Application</th><th>Protocols</th><th>Chunks</th><th>Push auth</th><th></th></tr></thead>
          <tbody>
            {apps.map(a => (
              <tr key={a.id}>
                <td className="mono"><b>{a.application}</b></td>
                <td>{(a.protocols || []).map(pr => <span key={pr} className="badge" style={{ marginRight: 3 }}>{pr}</span>)}</td>
                <td className="mono">{a.chunk_duration}s × {a.chunk_count}</td>
                <td className="mono">
                  {a.push_login || a.push_password ? (
                    reveal[a.id]
                      ? <>{a.push_login} / {a.push_password} <button onClick={() => setReveal(r => ({ ...r, [a.id]: false }))}>hide</button></>
                      : <>{a.push_login} / •••••• <button onClick={() => setReveal(r => ({ ...r, [a.id]: true }))}>show</button></>
                  ) : <span className="hint">open</span>}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {can('wmsobjects.manage') && <>
                    <button disabled={busy} onClick={() => setModal({
                      id: a.id, application: a.application,
                      chunk_duration: a.chunk_duration, chunk_count: a.chunk_count,
                      protocols: (a.protocols || []).join(','),
                      push_login: a.push_login || '', push_password: a.push_password || '',
                    })}>Edit</button>{' '}
                    <button className="danger" disabled={busy} onClick={async () => {
                      if (!(await confirm(`Delete application "${a.application}"?`))) return;
                      setBusy(true); setError('');
                      try { await api(`/wmspanel/server/${serverId}/apps/${a.id}`, { method: 'DELETE' }); await load(); }
                      catch (e) { setError(e.message); }
                      finally { setBusy(false); }
                    }}>Delete</button>
                  </>}
                </td>
              </tr>
            ))}
            {apps.length === 0 && <tr><td colSpan={5} className="hint">No applications on this server.</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && (
        <div className="modal-back" {...backdropClose(() => setModal(null))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{modal.id ? `Edit ${modal.application}` : 'New application'}</h3>
            <label>Application name</label>
            <input value={modal.application} onChange={e => setModal(m => ({ ...m, application: e.target.value }))} />
            <div className="field-inline">
              <div><label>Chunk duration (s)</label><input type="number" value={modal.chunk_duration} onChange={e => setModal(m => ({ ...m, chunk_duration: e.target.value }))} /></div>
              <div><label>Chunk count</label><input type="number" value={modal.chunk_count} onChange={e => setModal(m => ({ ...m, chunk_count: e.target.value }))} /></div>
            </div>
            <label>Protocols (comma separated: HLS,RTMP,DASH…)</label>
            <input value={modal.protocols} onChange={e => setModal(m => ({ ...m, protocols: e.target.value }))} />
            <div className="field-inline">
              <div><label>Push login</label><input value={modal.push_login} onChange={e => setModal(m => ({ ...m, push_login: e.target.value }))} /></div>
              <div><label>Push password</label><input type="password" value={modal.push_password} onChange={e => setModal(m => ({ ...m, push_password: e.target.value }))} /></div>
            </div>
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setModal(null)}>Cancel</button>
              <button className="primary" disabled={busy || !modal.application} onClick={save}>{modal.id ? 'Apply' : 'Create'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- Interfaces
export function InterfacesTab({ serverId }) {
  const confirm = useConfirm();
  const { can } = useAuth();
  const { data, error, setError, load } = useObjects(serverId, 'interfaces');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null);
  const list = data?.interfaces || [];

  const save = async () => {
    setBusy(true); setError('');
    const body = { ip: modal.ip, port: Number(modal.port), ssl: Boolean(modal.ssl) };
    try {
      if (modal.id) await api(`/wmspanel/server/${serverId}/interfaces/${modal.id}`, { method: 'PUT', body });
      else await api(`/wmspanel/server/${serverId}/interfaces`, { method: 'POST', body });
      setModal(null); await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const remove = async (i) => {
    if (!(await confirm(`Delete RTMP interface ${i.ip}:${i.port}? Publishers using it will disconnect.`))) return;
    setBusy(true); setError('');
    try { await api(`/wmspanel/server/${serverId}/interfaces/${i.id}`, { method: 'DELETE' }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!data) return <div className="hint">Loading…</div>;
  return (
    <div>
      <SyncNote />
      {error && <div className="error-box">{error}</div>}
      <div className="panel">
        <table>
          <thead><tr><th>IP</th><th>Port</th><th>SSL</th><th></th></tr></thead>
          <tbody>
            {list.map(i => (
              <tr key={i.id}>
                <td className="mono">{i.ip}</td>
                <td className="mono">{i.port}</td>
                <td>{i.ssl ? <span className="badge">ssl</span> : <span className="hint">no</span>}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {can('wmsobjects.manage') && <>
                    <button disabled={busy} onClick={() => setModal({ id: i.id, ip: i.ip, port: i.port, ssl: i.ssl })}>Edit</button>{' '}
                    <button className="danger" disabled={busy} onClick={() => remove(i)}>Delete</button>
                  </>}
                </td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={4} className="hint">No RTMP interfaces.</td></tr>}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={load} disabled={busy}>Refresh</button>
          {can('wmsobjects.manage') && (
            <button className="primary" disabled={busy} onClick={() => setModal({ ip: '0.0.0.0', port: 1935, ssl: false })}>+ New interface</button>
          )}
        </div>
      </div>
      {modal && (
        <div className="modal-back" {...backdropClose(() => setModal(null))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{modal.id ? `Edit interface ${modal.ip}:${modal.port}` : 'New RTMP interface'}</h3>
            <div className="field-inline">
              <div><label>IP</label><input className="mono" value={modal.ip} onChange={e => setModal(m => ({ ...m, ip: e.target.value }))} /></div>
              <div><label>Port</label><input type="number" value={modal.port} onChange={e => setModal(m => ({ ...m, port: e.target.value }))} /></div>
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={modal.ssl} onChange={e => setModal(m => ({ ...m, ssl: e.target.checked }))} /> SSL
            </label>
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setModal(null)}>Cancel</button>
              <button className="primary" disabled={busy || !modal.ip || !modal.port} onClick={save}>{modal.id ? 'Apply' : 'Create'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
