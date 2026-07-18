import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

const fmtBps = (b) => (b == null ? '—' : (Number(b) / 1e6).toFixed(2) + ' Mbps');
const fmtTs = (ts) => (ts ? new Date(Number(ts) * 1000).toLocaleString() : '—');

// Generic loader hook for one nimble sub-endpoint with optional polling.
function useNimble(serverId, path, { poll = 0, enabled = true } = {}) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      try {
        const data = await api(`/nimble/${serverId}/${path}`);
        if (alive) setState({ loading: false, ok: true, data });
      } catch (e) {
        if (alive) setState({ loading: false, ok: false, error: e.message, status: e.status });
      }
    };
    load();
    const t = poll ? setInterval(load, poll) : null;
    return () => { alive = false; if (t) clearInterval(t); };
  }, [serverId, path, poll, enabled]);
  const reload = () => setState(s => ({ ...s })); // trigger via key change below if needed
  return [state, reload];
}

function Err({ state }) {
  if (state.status === 403) return <div className="error-box">You do not have permission for this section.</div>;
  return <div className="error-box">{state.error}</div>;
}

function StreamsTab({ serverId }) {
  const [state] = useNimble(serverId, 'streams', { poll: 10000 });
  if (state.loading) return <div className="hint">Loading…</div>;
  if (!state.ok) return <Err state={state} />;
  const apps = Array.isArray(state.data) ? state.data : [];
  return (
    <div className="panel">
      <table>
        <thead><tr><th>App</th><th>Stream</th><th>Proto</th><th>Resolution</th><th>Bandwidth</th><th>Codecs</th><th>Publisher</th></tr></thead>
        <tbody>
          {apps.flatMap(app => (app.streams || []).map(st => (
            <tr key={app.app + '/' + st.strm} className="tally">
              <td className="mono">{app.app}</td>
              <td className="mono"><b>{st.strm}</b></td>
              <td><span className="badge live">{st.protocol}</span></td>
              <td className="mono">{st.resolution || '—'}</td>
              <td className="mono">{fmtBps(st.bandwidth)}</td>
              <td className="mono">{[st.vcodec, st.acodec].filter(Boolean).join(' / ')}</td>
              <td className="mono">{st.publisher_ip ? `${st.publisher_ip}:${st.publisher_port || ''}` : (st.source_url || '—')}</td>
            </tr>
          )))}
          {apps.length === 0 && <tr><td colSpan={7} className="hint">No live outgoing streams.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function SessionsTab({ serverId }) {
  const { can } = useAuth();
  const [refreshKey, setRefreshKey] = useState(0);
  const [state] = useNimble(serverId, `sessions?k=${refreshKey}`, { poll: 15000 });
  const [selected, setSelected] = useState({});
  if (state.loading) return <div className="hint">Loading…</div>;
  if (!state.ok) return <Err state={state} />;
  const sessions = Array.isArray(state.data) ? state.data : [];
  const ids = Object.keys(selected).filter(k => selected[k]).map(Number);

  const disconnect = async () => {
    if (!window.confirm(`Disconnect ${ids.length} session(s)?`)) return;
    await api(`/nimble/${serverId}/sessions/delete`, { method: 'POST', body: { ids } });
    setSelected({});
    setRefreshKey(k => k + 1);
  };

  return (
    <div className="panel">
      {can('sessions.manage') && (
        <div className="row" style={{ marginBottom: 10 }}>
          <button className="danger" disabled={ids.length === 0} onClick={disconnect}>
            Disconnect selected ({ids.length})
          </button>
        </div>
      )}
      <table>
        <thead><tr><th></th><th>ID</th><th>App/Stream</th><th>Type</th><th>Client IP</th><th>Started</th><th>User agent</th></tr></thead>
        <tbody>
          {sessions.map(s => (
            <tr key={s.id}>
              <td>{can('sessions.manage') && (
                <input type="checkbox" style={{ width: 'auto' }} checked={!!selected[s.id]}
                       onChange={e => setSelected(sel => ({ ...sel, [s.id]: e.target.checked }))} />
              )}</td>
              <td className="mono">{s.id}</td>
              <td className="mono">{s.app}/{s.stream}</td>
              <td><span className="badge">{s.type}</span></td>
              <td className="mono">{s.client_ip}</td>
              <td className="mono">{fmtTs(s.created)}</td>
              <td className="hint" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.user_agent}</td>
            </tr>
          ))}
          {sessions.length === 0 && <tr><td colSpan={7} className="hint">No active viewer sessions.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function JsonPanel({ title, data }) {
  return (
    <div className="panel">
      {title && <h2 style={{ marginTop: 0 }}>{title}</h2>}
      <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 420, overflow: 'auto' }}>
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}

function SrtTab({ serverId }) {
  const [state] = useNimble(serverId, 'srt', { poll: 10000 });
  if (state.loading) return <div className="hint">Loading…</div>;
  if (!state.ok) return <Err state={state} />;
  return (
    <div>
      <div className="hint" style={{ marginBottom: 10 }}>
        Raw SRT protocol stats from Nimble (sender & receiver). Structured SRT category with editable
        settings arrives in a later iteration (persistent SRT config is not exposed by the native API).
      </div>
      <JsonPanel title="Sender stats" data={state.data.sender} />
      <JsonPanel title="Receiver stats" data={state.data.receiver} />
    </div>
  );
}

function RepublishTab({ serverId }) {
  const { can } = useAuth();
  const [rules, setRules] = useState(null);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ src_app: '', src_stream: '', dest_addr: '', dest_port: 1935, dest_app: '', dest_stream: '' });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const load = async () => {
    setError('');
    try {
      const [r, st] = await Promise.all([
        api(`/nimble/${serverId}/republish`),
        api(`/nimble/${serverId}/republish/stats`).catch(() => null),
      ]);
      setRules(r?.rules || []);
      setStats(st?.stats || []);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, [serverId]);

  const create = async () => {
    setBusy(true); setError('');
    try {
      await api(`/nimble/${serverId}/republish`, { method: 'POST', body: { ...form, dest_port: Number(form.dest_port) } });
      setForm({ src_app: '', src_stream: '', dest_addr: '', dest_port: 1935, dest_app: '', dest_stream: '' });
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const remove = async (id) => {
    if (!window.confirm(`Delete republish rule #${id}?`)) return;
    await api(`/nimble/${serverId}/republish/${id}`, { method: 'DELETE' });
    load();
  };

  const statFor = (id) => (stats || []).find(s => String(s.rule_id) === String(id));

  return (
    <div>
      <div className="error-box" style={{ background: '#2a2214', borderColor: '#5c4a2a', color: '#e8d5a8' }}>
        Per official Nimble docs: rules created via the native API are <b>not persistent</b> — they reset on
        Nimble Streamer reload. Persistent rules require WMSPanel API or host-side config (planned iteration).
      </div>
      {error && <div className="error-box">{error}</div>}
      <div className="panel">
        <table>
          <thead><tr><th>ID</th><th>Source</th><th>Destination</th><th>State</th><th>Bandwidth</th><th></th></tr></thead>
          <tbody>
            {(rules || []).map(rule => {
              const st = statFor(rule.id);
              return (
                <tr key={rule.id} className={st?.state === 'connected' ? 'tally' : ''}>
                  <td className="mono">{rule.id}</td>
                  <td className="mono">{rule.src_app}/{rule.src_stream || '*'}</td>
                  <td className="mono">{rule.dest_addr}:{rule.dest_port}/{rule.dest_app}/{rule.dest_stream}</td>
                  <td>{st ? <><span className={'lamp ' + (st.state === 'connected' ? 'on' : 'warn')} />{st.state}</> : '—'}</td>
                  <td className="mono">{st ? fmtBps(st.bandwidth) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    {can('republish.manage') && <button className="danger" onClick={() => remove(rule.id)}>Delete</button>}
                  </td>
                </tr>
              );
            })}
            {rules && rules.length === 0 && <tr><td colSpan={6} className="hint">No API-created republish rules.</td></tr>}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={load}>Refresh</button>
        </div>
      </div>
      {can('republish.manage') && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>New republish rule</h2>
          <div className="field-inline">
            <div><label>Source app</label><input value={form.src_app} onChange={e => set('src_app', e.target.value)} /></div>
            <div><label>Source stream (empty = all)</label><input value={form.src_stream} onChange={e => set('src_stream', e.target.value)} /></div>
          </div>
          <div className="field-inline">
            <div><label>Dest address</label><input value={form.dest_addr} onChange={e => set('dest_addr', e.target.value)} /></div>
            <div><label>Dest port</label><input type="number" value={form.dest_port} onChange={e => set('dest_port', e.target.value)} /></div>
          </div>
          <div className="field-inline">
            <div><label>Dest app</label><input value={form.dest_app} onChange={e => set('dest_app', e.target.value)} /></div>
            <div><label>Dest stream</label><input value={form.dest_stream} onChange={e => set('dest_stream', e.target.value)} /></div>
          </div>
          <button className="primary" style={{ marginTop: 12 }} disabled={busy || !form.src_app || !form.dest_addr || !form.dest_app}
                  onClick={create}>{busy ? 'Creating…' : 'Create rule'}</button>
        </div>
      )}
    </div>
  );
}

function MpegtsTab({ serverId }) {
  const [status] = useNimble(serverId, 'mpegts/status');
  const [settings] = useNimble(serverId, 'mpegts/settings');
  if (status.loading || settings.loading) return <div className="hint">Loading…</div>;
  return (
    <div>
      {status.ok ? <JsonPanel title="Incoming streams status" data={status.data} /> : <Err state={status} />}
      {settings.ok ? <JsonPanel title="MPEG-TS In settings (read-only)" data={settings.data} /> : <Err state={settings} />}
    </div>
  );
}

function PlaylistTab({ serverId }) {
  const [state] = useNimble(serverId, 'playlist', { poll: 10000 });
  if (state.loading) return <div className="hint">Loading…</div>;
  if (!state.ok) return <Err state={state} />;
  const items = Array.isArray(state.data) ? state.data : [];
  return (
    <div className="panel">
      <table>
        <thead><tr><th>Output stream</th><th>Block</th><th>Now playing</th><th>Type</th><th>Fallback</th></tr></thead>
        <tbody>
          {items.map(p => (
            <tr key={p.stream} className="tally">
              <td className="mono"><b>{p.stream}</b></td>
              <td className="mono">{p.block_name || p.block_id || '—'}</td>
              <td className="mono">{p.main_stream || '—'}</td>
              <td><span className="badge">{p.main_stream_type || '—'}</span></td>
              <td className="mono">{p.default_stream || '—'}</td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={5} className="hint">Server playout is not active.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function ControlTab({ serverId }) {
  const [log, setLog] = useState([]);
  const run = async (label, path) => {
    if (!window.confirm(`Execute "${label}" on this server?`)) return;
    try {
      const data = await api(`/nimble/${serverId}/control/${path}`, { method: 'POST' });
      setLog(l => [{ t: new Date().toLocaleTimeString(), label, ok: true, msg: JSON.stringify(data) }, ...l]);
    } catch (e) {
      setLog(l => [{ t: new Date().toLocaleTimeString(), label, ok: false, msg: e.message }, ...l]);
    }
  };
  return (
    <div className="panel">
      <div className="row">
        <button onClick={() => run('Reload config (rules.conf)', 'reload-config')}>Reload config</button>
        <button onClick={() => run('Reload SSL certificates', 'reload-ssl')}>Reload SSL</button>
        <button onClick={() => run('Re-sync with WMSPanel', 'sync-panel')}>Sync WMSPanel</button>
      </div>
      <div style={{ marginTop: 12 }}>
        {log.map((e, i) => (
          <div key={i} className="mono hint">
            <span className={'lamp ' + (e.ok ? 'on' : 'off')} />[{e.t}] {e.label}: {e.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

const TABS = [
  { key: 'streams',   label: 'Streams',   perm: 'streams.view',   el: StreamsTab },
  { key: 'sessions',  label: 'Sessions',  perm: 'sessions.view',  el: SessionsTab },
  { key: 'srt',       label: 'SRT',       perm: 'srt.view',       el: SrtTab },
  { key: 'republish', label: 'Republish', perm: 'republish.view', el: RepublishTab },
  { key: 'mpegts',    label: 'MPEG-TS',   perm: 'mpegts.view',    el: MpegtsTab },
  { key: 'playlist',  label: 'Playout',   perm: 'playlist.view',  el: PlaylistTab },
  { key: 'control',   label: 'Control',   perm: 'control.manage', el: ControlTab },
];

export default function ServerDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const [server, setServer] = useState(null);
  const visibleTabs = useMemo(() => TABS.filter(t => can(t.perm)), [can]);
  const [tab, setTab] = useState(null);

  useEffect(() => {
    api('/servers').then(list => setServer(list.find(s => s.id === id) || null));
  }, [id]);
  useEffect(() => {
    if (!tab && visibleTabs.length) setTab(visibleTabs[0].key);
  }, [visibleTabs, tab]);

  const Active = visibleTabs.find(t => t.key === tab)?.el;
  return (
    <div>
      <div className="hint"><Link to="/servers">← Servers</Link></div>
      <h1>{server ? server.name : '…'}</h1>
      {server && <div className="sub mono">{server.useSsl ? 'https' : 'http'}://{server.host}:{server.port}</div>}
      <div className="tabs">
        {visibleTabs.map(t => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {Active && <Active serverId={id} />}
    </div>
  );
}
