import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

const fmtBps = (b) => (b == null ? '—' : (Number(b) / 1e6).toFixed(2) + ' Mbps');

// ---------------------------------------------------------------------------
// WMSPanel mode: PERSISTENT rules via WMSPanel Control API.
// Field names mirror the republish family (src_app/src_stream/dest_*). Raw
// upstream JSON is always available via "Raw" toggle so any schema deviation
// on a live account is immediately visible and fixable.
// ---------------------------------------------------------------------------
function WmspanelRules({ serverId }) {
  const { can } = useAuth();
  const [rules, setRules] = useState(null);
  const [raw, setRaw] = useState(null);
  const [showRaw, setShowRaw] = useState(false);
  const [error, setError] = useState('');
  // Canonical WMSPanel republish fields: src_app/src_strm, dest_app/dest_strm
  const [edit, setEdit] = useState(null); // { ruleId, src_app, src_strm }
  const [full, setFull] = useState(null); // full-rule edit modal
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ src_app: '', src_strm: '', dest_addr: '', dest_port: 1935, dest_app: '', dest_strm: '' });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const load = async () => {
    setError('');
    try {
      const data = await api(`/wmspanel/server/${serverId}/republish`);
      setRaw(data);
      setRules(data.rules || data.republish_rules || []);
    } catch (e) { setError(e.message); setRules([]); }
  };
  useEffect(() => { load(); }, [serverId]);

  const act = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); await load(); }
    catch (e) { setError(e.message + (e.data?.upstream ? ' :: ' + JSON.stringify(e.data.upstream) : '')); }
    finally { setBusy(false); }
  };

  const saveEdit = () => act(async () => {
    await api(`/wmspanel/server/${serverId}/republish/${edit.ruleId}`, {
      method: 'PUT', body: { src_app: edit.src_app, src_strm: edit.src_strm },
    });
    setEdit(null);
  });

  const create = () => act(async () => {
    await api(`/wmspanel/server/${serverId}/republish`, {
      method: 'POST', body: { ...form, dest_port: Number(form.dest_port) },
    });
    setCreating(false);
    setForm({ src_app: '', src_strm: '', dest_addr: '', dest_port: 1935, dest_app: '', dest_strm: '' });
  });

  const remove = (rule) => {
    if (!window.confirm(`Delete PERSISTENT rule ${rule.src_app}/${rule.src_strm || '*'} → ${rule.dest_addr}? This changes WMSPanel config.`)) return;
    act(() => api(`/wmspanel/server/${serverId}/republish/${rule.id}`, { method: 'DELETE' }));
  };
  const restart = (rule) =>
    act(() => api(`/wmspanel/server/${serverId}/republish/${rule.id}/restart`, { method: 'POST' }));

  if (rules === null) return <div className="hint">Loading WMSPanel rules…</div>;
  return (
    <div>
      <div className="hint" style={{ marginBottom: 10 }}>
        <span className="lamp on" />Control plane: <b>WMSPanel API</b> — changes here are persistent and visible in WMSPanel.
        <button style={{ marginLeft: 12 }} onClick={() => setShowRaw(v => !v)}>{showRaw ? 'Hide raw' : 'Raw'}</button>
      </div>
      {error && <div className="error-box">{error}</div>}
      <div className="panel">
        <table>
          <thead><tr><th>ID</th><th>Source app/stream</th><th>Destination</th><th></th></tr></thead>
          <tbody>
            {rules.map(rule => (
              <tr key={rule.id}>
                <td className="mono">{String(rule.id).slice(-6)}</td>
                <td className="mono">
                  {edit?.ruleId === rule.id ? (
                    <span className="row">
                      <input style={{ width: 130 }} value={edit.src_app} onChange={e => setEdit(s => ({ ...s, src_app: e.target.value }))} />
                      /
                      <input style={{ width: 170 }} value={edit.src_strm} onChange={e => setEdit(s => ({ ...s, src_strm: e.target.value }))} />
                    </span>
                  ) : (
                    <b>{rule.src_app}/{rule.src_strm || '*'}</b>
                  )}
                </td>
                <td className="mono">{rule.dest_addr}:{rule.dest_port}/{rule.dest_app}/{rule.dest_strm}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {can('republish.manage') && (edit?.ruleId === rule.id ? (
                    <>
                      <button className="primary" disabled={busy} onClick={saveEdit}>Apply</button>{' '}
                      <button onClick={() => setEdit(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button disabled={busy}
                              onClick={() => setEdit({ ruleId: rule.id, src_app: rule.src_app || '', src_strm: rule.src_strm || '' })}>
                        Switch source
                      </button>{' '}
                      <button disabled={busy} onClick={() => setFull({
                        ruleId: rule.id, src_app: rule.src_app || '', src_strm: rule.src_strm || '',
                        dest_addr: rule.dest_addr || '', dest_port: rule.dest_port || 1935,
                        dest_app: rule.dest_app || '', dest_strm: rule.dest_strm || '',
                        description: rule.description || '', paused: Boolean(rule.paused),
                      })}>Edit</button>{' '}
                      <button disabled={busy} onClick={() => restart(rule)}>Restart</button>{' '}
                      <button className="danger" disabled={busy} onClick={() => remove(rule)}>Delete</button>
                    </>
                  ))}
                </td>
              </tr>
            ))}
            {rules.length === 0 && <tr><td colSpan={4} className="hint">No republish rules on the mapped WMSPanel server.</td></tr>}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={load} disabled={busy}>Refresh</button>
          {can('republish.manage') && <button onClick={() => setCreating(v => !v)}>{creating ? 'Close form' : '+ New rule'}</button>}
        </div>
      </div>
      {creating && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>New persistent rule (WMSPanel)</h2>
          <div className="field-inline">
            <div><label>Source app</label><input value={form.src_app} onChange={e => set('src_app', e.target.value)} /></div>
            <div><label>Source stream (empty = all)</label><input value={form.src_strm} onChange={e => set('src_strm', e.target.value)} /></div>
          </div>
          <div className="field-inline">
            <div><label>Dest address</label><input value={form.dest_addr} onChange={e => set('dest_addr', e.target.value)} /></div>
            <div><label>Dest port</label><input type="number" value={form.dest_port} onChange={e => set('dest_port', e.target.value)} /></div>
          </div>
          <div className="field-inline">
            <div><label>Dest app</label><input value={form.dest_app} onChange={e => set('dest_app', e.target.value)} /></div>
            <div><label>Dest stream</label><input value={form.dest_strm} onChange={e => set('dest_strm', e.target.value)} /></div>
          </div>
          <button className="primary" style={{ marginTop: 12 }} disabled={busy || !form.src_app || !form.dest_addr || !form.dest_app}
                  onClick={create}>{busy ? 'Creating…' : 'Create persistent rule'}</button>
        </div>
      )}
      {showRaw && (
        <div className="panel">
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 320, overflow: 'auto' }}>
            {JSON.stringify(raw, null, 2)}
          </pre>
        </div>
      )}
      {full && (
        <div className="modal-back" onClick={() => setFull(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Edit rule</h3>
            <div className="field-inline">
              <div><label>Source app</label><input value={full.src_app} onChange={e => setFull(m => ({ ...m, src_app: e.target.value }))} /></div>
              <div><label>Source stream</label><input value={full.src_strm} onChange={e => setFull(m => ({ ...m, src_strm: e.target.value }))} /></div>
            </div>
            <div className="field-inline">
              <div><label>Dest address</label><input value={full.dest_addr} onChange={e => setFull(m => ({ ...m, dest_addr: e.target.value }))} /></div>
              <div><label>Dest port</label><input type="number" value={full.dest_port} onChange={e => setFull(m => ({ ...m, dest_port: e.target.value }))} /></div>
            </div>
            <div className="field-inline">
              <div><label>Dest app</label><input value={full.dest_app} onChange={e => setFull(m => ({ ...m, dest_app: e.target.value }))} /></div>
              <div><label>Dest stream</label><input value={full.dest_strm} onChange={e => setFull(m => ({ ...m, dest_strm: e.target.value }))} /></div>
            </div>
            <label>Description</label>
            <input value={full.description} onChange={e => setFull(m => ({ ...m, description: e.target.value }))} />
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={full.paused}
                     onChange={e => setFull(m => ({ ...m, paused: e.target.checked }))} /> Paused
            </label>
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setFull(null)}>Cancel</button>
              <button className="primary" disabled={busy} onClick={() => act(async () => {
                const { ruleId, ...body } = full;
                body.dest_port = Number(body.dest_port);
                await api(`/wmspanel/server/${serverId}/republish/${ruleId}`, { method: 'PUT', body });
                setFull(null);
              })}>Apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Native mode (backup): ephemeral rules via Nimble native API. Kept from iter1.
// ---------------------------------------------------------------------------
function NativeRules({ serverId }) {
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
        Backup control plane (native API): rules below are <b>not persistent</b> — they reset on Nimble reload
        and cannot modify WMSPanel-created rules. If a WMSPanel rule for the same destination comes back
        online, two publishers may collide — remove backup rules manually after recovery.
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
                  <td className="mono">{rule.dest_addr}:{rule.dest_port}/{rule.dest_app}/{rule.dest_strm}</td>
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
        <div className="row" style={{ marginTop: 8 }}><button onClick={load}>Refresh</button></div>
      </div>
      {can('republish.manage') && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>New ephemeral rule (native)</h2>
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

export default function RepublishTab({ serverId, server }) {
  const { sys } = useAuth();
  if (!sys) return <div className="hint">Loading…</div>;

  const wantWmspanel = sys.controlPlane === 'wmspanel';
  if (wantWmspanel && !server?.wmspanelServerId) {
    return (
      <div className="error-box">
        Control plane is WMSPanel API, but this server is not mapped to a WMSPanel server id.
        Run "Sync now" on the Servers page or set the mapping in Servers → Edit.
      </div>
    );
  }
  return wantWmspanel ? <WmspanelRules serverId={serverId} /> : <NativeRules serverId={serverId} />;
}
