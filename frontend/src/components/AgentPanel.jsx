import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import Modal from './Modal.jsx';
import Select from './Select.jsx';

// Connecting a server's file agent, and deploying a playlist through it.
// Agents are optional: everything else in the panel works without them, so the
// UI states plainly which servers have one and which do not.
export function AgentServersModal({ servers, onClose, onChanged }) {
  const { t } = useI18n();
  const { push } = useToast();
  const [rows, setRows] = useState({});     // serverId -> { enabled, baseUrl, hasToken }
  const [health, setHealth] = useState({});
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const out = {};
    await Promise.all(servers.map(async s => {
      try { out[s.id] = await api(`/servers/${s.id}/agent`); } catch { out[s.id] = { enabled: false, baseUrl: '', hasToken: false }; }
    }));
    setRows(out);
  }, [servers]);
  useEffect(() => { load(); }, [load]);

  const set = (id, patch) => setRows(r => ({ ...r, [id]: { ...r[id], ...patch } }));

  const save = async (id) => {
    setBusy(id);
    try {
      const r = rows[id];
      await api(`/servers/${id}/agent`, { method: 'PUT', body: { enabled: r.enabled, baseUrl: r.baseUrl, token: r.token || '' } });
      set(id, { token: '', hasToken: r.token ? true : r.hasToken });
      push({ type: 'ok', message: t('agent.saved') });
      onChanged?.();
    } catch (e) { push({ type: 'error', message: e.message }); }
    finally { setBusy(''); }
  };

  const check = async (id) => {
    setBusy(id);
    setHealth(h => ({ ...h, [id]: null }));
    try {
      const data = await api(`/servers/${id}/agent/health`);
      setHealth(h => ({ ...h, [id]: { ok: true, data } }));
    }
    catch (e) { setHealth(h => ({ ...h, [id]: { ok: false, error: e.message } })); }
    finally { setBusy(''); }
  };

  return (
    <Modal onClose={onClose} size="wide">
      <h3>{t('agent.title')}</h3>
      <p className="hint">{t('agent.intro')}</p>
      <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
        {servers.map(s => {
          const r = rows[s.id] || {};
          const h = health[s.id];
          return (
            <div className="panel" key={s.id} style={{ marginBottom: 8 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <b>{s.name}</b>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
                  <input type="checkbox" checked={Boolean(r.enabled)} onChange={e => set(s.id, { enabled: e.target.checked })} />
                  {t('agent.enabled')}
                </label>
              </div>
              {r.enabled && (
                <div className="grid" style={{ gridTemplateColumns: '2fr 2fr auto', gap: 8, alignItems: 'end', marginTop: 8 }}>
                  <div>
                    <label>{t('agent.baseUrl')}</label>
                    <input className="mono" placeholder="http://10.0.0.5:8090" value={r.baseUrl || ''}
                           onChange={e => set(s.id, { baseUrl: e.target.value })} />
                  </div>
                  <div>
                    <label>{r.hasToken ? t('agent.tokenSet') : t('agent.token')}</label>
                    <input type="password" className="mono" value={r.token || ''}
                           placeholder={r.hasToken ? '••••••••' : ''}
                           onChange={e => set(s.id, { token: e.target.value })} />
                  </div>
                  <div className="row">
                    <button disabled={busy === s.id} onClick={() => save(s.id)}>{t('action.save')}</button>
                    <button disabled={busy === s.id || !r.baseUrl} onClick={() => check(s.id)}>{t('agent.check')}</button>
                  </div>
                </div>
              )}
              {h && (h.ok
                ? <div className="hint" style={{ marginTop: 6 }}>
                    ✓ {t('agent.ok', { conf: h.data.confDir, media: h.data.mediaDir })}
                    {h.data.confExists === false && <> · {t('agent.dirWillBeCreated')}</>}
                  </div>
                : <div className="error-box" style={{ marginTop: 6 }}>{h.error}</div>)}
            </div>
          );
        })}
        {servers.length === 0 && <div className="hint">{t('agent.noServers')}</div>}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onClose}>{t('action.close')}</button>
      </div>
    </Modal>
  );
}

export function DeployPlaylistModal({ playlist, servers, onClose }) {
  const { t } = useI18n();
  const { push } = useToast();
  const [serverId, setServerId] = useState('');
  const [filename, setFilename] = useState('playlist.json');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const deploy = async () => {
    setBusy(true); setError('');
    try {
      setResult(await api(`/servers/${serverId}/agent/deploy-playlist`, {
        method: 'POST', body: { playlistId: playlist.id, filename },
      }));
      push({ type: 'ok', message: t('agent.deployed') });
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose}>
      <h3>{t('agent.deployTitle', { name: playlist.name })}</h3>
      {error && <div className="error-box">{error}</div>}
      <label>{t('cat.server')}</label>
      <Select value={serverId} onChange={setServerId} searchable
              options={[{ value: '', label: '— ' + t('cat.pickServer') + ' —' },
                        ...servers.map(s => ({ value: s.id, label: s.name }))]} />
      <label>{t('agent.filename')}</label>
      <input className="mono" value={filename} onChange={e => setFilename(e.target.value)} />
      <div className="hint" style={{ marginTop: 6 }}>{t('agent.deployHint')}</div>
      {result && (
        <div className="picked-row" style={{ marginTop: 10 }}>
          <span className="picked-tag">OK</span>
          <b className="mono picked-val">{result.name} · {result.size} B</b>
        </div>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onClose}>{t('action.close')}</button>
        <button className="primary" disabled={busy || !serverId || !filename.trim()} onClick={deploy}>
          {busy ? '…' : t('agent.deploy')}
        </button>
      </div>
    </Modal>
  );
}
