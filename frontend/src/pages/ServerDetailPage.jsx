import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import RepublishTab from './RepublishTab.jsx';
import { UdpTab, OutgoingTab, HotswapTab, WmsStreamsTab, MpegtsInTab, LivePullTab, AppsTab, InterfacesTab } from './WmsObjectsTabs.jsx';
import DataView, { CopyJsonButton } from '../components/DataView.jsx';
import { useConfirm } from '../confirm.jsx';
import { useI18n } from '../i18n.jsx';
import ServerEditModal from '../components/ServerEditModal.jsx';

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
  const confirm = useConfirm();
  const { can } = useAuth();
  const [refreshKey, setRefreshKey] = useState(0);
  const [state] = useNimble(serverId, `sessions?k=${refreshKey}`, { poll: 15000 });
  const [selected, setSelected] = useState({});
  if (state.loading) return <div className="hint">Loading…</div>;
  if (!state.ok) return <Err state={state} />;
  const sessions = Array.isArray(state.data) ? state.data : [];
  const ids = Object.keys(selected).filter(k => selected[k]).map(Number);

  const disconnect = async () => {
    if (!(await confirm(`Disconnect ${ids.length} session(s)?`))) return;
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
      <div className="row" style={{ justifyContent: 'space-between' }}>
        {title && <h2 style={{ marginTop: 0 }}>{title}</h2>}
        <CopyJsonButton data={data} />
      </div>
      <div style={{ maxHeight: 420, overflow: 'auto' }}><DataView data={data} /></div>
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
  const confirm = useConfirm();
  const [log, setLog] = useState([]);
  const run = async (label, path) => {
    if (!(await confirm(`Execute "${label}" on this server?`))) return;
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

// Tabs are split by data source: 'native' tabs poll the instance's native API
// and are only available in backup (native) control plane mode; 'wmspanel'
// tabs work through WMSPanel API.
const TABS = [
  { key: 'streams',   label: 'Streams',   perm: 'streams.view',   el: StreamsTab,   plane: 'native',   group: 'general' },
  { key: 'sessions',  label: 'Sessions',  perm: 'sessions.view',  el: SessionsTab,  plane: 'native',   group: 'general' },
  { key: 'wstreams',  label: 'Streams',   perm: 'streams.view',    el: WmsStreamsTab, plane: 'wmspanel', group: 'general' },
  { key: 'wapps',     label: 'Apps',      perm: 'wmsobjects.view', el: AppsTab,     plane: 'wmspanel', group: 'general' },
  { key: 'wifaces',   label: 'Interfaces',perm: 'wmsobjects.view', el: InterfacesTab, plane: 'wmspanel', group: 'general' },
  { key: 'republish', label: 'RTMP Push', perm: 'republish.view', el: RepublishTab, plane: 'both',      group: 'rtmp' },
  { key: 'wpull',     label: 'RTMP Pull', perm: 'wmsobjects.view', el: LivePullTab, plane: 'wmspanel', group: 'rtmp' },
  { key: 'srt',       label: 'SRT',       perm: 'srt.view',       el: SrtTab,       plane: 'native',   group: 'srt' },
  { key: 'win',       label: 'SRT In',    perm: 'wmsobjects.view', el: MpegtsInTab, plane: 'wmspanel', group: 'srt' },
  { key: 'wudp',      label: 'SRT Out',   perm: 'wmsobjects.view', el: UdpTab,      plane: 'wmspanel', group: 'srt' },
  { key: 'wout',      label: 'SRT in Nimble', perm: 'wmsobjects.view', el: OutgoingTab, plane: 'wmspanel', group: 'srt' },
  { key: 'mpegts',    label: 'MPEG-TS',   perm: 'mpegts.view',    el: MpegtsTab,    plane: 'native',   group: 'srt' },
  { key: 'whot',      label: 'Hotswap',   perm: 'wmsobjects.view', el: HotswapTab,  plane: 'wmspanel', group: 'other' },
  { key: 'playlist',  label: 'Playout',   perm: 'playlist.view',  el: PlaylistTab,  plane: 'native',   group: 'other' },
  { key: 'control',   label: 'Control',   perm: 'control.manage', el: ControlTab,   plane: 'native',   group: 'system' },
];

const GROUP_ORDER = ['general', 'rtmp', 'srt', 'other', 'system'];
const GROUP_LABEL = { general: 'general', rtmp: 'RTMP', srt: 'SRT', other: 'other', system: 'system' };

export default function ServerDetailPage() {
  const { id } = useParams();
  const { can, sys } = useAuth();
  const { t } = useI18n();
  const [server, setServer] = useState(null);
  const wms = sys?.controlPlane === 'wmspanel';
  const visibleTabs = useMemo(() => {
    const shown = TABS.filter(tab => can(tab.perm) && (wms ? tab.plane !== 'native' : tab.plane !== 'wmspanel'));
    return shown
      .map((t, i) => ({ t, i }))
      .sort((a, b) => (GROUP_ORDER.indexOf(a.t.group) - GROUP_ORDER.indexOf(b.t.group)) || (a.i - b.i))
      .map(x => x.t);
  }, [can, wms]);
  const [tab, setTab] = useState(null);
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => {
    api('/servers').then(list => setServer(list.find(s => s.id === id) || null));
  }, [id]);
  useEffect(() => {
    if (!tab && visibleTabs.length) setTab(visibleTabs[0].key);
  }, [visibleTabs, tab]);

  const t2GroupTitle = (g) => {
    const key = 'tabgroup.' + g;
    const v = t(key);
    return v === key ? g : v;
  };
  const Active = visibleTabs.find(t => t.key === tab)?.el;
  return (
    <div>
      <div className="hint"><Link to="/servers">← Servers</Link></div>
      <div className="title-row">
        <h1 style={{ margin: 0 }}>{server ? server.name : '…'}</h1>
        {wms && server?.wmspanelServerId && can('servers.manage') && (
          <button className="title-edit" onClick={() => setEditOpen(true)}
                  title={t('srv.editTitle')} aria-label={t('srv.editTitle')}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path fill="currentColor" d="M11.6 1.6a1.4 1.4 0 0 1 2 0l.8.8a1.4 1.4 0 0 1 0 2l-.9.9-2.8-2.8.9-.9ZM9.8 3.4l2.8 2.8-6.6 6.6-3.3.5.5-3.3 6.6-6.6Z"/>
            </svg>
          </button>
        )}
      </div>
      {server && <div className="sub mono">{server.useSsl ? 'https' : 'http'}://{server.host}:{server.port}</div>}
      {wms && (
        <div className="hint" style={{ marginBottom: 10 }}>
          {t('server.bannerWms')}
        </div>
      )}
      <div className="tabs">
        {visibleTabs.map((t, i) => {
          const newGroup = i === 0 || visibleTabs[i - 1].group !== t.group;
          return (
            <span key={t.key} style={{ display: 'contents' }}>
              {newGroup && i !== 0 && <span className="tab-sep" aria-hidden="true" />}
              <button className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}
                      title={GROUP_LABEL[t.group] ? t2GroupTitle(t.group) : undefined}>{t.label}</button>
            </span>
          );
        })}
      </div>
      {Active && <Active serverId={id} server={server} />}
      {editOpen && (
        <ServerEditModal serverId={id} onClose={() => setEditOpen(false)}
          onSaved={() => { setEditOpen(false); api('/servers').then(list => setServer(list.find(s => s.id === id) || null)); }} />
      )}
    </div>
  );
}
