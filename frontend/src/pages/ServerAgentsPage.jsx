import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import SearchInput from '../components/SearchInput.jsx';

// Server agents used to live in a modal behind a button on the Playlists page,
// because deploying a playlist was the first thing an agent was needed for.
// That stopped being true: the agent is server infrastructure — it holds a
// per-server token, writes config files, and since iter10 m1 also serves the
// Nimble logs the collector tails. Playlists are one consumer of it, not its
// home. It is its own section now, and this page is where an operator sets one
// up and sees whether it is answering.
export default function ServerAgentsPage() {
  const { t } = useI18n();
  const { push } = useToast();
  const [servers, setServers] = useState(null);
  const [rows, setRows] = useState({});      // serverId -> { enabled, baseUrl, hasToken, token }
  const [health, setHealth] = useState({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    try {
      const list = await api('/servers');
      setServers(list);
      const out = {};
      await Promise.all(list.map(async s => {
        try { out[s.id] = await api(`/servers/${s.id}/agent`); }
        catch { out[s.id] = { enabled: false, baseUrl: '', hasToken: false }; }
      }));
      setRows(out);
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (id, patch) => setRows(r => ({ ...r, [id]: { ...r[id], ...patch } }));

  const save = async (id) => {
    setBusy(id);
    try {
      const r = rows[id];
      await api(`/servers/${id}/agent`, { method: 'PUT', body: { enabled: r.enabled, baseUrl: r.baseUrl, token: r.token || '' } });
      // The token is write-only: once stored it is never sent back, so the
      // field is cleared and the "set" marker updated rather than re-shown.
      set(id, { token: '', hasToken: r.token ? true : r.hasToken });
      push({ type: 'ok', message: t('agent.saved') });
    } catch (e) { push({ type: 'error', message: e.message }); }
    finally { setBusy(''); }
  };

  const check = async (id) => {
    setBusy(id);
    setHealth(h => ({ ...h, [id]: null }));
    try {
      const data = await api(`/servers/${id}/agent/health`);
      setHealth(h => ({ ...h, [id]: { ok: true, data } }));
    } catch (e) {
      setHealth(h => ({ ...h, [id]: { ok: false, error: e.message } }));
    } finally { setBusy(''); }
  };

  if (!servers) return <div className="hint">{t('sd.loading')}</div>;

  const q = filter.trim().toLowerCase();
  const shown = servers.filter(s => !q || `${s.name} ${s.host || ''}`.toLowerCase().includes(q));
  const configured = servers.filter(s => rows[s.id]?.enabled).length;

  return (
    <div>
      <h1>{t('page.agents.title')}</h1>
      <div className="sub">{t('page.agents.sub')}</div>
      {error && <div className="error-box">{error}</div>}

      <div className="row" style={{ marginBottom: 12, alignItems: 'center' }}>
        <SearchInput style={{ maxWidth: 260 }} value={filter} onChange={setFilter} placeholder={t('agent.filter')} />
        <button onClick={load}>{t('action.refresh')}</button>
        <span className="hint">{t('agent.countConfigured', { n: configured, total: servers.length })}</span>
      </div>

      {shown.map(s => {
        const r = rows[s.id] || {};
        const h = health[s.id];
        return (
          <div className="panel" key={s.id} style={{ marginBottom: 8 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <b>{s.name}</b>
                <div className="hint mono">{s.host || '—'}</div>
              </div>
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
                  {/* iter10 m1 — an agent that predates log support, or has it
                      switched off, cannot feed the log collector. Say so here
                      rather than leaving the Logs section mysteriously empty. */}
                  <div style={{ marginTop: 2 }}>
                    {h.data.logs
                      ? <>✓ {t('agent.logsOk', { dir: h.data.logDir })}{h.data.logExists === false && <> · {t('agent.logDirMissing')}</>}</>
                      : t('agent.logsOff')}
                    {h.data.version < 2 && <> · {t('agent.oldVersion')}</>}
                  </div>
                </div>
              : <div className="error-box" style={{ marginTop: 6 }}>{h.error}</div>)}
          </div>
        );
      })}
      {shown.length === 0 && <div className="panel hint">{t('agent.noServers')}</div>}
    </div>
  );
}
