import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function AuditPage() {
  const [items, setItems] = useState([]);
  const [username, setUsername] = useState('');
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState('');
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [busy, setBusy] = useState(false);

  const query = (before) => {
    const p = new URLSearchParams();
    if (username) p.set('username', username);
    if (action) p.set('action', action);
    if (outcome) p.set('outcome', outcome);
    if (before) p.set('before', before);
    return `/audit?${p.toString()}`;
  };

  const load = async () => {
    setBusy(true); setError('');
    try { setItems((await api(query())).items); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const loadOlder = async () => {
    if (items.length === 0) return;
    setBusy(true);
    try {
      const older = (await api(query(items[items.length - 1].ts))).items;
      setItems(list => [...list, ...older]);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); }, []);

  return (
    <div>
      <h1>Audit log</h1>
      <div className="sub">Who changed what and when. Mutating actions, logins and function runs; secrets are masked; retention 90 days.</div>
      {error && <div className="error-box">{error}</div>}
      <div className="row" style={{ marginBottom: 12 }}>
        <input style={{ maxWidth: 160 }} placeholder="User" value={username} onChange={e => setUsername(e.target.value)} />
        <input style={{ maxWidth: 260 }} placeholder="Action contains…" value={action} onChange={e => setAction(e.target.value)} />
        <select style={{ maxWidth: 130 }} value={outcome} onChange={e => setOutcome(e.target.value)}>
          <option value="">any outcome</option>
          <option value="ok">ok</option>
          <option value="error">error</option>
        </select>
        <button className="primary" disabled={busy} onClick={load}>Apply</button>
      </div>
      <div className="panel">
        <table>
          <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Target</th><th>Result</th><th></th></tr></thead>
          <tbody>
            {items.map(it => (
              <tr key={it._id}>
                <td className="mono hint" style={{ whiteSpace: 'nowrap' }}>{new Date(it.ts).toLocaleString()}</td>
                <td className="mono">{it.username || '—'}</td>
                <td className="mono">{it.action}</td>
                <td className="mono hint">{it.target || ''}</td>
                <td><span className={'lamp ' + (it.outcome === 'ok' ? 'on' : 'off')} />{it.status || it.outcome}</td>
                <td style={{ textAlign: 'right' }}>
                  {it.detail && <button onClick={() => setExpanded(expanded === it._id ? null : it._id)}>
                    {expanded === it._id ? 'Hide' : 'Detail'}
                  </button>}
                </td>
              </tr>
            ))}
            {items.map(it => expanded === it._id && (
              <tr key={it._id + 'x'}>
                <td colSpan={6}>
                  <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 220, overflow: 'auto' }}>
                    {JSON.stringify(it.detail, null, 2)}
                  </pre>
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={6} className="hint">No audit entries match.</td></tr>}
          </tbody>
        </table>
        {items.length >= 200 && (
          <div className="row" style={{ marginTop: 8 }}>
            <button disabled={busy} onClick={loadOlder}>Load older</button>
          </div>
        )}
      </div>
    </div>
  );
}
