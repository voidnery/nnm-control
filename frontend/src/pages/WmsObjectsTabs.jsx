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
  const streams = data?.streams || [];

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
                </td>
                <td>{String(o.paused) === 'true' ? 'paused' : 'active'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {can('wmsobjects.manage') && <>
                    {String(o.paused) === 'true'
                      ? <button disabled={busy} onClick={() => act(o, 'resume')}>Resume</button>
                      : <button disabled={busy} onClick={() => act(o, 'pause')}>Pause</button>}{' '}
                    <button disabled={busy} onClick={() => act(o, 'restart')}>Restart</button>
                  </>}
                </td>
              </tr>
            ))}
            {streams.length === 0 && <tr><td colSpan={4} className="hint">No MPEGTS outgoing streams on this server.</td></tr>}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 8 }}><button onClick={load} disabled={busy}>Refresh</button></div>
      </div>
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
