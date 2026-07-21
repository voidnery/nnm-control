import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

const EMPTY = { name: '', host: '', port: 8082, token: '', useSsl: false, tags: '', notes: '', wmspanelServerId: '' };

function ServerModal({ initial, onClose, onSaved, wms }) {
  const isEdit = Boolean(initial.id);
  const [wpServers, setWpServers] = useState(null); // null = loading/unavailable
  const [form, setForm] = useState({
    ...EMPTY, ...initial,
    token: '', // never prefilled — empty means "keep existing" on edit
    tags: (initial.tags || []).join(', '),
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  useEffect(() => {
    // WMSPanel mapping helper; silently unavailable until API creds are set.
    api('/wmspanel/servers').then(d => setWpServers(d.servers)).catch(() => setWpServers(null));
  }, []);

  const save = async () => {
    setBusy(true); setError('');
    try {
      const body = {
        name: form.name, host: form.host, port: Number(form.port) || 8082,
        useSsl: form.useSsl, notes: form.notes,
        tags: form.tags.split(',').map(t => t.trim()).filter(Boolean),
        wmspanelServerId: form.wmspanelServerId || '',
      };
      // On edit an empty token field means "do not change".
      if (!isEdit || form.token !== '') body.token = form.token;
      if (isEdit) await api(`/servers/${initial.id}`, { method: 'PUT', body });
      else await api('/servers', { method: 'POST', body });
      onSaved();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>{isEdit ? 'Edit server' : 'Add server'}</h3>
        <label>Name</label>
        <input value={form.name} onChange={e => set('name', e.target.value)} placeholder="edge-01" />
        <div className="field-inline">
          <div>
            <label>Host (IP or DNS)</label>
            <input value={form.host} onChange={e => set('host', e.target.value)} placeholder="10.77.0.10" />
          </div>
          {!wms && (
            <div>
              <label>Management port</label>
              <input type="number" value={form.port} onChange={e => set('port', e.target.value)} />
            </div>
          )}
        </div>
        {!wms && <>
          <label>Management token {isEdit && <span className="hint">(empty = keep current)</span>}</label>
          <input type="password" value={form.token} onChange={e => set('token', e.target.value)}
                 placeholder={initial.hasToken ? '••••••• (set)' : 'empty = no auth on server'} />
        </>}
        <label>WMSPanel server (for persistent control via WMSPanel API)</label>
        {wpServers ? (
          <select value={form.wmspanelServerId} onChange={e => set('wmspanelServerId', e.target.value)}>
            <option value="">— not mapped —</option>
            {wpServers.map(ws => <option key={ws.id} value={ws.id}>{ws.name} ({ws.status})</option>)}
          </select>
        ) : (
          <input value={form.wmspanelServerId} onChange={e => set('wmspanelServerId', e.target.value)}
                 placeholder="WMSPanel server id (auto-list needs API creds in Settings)" className="mono" />
        )}
        <label>Tags (comma separated)</label>
        <input value={form.tags} onChange={e => set('tags', e.target.value)} placeholder="edge, moscow" />
        <label>Notes</label>
        <textarea rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} />
        {!wms && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={form.useSsl}
                   onChange={e => set('useSsl', e.target.checked)} /> Use HTTPS to reach management API
          </label>
        )}
        {error && <div className="error-box">{error}</div>}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !form.name || !form.host} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ServersPage() {
  const { can, sys } = useAuth();
  const wms = sys?.controlPlane === 'wmspanel';
  const [servers, setServers] = useState([]);
  const [modal, setModal] = useState(null);
  const [testResults, setTestResults] = useState({});
  const [error, setError] = useState('');
  const [syncMsg, setSyncMsg] = useState(null);
  const [syncBusy, setSyncBusy] = useState(false);

  const load = () => api('/servers').then(setServers).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);

  const syncNow = async () => {
    setSyncBusy(true); setSyncMsg(null);
    try {
      const r = await api('/wmspanel/sync', { method: 'POST' });
      setSyncMsg(r.skipped ? { ok: false, text: `Sync skipped: ${r.reason}` }
                           : { ok: true, text: `Synced from WMSPanel: +${r.created} new, ${r.updated} updated (${r.remoteTotal} total)` });
      load();
    } catch (e) { setSyncMsg({ ok: false, text: e.message }); }
    finally { setSyncBusy(false); }
  };

  const test = async (id) => {
    setTestResults(r => ({ ...r, [id]: { busy: true } }));
    const result = await api(`/servers/${id}/test`, { method: 'POST' });
    setTestResults(r => ({ ...r, [id]: result }));
  };

  const remove = async (s) => {
    if (!window.confirm(`Delete server "${s.name}"? This only removes it from the panel.`)) return;
    await api(`/servers/${s.id}`, { method: 'DELETE' });
    load();
  };

  return (
    <div>
      <h1>Servers</h1>
      <div className="sub">Managed Nimble Streamer instances (native management API endpoints).</div>
      {error && <div className="error-box">{error}</div>}
      {wms && (
        <div className="panel" style={{ padding: '10px 14px' }}>
          <span className="lamp on" />Control plane: <b>WMSPanel API</b> — the fleet is pulled from WMSPanel automatically
          (every 10 min). Native management token is not known to WMSPanel — set it per server to enable live status.
          {can('servers.manage') && (
            <button style={{ marginLeft: 12 }} disabled={syncBusy} onClick={syncNow}>{syncBusy ? 'Syncing…' : 'Sync now'}</button>
          )}
          {syncMsg && <span className={syncMsg.ok ? 'hint' : ''} style={{ marginLeft: 10, color: syncMsg.ok ? undefined : 'var(--danger)' }}>{syncMsg.text}</span>}
        </div>
      )}
      {can('servers.manage') && (
        <button className="primary" style={{ marginBottom: 14 }} onClick={() => setModal({})}>+ Add server</button>
      )}
      <div className="panel">
        <table>
          <thead>
            <tr><th>Name</th><th>{wms ? 'Host' : 'Endpoint'}</th><th>Tags</th>{!wms && <th>Auth</th>}{!wms && <th>Check</th>}<th></th></tr>
          </thead>
          <tbody>
            {servers.map(s => {
              const t = testResults[s.id];
              return (
                <tr key={s.id}>
                  <td>
                    <Link to={`/servers/${s.id}`}><b>{s.name}</b></Link>
                    {s.syncedFromWmspanel && (
                      <span className="badge" style={{ marginLeft: 6 }}
                            title={'Auto-synced from WMSPanel' + (s.wmspanelStatus ? ` · panel status: ${s.wmspanelStatus}` : '')}>
                        WMS{s.wmspanelStatus ? `:${s.wmspanelStatus}` : ''}
                      </span>
                    )}
                  </td>
                  <td className="mono">{wms ? (s.host || '—') : `${s.useSsl ? 'https' : 'http'}://${s.host}:${s.port}`}</td>
                  <td>{s.tags.map(tag => <span key={tag} className="badge" style={{ marginRight: 4 }}>{tag}</span>)}</td>
                  {!wms && <td>{s.hasToken ? <span className="badge">token</span> : <span className="badge">open</span>}</td>}
                  {!wms && <td>
                    <button onClick={() => test(s.id)} disabled={t?.busy}>{t?.busy ? '…' : 'Test'}</button>{' '}
                    {t && !t.busy && (
                      <span className={'lamp ' + (t.ok ? 'on' : 'off')} title={t.ok ? 'OK' : t.error} />
                    )}
                  </td>}
                  <td style={{ textAlign: 'right' }}>
                    {can('servers.manage') && <>
                      <button onClick={() => setModal(s)}>Edit</button>{' '}
                      <button className="danger" onClick={() => remove(s)}>Delete</button>
                    </>}
                  </td>
                </tr>
              );
            })}
            {servers.length === 0 && <tr><td colSpan={wms ? 4 : 6} className="hint">No servers added yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && <ServerModal initial={modal} wms={wms} onClose={() => setModal(null)}
                             onSaved={() => { setModal(null); load(); }} />}
    </div>
  );
}
