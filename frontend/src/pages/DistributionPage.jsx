import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { backdropClose } from '../components/Modal.jsx';

// Account-level distribution: ABR ladders, application aliases, origin apps.
// server_ids are edited as checkboxes of mapped panel servers and displayed
// as names, never as raw WMSPanel ids.

function ServerPicker({ servers, value, onChange }) {
  const toggle = (wsid) => {
    const next = new Set(value);
    if (next.has(wsid)) next.delete(wsid); else next.add(wsid);
    onChange([...next]);
  };
  const mapped = servers.filter(s => s.wmspanelServerId);
  return (
    <div className="perm-grid">
      {mapped.map(s => (
        <label key={s.id}>
          <input type="checkbox" checked={value.includes(s.wmspanelServerId)} onChange={() => toggle(s.wmspanelServerId)} />
          <span>{s.name}</span>
        </label>
      ))}
      {mapped.length === 0 && <span className="hint">No mapped servers.</span>}
    </div>
  );
}

export default function DistributionPage() {
  const { can } = useAuth();
  const [servers, setServers] = useState([]);
  const [abr, setAbr] = useState(null);
  const [aliases, setAliases] = useState(null);
  const [origins, setOrigins] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [abrModal, setAbrModal] = useState(null);
  const [aliasModal, setAliasModal] = useState(null);
  const [originModal, setOriginModal] = useState(null);

  const load = async () => {
    setError('');
    try {
      const [s, a, al, o] = await Promise.all([
        api('/servers').catch(() => []),
        api('/wmspanel/abr'),
        api('/wmspanel/aliases'),
        api('/wmspanel/originapps'),
      ]);
      setServers(s);
      setAbr(a.settings || []);
      setAliases(al.settings || []);
      setOrigins(o.settings || []);
    } catch (e) { setError(e.message); setAbr([]); setAliases([]); setOrigins([]); }
  };
  useEffect(() => { load(); }, []);

  const serverNames = (ids) => (ids || []).length === 0
    ? <span className="hint">all servers</span>
    : (ids || []).map(id => servers.find(s => s.wmspanelServerId === id)?.name || String(id).slice(-6)).join(', ');

  const act = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  // ---- ABR ----
  const saveAbr = () => act(async () => {
    const body = {
      application: abrModal.application, stream: abrModal.stream,
      server_ids: abrModal.server_ids,
      source_streams: abrModal.sources.filter(x => x.application && x.stream)
        .map(x => ({ application: x.application, stream: x.stream })),
    };
    if (abrModal.id) await api(`/wmspanel/abr/${abrModal.id}`, { method: 'PUT', body });
    else await api('/wmspanel/abr', { method: 'POST', body });
    setAbrModal(null);
  });

  // ---- Alias ----
  const saveAlias = () => act(async () => {
    const body = {
      application: aliasModal.application,
      aliases: aliasModal.aliases.split('\n').map(x => x.trim()).filter(Boolean).map(a => ({ application: a })),
      protocols: aliasModal.protocols.split(',').map(x => x.trim()).filter(Boolean),
      server_ids: aliasModal.server_ids,
      description: aliasModal.description || '',
    };
    if (aliasModal.id) await api(`/wmspanel/aliases/${aliasModal.id}`, { method: 'PUT', body });
    else await api('/wmspanel/aliases', { method: 'POST', body });
    setAliasModal(null);
  });

  // ---- Origin app ----
  const saveOrigin = () => act(async () => {
    const body = { application: originModal.application, server_ids: originModal.server_ids };
    if (originModal.id) await api(`/wmspanel/originapps/${originModal.id}`, { method: 'PUT', body });
    else await api('/wmspanel/originapps', { method: 'POST', body });
    setOriginModal(null);
  });

  if (abr === null) return <div className="hint">Loading…</div>;
  return (
    <div>
      <h1>Distribution</h1>
      <div className="sub">Account-level: ABR ladders, application aliases and origin apps. Changes reach servers on the ~30s WMSPanel sync.</div>
      {error && <div className="error-box">{error}</div>}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>ABR
          {can('wmsobjects.manage') && (
            <button className="primary" style={{ marginLeft: 12 }} disabled={busy}
                    onClick={() => setAbrModal({ application: '', stream: '', server_ids: [], sources: [{ application: '', stream: '' }] })}>
              + New ABR
            </button>
          )}
        </h2>
        <table>
          <thead><tr><th>ABR output</th><th>Renditions</th><th>Servers</th><th></th></tr></thead>
          <tbody>
            {abr.map(o => (
              <tr key={o.id}>
                <td className="mono"><b>{o.application}/{o.stream}</b></td>
                <td className="mono hint">{(o.source_streams || []).map(ss => `${ss.application}/${ss.stream}`).join(', ')}</td>
                <td>{serverNames(o.server_ids)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {can('wmsobjects.manage') && <>
                    <button disabled={busy} onClick={() => setAbrModal({
                      id: o.id, application: o.application, stream: o.stream,
                      server_ids: o.server_ids || [],
                      sources: (o.source_streams || []).map(ss => ({ ...ss })),
                    })}>Edit</button>{' '}
                    <button className="danger" disabled={busy} onClick={() => {
                      if (window.confirm(`Delete ABR ${o.application}/${o.stream}?`))
                        act(() => api(`/wmspanel/abr/${o.id}`, { method: 'DELETE' }));
                    }}>Delete</button>
                  </>}
                </td>
              </tr>
            ))}
            {abr.length === 0 && <tr><td colSpan={4} className="hint">No ABR settings.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Aliases
          {can('wmsobjects.manage') && (
            <button className="primary" style={{ marginLeft: 12 }} disabled={busy}
                    onClick={() => setAliasModal({ application: '', aliases: '', protocols: 'HTTP,RTMP,RTSP,SRT', server_ids: [], description: '' })}>
              + New alias
            </button>
          )}
        </h2>
        <table>
          <thead><tr><th>Application</th><th>Aliases</th><th>Protocols</th><th>Servers</th><th>State</th><th></th></tr></thead>
          <tbody>
            {aliases.map(o => (
              <tr key={o.id}>
                <td className="mono"><b>{o.application}</b>{o.description && <div className="hint">{o.description}</div>}</td>
                <td className="mono">{(o.aliases || []).map(a => a.application).join(', ')}</td>
                <td>{(o.protocols || []).map(pr => <span key={pr} className="badge" style={{ marginRight: 3 }}>{pr}</span>)}</td>
                <td>{serverNames(o.server_ids)}</td>
                <td><span className={'lamp ' + (o.paused ? 'off' : 'on')} />{o.paused ? 'paused' : 'active'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {can('wmsobjects.manage') && <>
                    <button disabled={busy} onClick={() => act(() => api(`/wmspanel/aliases/${o.id}`, { method: 'PUT', body: { paused: !o.paused } }))}>
                      {o.paused ? 'Resume' : 'Pause'}
                    </button>{' '}
                    <button disabled={busy} onClick={() => setAliasModal({
                      id: o.id, application: o.application,
                      aliases: (o.aliases || []).map(a => a.application).join('\n'),
                      protocols: (o.protocols || []).join(','),
                      server_ids: o.server_ids || [], description: o.description || '',
                    })}>Edit</button>{' '}
                    <button className="danger" disabled={busy} onClick={() => {
                      if (window.confirm(`Delete alias set for ${o.application}?`))
                        act(() => api(`/wmspanel/aliases/${o.id}`, { method: 'DELETE' }));
                    }}>Delete</button>
                  </>}
                </td>
              </tr>
            ))}
            {aliases.length === 0 && <tr><td colSpan={6} className="hint">No aliases.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Origin apps
          {can('wmsobjects.manage') && (
            <button className="primary" style={{ marginLeft: 12 }} disabled={busy}
                    onClick={() => setOriginModal({ application: '', server_ids: [] })}>
              + New origin app
            </button>
          )}
        </h2>
        <table>
          <thead><tr><th>Application</th><th>Servers</th><th></th></tr></thead>
          <tbody>
            {origins.map(o => (
              <tr key={o.id}>
                <td className="mono"><b>{o.application}</b></td>
                <td>{serverNames(o.server_ids)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {can('wmsobjects.manage') && <>
                    <button disabled={busy} onClick={() => setOriginModal({ id: o.id, application: o.application, server_ids: o.server_ids || [] })}>Edit</button>{' '}
                    <button className="danger" disabled={busy} onClick={() => {
                      if (window.confirm(`Delete origin app ${o.application}?`))
                        act(() => api(`/wmspanel/originapps/${o.id}`, { method: 'DELETE' }));
                    }}>Delete</button>
                  </>}
                </td>
              </tr>
            ))}
            {origins.length === 0 && <tr><td colSpan={3} className="hint">No origin apps.</td></tr>}
          </tbody>
        </table>
      </div>

      {abrModal && (
        <div className="modal-back" {...backdropClose(() => setAbrModal(null))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{abrModal.id ? `Edit ABR ${abrModal.application}/${abrModal.stream}` : 'New ABR'}</h3>
            <div className="field-inline">
              <div><label>Output application</label><input value={abrModal.application} onChange={e => setAbrModal(m => ({ ...m, application: e.target.value }))} /></div>
              <div><label>Output stream</label><input value={abrModal.stream} onChange={e => setAbrModal(m => ({ ...m, stream: e.target.value }))} /></div>
            </div>
            <label>Renditions (top = highest quality)</label>
            {abrModal.sources.map((src, i) => (
              <div className="row" key={i} style={{ marginBottom: 6 }}>
                <input placeholder="application" value={src.application}
                       onChange={e => setAbrModal(m => ({ ...m, sources: m.sources.map((x, j) => j === i ? { ...x, application: e.target.value } : x) }))} />
                <input placeholder="stream" value={src.stream}
                       onChange={e => setAbrModal(m => ({ ...m, sources: m.sources.map((x, j) => j === i ? { ...x, stream: e.target.value } : x) }))} />
                <button onClick={() => setAbrModal(m => ({ ...m, sources: m.sources.filter((_, j) => j !== i) }))}>×</button>
              </div>
            ))}
            <button onClick={() => setAbrModal(m => ({ ...m, sources: [...m.sources, { application: '', stream: '' }] }))}>+ rendition</button>
            <label style={{ marginTop: 10 }}>Servers (none = all)</label>
            <ServerPicker servers={servers} value={abrModal.server_ids} onChange={v => setAbrModal(m => ({ ...m, server_ids: v }))} />
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setAbrModal(null)}>Cancel</button>
              <button className="primary" disabled={busy || !abrModal.application || !abrModal.stream} onClick={saveAbr}>
                {abrModal.id ? 'Apply' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {aliasModal && (
        <div className="modal-back" {...backdropClose(() => setAliasModal(null))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{aliasModal.id ? `Edit aliases of ${aliasModal.application}` : 'New alias set'}</h3>
            <label>Application</label>
            <input value={aliasModal.application} onChange={e => setAliasModal(m => ({ ...m, application: e.target.value }))} />
            <label>Aliases (one per line, e.g. bbtennis.tv)</label>
            <textarea className="mono" rows={3} value={aliasModal.aliases} onChange={e => setAliasModal(m => ({ ...m, aliases: e.target.value }))} />
            <label>Protocols (comma separated)</label>
            <input value={aliasModal.protocols} onChange={e => setAliasModal(m => ({ ...m, protocols: e.target.value }))} />
            <label>Description</label>
            <input value={aliasModal.description} onChange={e => setAliasModal(m => ({ ...m, description: e.target.value }))} />
            <label>Servers (none = all)</label>
            <ServerPicker servers={servers} value={aliasModal.server_ids} onChange={v => setAliasModal(m => ({ ...m, server_ids: v }))} />
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setAliasModal(null)}>Cancel</button>
              <button className="primary" disabled={busy || !aliasModal.application} onClick={saveAlias}>
                {aliasModal.id ? 'Apply' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {originModal && (
        <div className="modal-back" {...backdropClose(() => setOriginModal(null))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{originModal.id ? `Edit origin app ${originModal.application}` : 'New origin app'}</h3>
            <label>Application</label>
            <input value={originModal.application} onChange={e => setOriginModal(m => ({ ...m, application: e.target.value }))} />
            <label>Servers (none = all)</label>
            <ServerPicker servers={servers} value={originModal.server_ids} onChange={v => setOriginModal(m => ({ ...m, server_ids: v }))} />
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setOriginModal(null)}>Cancel</button>
              <button className="primary" disabled={busy || !originModal.application} onClick={saveOrigin}>
                {originModal.id ? 'Apply' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
