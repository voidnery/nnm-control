import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

// Transcoders are account-level in WMSPanel; server_id is an attribute.
// Scope here: list + pause/resume/clone + raw details; licenses with expiry
// warnings. Pipeline editing is a later step (schemas land from live use).
export default function TranscodersPage() {
  const { can } = useAuth();
  const [transcoders, setTranscoders] = useState(null);
  const [licenses, setLicenses] = useState([]);
  const [servers, setServers] = useState([]);
  const [filter, setFilter] = useState('');
  const [serverFilter, setServerFilter] = useState('');
  const [detail, setDetail] = useState(null);
  const [editModal, setEditModal] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError('');
    try {
      const [t, l, s] = await Promise.all([
        api('/wmspanel/transcoders'),
        api('/wmspanel/transcoders/licenses').catch(() => ({ licenses: [] })),
        api('/servers').catch(() => []),
      ]);
      setTranscoders(t.transcoders || []);
      setLicenses(l.licenses || []);
      setServers(s);
    } catch (e) { setError(e.message); setTranscoders([]); }
  };
  useEffect(() => { load(); }, []);

  const serverName = (wsid) => servers.find(s => s.wmspanelServerId === wsid)?.name || String(wsid || '').slice(-6);

  const act = async (t, action) => {
    if (action === 'clone' && !window.confirm(`Clone transcoder "${t.name}"? A copy will be created (paused).`)) return;
    setBusy(true); setError('');
    try { await api(`/wmspanel/transcoders/${t.id}/${action}`, { method: 'POST' }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const openDetail = async (t) => {
    setDetail({ loading: true, name: t.name });
    try { setDetail({ name: t.name, data: await api(`/wmspanel/transcoders/${t.id}`) }); }
    catch (e) { setDetail({ name: t.name, error: e.message }); }
  };

  const daysLeft = (expire) => Math.floor((new Date(expire) - Date.now()) / 86400000);

  if (!transcoders) return <div className="hint">Loading…</div>;
  const q = filter.trim().toLowerCase();
  const list = transcoders.filter(t =>
    (!q || (t.name + ' ' + (t.description || '') + ' ' + (t.tags || []).join(' ')).toLowerCase().includes(q)) &&
    (!serverFilter || t.server_id === serverFilter));
  const usedServerIds = [...new Set(transcoders.map(t => t.server_id).filter(Boolean))];

  return (
    <div>
      <h1>Transcoders</h1>
      <div className="sub">Account-level Nimble Transcoder instances: pause/resume/clone and details. Pipeline editing arrives next.</div>
      {error && <div className="error-box">{error}</div>}
      <div className="row" style={{ marginBottom: 12 }}>
        <input style={{ maxWidth: 260 }} placeholder="Filter name/tag…" value={filter} onChange={e => setFilter(e.target.value)} />
        <select style={{ maxWidth: 240 }} value={serverFilter} onChange={e => setServerFilter(e.target.value)}>
          <option value="">all servers</option>
          {usedServerIds.map(id => <option key={id} value={id}>{serverName(id)}</option>)}
        </select>
        <button onClick={load} disabled={busy}>Refresh</button>
        <span className="hint">{list.length} of {transcoders.length}</span>
      </div>
      <div className="panel">
        <table>
          <thead><tr><th>Name</th><th>Server</th><th>Tags</th><th>State</th><th></th></tr></thead>
          <tbody>
            {list.map(t => (
              <tr key={t.id}>
                <td><b>{t.name}</b>{t.description && <div className="hint">{t.description}</div>}</td>
                <td className="mono">{serverName(t.server_id)}</td>
                <td>{(t.tags || []).map(x => <span key={x} className="badge" style={{ marginRight: 3 }}>{x}</span>)}</td>
                <td><span className={'lamp ' + (t.paused ? 'off' : 'on')} />{t.paused ? 'paused' : 'running'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button onClick={() => openDetail(t)}>Details</button>{' '}
                  {can('wmsobjects.manage') && <>
                    {t.paused
                      ? <button className="primary" disabled={busy} onClick={() => act(t, 'resume')}>Resume</button>
                      : <button disabled={busy} onClick={() => act(t, 'pause')}>Pause</button>}{' '}
                    <button disabled={busy} onClick={() => act(t, 'clone')}>Clone</button>{' '}
                    <button disabled={busy} onClick={() => setEditModal({ id: t.id, name: t.name, description: t.description || '', tags: (t.tags || []).join(',') })}>Edit</button>{' '}
                    <button className="danger" disabled={busy} onClick={async () => {
                      if (!window.confirm(`DELETE transcoder "${t.name}"? Its pipelines are removed permanently.`)) return;
                      setBusy(true); setError('');
                      try { await api(`/wmspanel/transcoders/${t.id}`, { method: 'DELETE' }); await load(); }
                      catch (e) { setError(e.message); }
                      finally { setBusy(false); }
                    }}>Delete</button>
                  </>}
                </td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={5} className="hint">No transcoders match.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Transcoder licenses</h2>
        <table>
          <thead><tr><th>Server</th><th>Status</th><th>Started</th><th>Expires</th><th></th></tr></thead>
          <tbody>
            {licenses.map((l, i) => {
              const dl = daysLeft(l.expire);
              return (
                <tr key={i}>
                  <td>{l.server || '—'}</td>
                  <td><span className={'lamp ' + (l.status === 'Active' ? 'on' : 'off')} />{l.status}</td>
                  <td className="hint">{l.started}</td>
                  <td className="mono">{l.expire}</td>
                  <td>{dl <= 30 && dl >= 0 && <span className="badge" style={{ background: '#5c4a2a', color: '#e8d5a8' }}>expires in {dl}d</span>}
                      {dl < 0 && <span className="badge" style={{ background: '#4a2020', color: '#e8a8a8' }}>expired</span>}</td>
                </tr>
              );
            })}
            {licenses.length === 0 && <tr><td colSpan={5} className="hint">No transcoder licenses visible.</td></tr>}
          </tbody>
        </table>
      </div>

      {editModal && (
        <div className="modal-back" onClick={() => setEditModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Edit transcoder</h3>
            <label>Name</label>
            <input value={editModal.name} onChange={e => setEditModal(m => ({ ...m, name: e.target.value }))} />
            <label>Description</label>
            <input value={editModal.description} onChange={e => setEditModal(m => ({ ...m, description: e.target.value }))} />
            <label>Tags (comma separated)</label>
            <input value={editModal.tags} onChange={e => setEditModal(m => ({ ...m, tags: e.target.value }))} />
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setEditModal(null)}>Cancel</button>
              <button className="primary" disabled={busy || !editModal.name} onClick={async () => {
                setBusy(true); setError('');
                try {
                  await api(`/wmspanel/transcoders/${editModal.id}`, { method: 'PUT', body: {
                    name: editModal.name, description: editModal.description,
                    tags: editModal.tags.split(',').map(x => x.trim()).filter(Boolean),
                  } });
                  setEditModal(null); await load();
                } catch (e) { setError(e.message); }
                finally { setBusy(false); }
              }}>Apply</button>
            </div>
          </div>
        </div>
      )}
      {detail && (
        <div className="modal-back" onClick={() => setDetail(null)}>
          <div className="modal" style={{ width: 700 }} onClick={e => e.stopPropagation()}>
            <h3>{detail.name}</h3>
            {detail.loading && <div className="hint">Loading…</div>}
            {detail.error && <div className="error-box">{detail.error}</div>}
            {detail.data && (
              <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 420, overflow: 'auto' }}>
                {JSON.stringify(detail.data, null, 2)}
              </pre>
            )}
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setDetail(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
