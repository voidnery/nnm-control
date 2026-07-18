import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

const fmtBytes = (b) => {
  if (b == null) return '—';
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
  return Math.round(b / 1e3) + ' KB';
};
const fmtBps = (b) => (b == null ? '—' : (b / 1e6).toFixed(1) + ' Mbps');

function ServerCard({ server }) {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const data = await api(`/nimble/${server.id}/status`);
        if (alive) setState({ loading: false, ok: true, data });
      } catch (e) {
        if (alive) setState({ loading: false, ok: false, error: e.message });
      }
    };
    load();
    const t = setInterval(load, 15000);
    return () => { alive = false; clearInterval(t); };
  }, [server.id]);

  const sys = state.data?.SysInfo;
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <span className={'lamp ' + (state.loading ? '' : state.ok ? 'on' : 'off')} />
          <Link to={`/servers/${server.id}`}><b>{server.name}</b></Link>
          <div className="hint mono">{server.host}:{server.port}</div>
        </div>
        {state.ok && (
          <div className="mono hint">
            conn {state.data.Connections ?? '—'} · out {fmtBps(state.data.OutRate)}
          </div>
        )}
      </div>
      {state.ok && sys && (
        <div className="metrics" style={{ marginTop: 10 }}>
          <div className="metric"><div className="k">CPU load</div><div className="v">{sys.scl}%</div></div>
          <div className="metric"><div className="k">RAM free</div><div className="v">{fmtBytes(sys.fpms)}</div></div>
          <div className="metric"><div className="k">RAM total</div><div className="v">{fmtBytes(sys.tpms)}</div></div>
          <div className="metric"><div className="k">Cores</div><div className="v">{sys.ap}</div></div>
        </div>
      )}
      {!state.loading && !state.ok && <div className="error-box">{state.error}</div>}
    </div>
  );
}

export default function DashboardPage() {
  const [servers, setServers] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/servers').then(setServers).catch(e => setError(e.message));
  }, []);

  return (
    <div>
      <h1>Dashboard</h1>
      <div className="sub">Live status of all managed Nimble Streamer instances. Refreshes every 15 s.</div>
      {error && <div className="error-box">{error}</div>}
      {servers && servers.length === 0 && (
        <div className="panel">No servers yet. Add the first one on the <Link to="/servers">Servers</Link> page.</div>
      )}
      {servers && servers.map(s => <ServerCard key={s.id} server={s} />)}
    </div>
  );
}
