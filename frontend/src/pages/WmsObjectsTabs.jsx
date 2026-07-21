import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

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
  const { can } = useAuth();
  const { data, error, setError, load } = useObjects(serverId, 'udp');
  const [edit, setEdit] = useState(null); // { id, name, sources: [...] }
  const [busy, setBusy] = useState(false);
  const settings = data?.settings || [];

  const openEdit = (o) => setEdit({
    id: o.id, name: o.name || o.id,
    sources: (o.source_streams || []).map(ss => ({ ...ss })),
  });

  const save = async () => {
    setBusy(true); setError('');
    try {
      // PIDs are preserved: we send back the full entries with only
      // application/stream changed by the operator.
      await api(`/wmspanel/server/${serverId}/udp/${edit.id}`, {
        method: 'PUT', body: { source_streams: edit.sources },
      });
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
          <thead><tr><th>Name</th><th>Proto</th><th>Destination</th><th>Source(s)</th><th>State</th><th></th></tr></thead>
          <tbody>
            {settings.map(o => (
              <tr key={o.id}>
                <td><b>{o.name || String(o.id).slice(-6)}</b>{o.description && <div className="hint">{o.description}</div>}</td>
                <td><span className="badge">{o.protocol}</span></td>
                <td className="mono">{o.ip}:{o.port}</td>
                <td className="mono">
                  {(o.source_streams || []).map((ss, i) => (
                    <div key={i}>{ss.application}/{ss.stream}</div>
                  ))}
                  {(o.source_streams || []).length === 0 && <span className="hint">—</span>}
                </td>
                <td><span className={'lamp ' + (o.paused ? 'off' : 'on')} />{o.paused ? 'paused' : 'active'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {can('wmsobjects.manage') && <>
                    <button disabled={busy} onClick={() => openEdit(o)}>Edit source</button>{' '}
                    <button disabled={busy} onClick={() => togglePause(o)}>{o.paused ? 'Resume' : 'Pause'}</button>
                  </>}
                </td>
              </tr>
            ))}
            {settings.length === 0 && <tr><td colSpan={6} className="hint">No UDP/SRT outputs on this server.</td></tr>}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 8 }}><button onClick={load} disabled={busy}>Refresh</button></div>
      </div>
      {edit && (
        <div className="modal-back" onClick={() => setEdit(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Source of {edit.name}</h3>
            {edit.sources.map((ss, i) => (
              <div key={i} className="panel" style={{ padding: 10 }}>
                <div className="field-inline">
                  <div><label>Application</label>
                    <input value={ss.application || ''} onChange={e =>
                      setEdit(s => ({ ...s, sources: s.sources.map((x, j) => j === i ? { ...x, application: e.target.value } : x) }))} />
                  </div>
                  <div><label>Stream</label>
                    <input value={ss.stream || ''} onChange={e =>
                      setEdit(s => ({ ...s, sources: s.sources.map((x, j) => j === i ? { ...x, stream: e.target.value } : x) }))} />
                  </div>
                </div>
                <div className="hint mono">
                  PIDs preserved: pmt={ss.pmt_pid ?? 'auto'} video={ss.video_pid ?? 'auto'} audio={ss.audio_pid ?? 'auto'}
                </div>
              </div>
            ))}
            {edit.sources.length === 0 && <div className="hint">This output has no source_streams entries.</div>}
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setEdit(null)}>Cancel</button>
              <button className="primary" disabled={busy || edit.sources.length === 0} onClick={save}>Apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- Outgoing
export function OutgoingTab({ serverId }) {
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
    if (!window.confirm(`Delete outgoing ${o.application}/${o.stream}?`)) return;
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
        <div className="modal-back" onClick={() => setModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{modal.id ? `Edit ${modal.application}/${modal.stream}` : 'New outgoing stream'}</h3>
            <div className="field-inline">
              <div><label>Application</label><input value={modal.application} onChange={e => setModal(m => ({ ...m, application: e.target.value }))} /></div>
              <div><label>Stream</label><input value={modal.stream} onChange={e => setModal(m => ({ ...m, stream: e.target.value }))} /></div>
            </div>
            <label>Description</label>
            <input value={modal.description} onChange={e => setModal(m => ({ ...m, description: e.target.value }))} />
            <label>Video source (incoming stream)</label>
            <select value={modal.video_source} onChange={e => setModal(m => ({ ...m, video_source: e.target.value }))}>
              <option value="">— keep / none —</option>
              {incoming.map(x => <option key={x.id} value={x.id}>{x.name} ({x.status})</option>)}
            </select>
            <label>Audio source (incoming stream)</label>
            <select value={modal.audio_source} onChange={e => setModal(m => ({ ...m, audio_source: e.target.value }))}>
              <option value="">— same as video / none —</option>
              {incoming.map(x => <option key={x.id} value={x.id}>{x.name} ({x.status})</option>)}
            </select>
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
  const { can } = useAuth();
  const { data, error, setError, load } = useObjects(serverId, 'hotswap');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
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
    if (!window.confirm(`Delete hot swap ${o.original_app}/${o.original_stream}?`)) return;
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
                    <button disabled={busy} onClick={() => {
                      const sa = window.prompt('Substitute app:', o.substitute_app);
                      if (sa === null) return;
                      const ss = window.prompt('Substitute stream:', o.substitute_stream);
                      if (ss === null) return;
                      put(o, { substitute_app: sa, substitute_stream: ss });
                    }}>Edit substitute</button>{' '}
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
    </div>
  );
}

// ------------------------------------------------------------ Active streams
// Source: WMSPanel Streams API (Deep stats). Manual refresh by default —
// every load costs 2 API calls against the 15k/day account budget.
export function WmsStreamsTab({ serverId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [auto, setAuto] = useState(false);
  const [loadedAt, setLoadedAt] = useState(null);
  const [showDebug, setShowDebug] = useState(false);

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

  if (!data) return <div className="hint">Loading…</div>;
  const q = filter.trim().toLowerCase();
  const list = data.streams.filter(s => !q || (s.app + '/' + s.stream).toLowerCase().includes(q));
  const byApp = {};
  for (const s of list) (byApp[s.app || '?'] ||= []).push(s);

  return (
    <div>
      <div className="hint" style={{ marginBottom: 10 }}>
        Active streams from WMSPanel Deep stats. If this errors about stats/slices — enable Deep stats
        for the account in WMSPanel. Each refresh costs 2 API calls (15k/day account budget).
      </div>
      {error && <div className="error-box">{error}</div>}
      <div className="row" style={{ marginBottom: 10 }}>
        <input style={{ maxWidth: 280 }} placeholder="Filter app/stream…" value={filter} onChange={e => setFilter(e.target.value)} />
        <button onClick={load}>Refresh</button>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={auto} onChange={e => setAuto(e.target.checked)} />
          Auto (30s)
        </label>
        <span className="hint">
          {list.length} of {data.streams.length} streams
          {loadedAt && <> · loaded {loadedAt.toLocaleTimeString()}</>}
        </span>
        {data.streams.length === 0 && data.debug && (
          <button onClick={() => setShowDebug(v => !v)}>{showDebug ? 'Hide debug' : 'Debug'}</button>
        )}
      </div>
      {showDebug && data.debug && (
        <div className="panel">
          <div className="hint">Deep-stats queries tried (kind → count) and a raw sample — if counts are 0 while
            WMSPanel UI shows streams, the full live view uses a different API section; probe dump will pin it.</div>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 240, overflow: 'auto' }}>
            {JSON.stringify(data.debug, null, 2)}
          </pre>
        </div>
      )}
      {Object.entries(byApp).sort(([a], [b]) => a.localeCompare(b)).map(([app, streams]) => (
        <div className="panel" key={app}>
          <h2 style={{ marginTop: 0 }}>{app} <span className="hint">({streams.length})</span></h2>
          <table>
            <tbody>
              {streams.sort((a, b) => a.stream.localeCompare(b.stream)).map(s => (
                <tr key={s.raw}>
                  <td className="mono"><span className="lamp on" />{s.stream}</td>
                  <td className="hint mono" style={{ textAlign: 'right' }}>{s.raw}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {list.length === 0 && !error && <div className="panel hint">No active streams{q ? ' matching the filter' : ''}.</div>}
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
    if (!window.confirm(`Delete incoming stream "${o.name}"? Outgoing streams using it as source will lose it.`)) return;
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
        <div className="modal-back" onClick={() => setModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{modal.id ? `Edit ${modal.name}` : 'New incoming stream'}</h3>
            <label>Name</label>
            <input value={modal.name} onChange={e => setModal(m => ({ ...m, name: e.target.value }))} />
            <label>Description</label>
            <input value={modal.description} onChange={e => setModal(m => ({ ...m, description: e.target.value }))} />
            <div className="field-inline">
              <div>
                <label>Protocol</label>
                <select value={modal.protocol} onChange={e => setModal(m => ({ ...m, protocol: e.target.value }))}>
                  {['srt', 'udp', 'rist', 'http', 'hls'].map(x => <option key={x} value={x}>{x}</option>)}
                </select>
              </div>
              <div>
                <label>Receive mode</label>
                <select value={modal.receive_mode} onChange={e => setModal(m => ({ ...m, receive_mode: e.target.value }))}>
                  {['listen', 'pull'].map(x => <option key={x} value={x}>{x}</option>)}
                </select>
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
