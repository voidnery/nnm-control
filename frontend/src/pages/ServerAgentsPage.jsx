import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import SearchInput from '../components/SearchInput.jsx';
import AgentInstallModal from '../components/AgentInstallModal.jsx';
import AgentCentreModal from '../components/AgentCentreModal.jsx';

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
  const [rows, setRows] = useState({});      // serverId -> { enabled, hasToken, token }
  const [health, setHealth] = useState({});
  const [diag, setDiag] = useState({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [purposeFilter, setPurposeFilter] = useState('all');
  const [install, setInstall] = useState(null);
  const [centre, setCentre] = useState(false);
  const [fleet, setFleet] = useState(null);

  const load = useCallback(async () => {
    try {
      const list = await api('/servers');
      setServers(list);
      const out = {};
      await Promise.all(list.map(async s => {
        try { out[s.id] = await api(`/servers/${s.id}/agent`); }
        catch { out[s.id] = { enabled: false, hasToken: false }; }
      }));
      setRows(out);
      // iter12 m4 — the diagnosis is loaded with the list rather than on
      // demand: an operator opening this page is usually here because
      // something is wrong, and making them click to find out which kind of
      // wrong is the whole problem it exists to solve.
      const dg = {};
      await Promise.all(list.filter(x => out[x.id]?.enabled).map(async x => {
        try { dg[x.id] = await api(`/servers/${x.id}/agent/diagnosis`); } catch { /* shown as unknown */ }
      }));
      setDiag(dg);
      // A summary line at the top, so the page says whether anything needs
      // attention before the operator scrolls thirteen rows looking.
      api('/agent-fleet/overview').then(setFleet).catch(() => setFleet(null));
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (id, patch) => setRows(r => ({ ...r, [id]: { ...r[id], ...patch } }));

  const save = async (id) => {
    setBusy(id);
    try {
      const r = rows[id];
      await api(`/servers/${id}/agent`, { method: 'PUT', body: { enabled: r.enabled, token: r.token || '' } });
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
  const shown = servers.filter(s => !q || `${s.name} ${s.host || ''}`.toLowerCase().includes(q))
    .filter(s => purposeFilter === 'all' || (s.purpose || 'nimble') === purposeFilter);
  // Grouped by what each machine is for, because the same agent does different
  // jobs on different boxes: a gateway has no media server on it, and half of
  // what this page reports about a Nimble host is meaningless there.
  const byPurpose = { nimble: [], 'nimble-cdn': [], gateway: [] };
  for (const s2 of shown) (byPurpose[s2.purpose || 'nimble'] ||= []).push(s2);
  const configured = servers.filter(s => rows[s.id]?.enabled).length;

  return (
    <div>
      <h1>{t('page.agents.title')}</h1>
      <div className="sub">{t('page.agents.sub')}</div>
      {error && <div className="error-box">{error}</div>}

      {/* One button, everything about agents behind it: what is running, what
          is behind, what has gone wrong, and how to recover it. */}
      <div className="row" style={{ marginBottom: 12, alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 10 }}>
          <SearchInput style={{ maxWidth: 260 }} value={filter} onChange={setFilter} placeholder={t('agent.filter')} />
          {/* What each machine is for. Not a cosmetic grouping: it decides
              which checks apply, and a gateway judged as a media server reads
              as broken while being perfectly correct. */}
          {['all', 'nimble', 'nimble-cdn', 'gateway'].map(v => (
            <button key={v} className={'tagchip' + (purposeFilter === v ? ' on' : '')}
                    onClick={() => setPurposeFilter(v)}>
              {t('agent.purpose.' + v)}
              {v !== 'all' && <span className="hint"> {(byPurpose[v] || []).length}</span>}
            </button>
          ))}
          <button onClick={load}>{t('action.refresh')}</button>
          <span className="hint">{t('agent.countConfigured', { n: configured, total: servers.length })}</span>
        </div>
        <div className="row" style={{ flexShrink: 0, gap: 8 }}>
          {fleet?.summary?.faulty > 0 && (
            <span className="badge err">{t('ac.sFaulty', { n: fleet.summary.faulty })}</span>
          )}
          {fleet?.summary?.outdated > 0 && (
            <span className="badge">{t('ac.sOutdated', { n: fleet.summary.outdated })}</span>
          )}
          <button className={fleet?.summary?.faulty || fleet?.summary?.outdated ? 'primary' : ''}
                  onClick={() => setCentre(true)}>{t('ac.open')}</button>
        </div>
      </div>

      {shown.map(s => {
        const r = rows[s.id] || {};
        const h = health[s.id];
        return (
          <div className="panel" key={s.id} style={{ marginBottom: 8 }}>
            {/* Identity on the left, every control grouped on the right.
                Three children directly under space-between spread evenly, which
                is what left the checkbox floating in the middle of the row. */}
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ minWidth: 0 }}>
                <b>{s.name}</b>
                <div className="hint mono">{s.host || '—'}</div>
              </div>
              <div className="row" style={{ gap: 12, flexShrink: 0 }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
                  <input type="checkbox" checked={Boolean(r.enabled)} onChange={e => set(s.id, { enabled: e.target.checked })} />
                  {t('agent.enabled')}
                </label>
                {/* Installing is a different act from configuring an agent that
                    is already there, so it stays its own action. */}
                <button onClick={() => setInstall(s)}>{r.enabled ? t('inst.reinstall') : t('inst.install')}</button>
              </div>
            </div>
            {/* iter12 m5 — no address field. The token is normally set by
                enrollment and never shown again; this stays for the case where
                an operator rotated it on the box by hand. */}
            {r.enabled && (
              <div className="grid" style={{ gridTemplateColumns: '3fr auto', gap: 8, alignItems: 'end', marginTop: 8 }}>
                <div>
                  <label>{r.hasToken ? t('agent.tokenSet') : t('agent.token')}</label>
                  <input type="password" className="mono" value={r.token || ''}
                         placeholder={r.hasToken ? '••••••••' : ''}
                         onChange={e => set(s.id, { token: e.target.value })} />
                </div>
                <div className="row" style={{ flexShrink: 0 }}>
                  <button className="primary" disabled={busy === s.id} onClick={() => save(s.id)}>{t('action.save')}</button>
                  <button disabled={busy === s.id} onClick={() => check(s.id)}>{t('agent.check')}</button>
                </div>
              </div>
            )}
            {/* Which NICs to graph. The agent reports what it has, so this is a
                choice from a real list rather than a name typed from memory —
                and empty means every physical interface, which is the right
                default on a box with one. */}
            {r.enabled && (r.availableInterfaces || []).length > 0 && (
              <div style={{ marginTop: 6 }}>
                <label>{t('agent.interfaces')}</label>
                <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                  {(r.availableInterfaces || []).map(iface => (
                    <label key={iface} style={{ display: 'flex', gap: 5, alignItems: 'center', margin: 0 }}>
                      <input type="checkbox"
                             checked={(r.interfaces || []).includes(iface)}
                             onChange={e => set(s.id, {
                               interfaces: e.target.checked
                                 ? [...(r.interfaces || []), iface]
                                 : (r.interfaces || []).filter(x => x !== iface),
                             })} />
                      <span className="mono">{iface}</span>
                    </label>
                  ))}
                </div>
                <div className="hint">
                  {(r.interfaces || []).length ? t('agent.interfacesSome') : t('agent.interfacesAll')}
                </div>
              </div>
            )}
            {r.enabled && diag[s.id] && diag[s.id].code !== 'healthy' && diag[s.id].code !== 'not-configured' && (
              <div className="error-box" style={{ marginTop: 8 }}>
                <b>{t(`agent.diag.${diag[s.id].code}`)}</b>
                <div className="hint" style={{ marginTop: 2 }}>{diag[s.id].evidence}</div>
                {diag[s.id].hint && <div style={{ marginTop: 4 }}>{t(diag[s.id].hint)}</div>}
              </div>
            )}
            {/* Which NICs to graph. The agent reports what it has, so this is a
                choice from a real list rather than a name typed from memory —
                and empty means every physical interface, which is the right
                default on a box with one. */}
            {r.enabled && (r.availableInterfaces || []).length > 0 && (
              <div style={{ marginTop: 6 }}>
                <label>{t('agent.interfaces')}</label>
                <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                  {(r.availableInterfaces || []).map(iface => (
                    <label key={iface} style={{ display: 'flex', gap: 5, alignItems: 'center', margin: 0 }}>
                      <input type="checkbox"
                             checked={(r.interfaces || []).includes(iface)}
                             onChange={e => set(s.id, {
                               interfaces: e.target.checked
                                 ? [...(r.interfaces || []), iface]
                                 : (r.interfaces || []).filter(x => x !== iface),
                             })} />
                      <span className="mono">{iface}</span>
                    </label>
                  ))}
                </div>
                <div className="hint">
                  {(r.interfaces || []).length ? t('agent.interfacesSome') : t('agent.interfacesAll')}
                </div>
              </div>
            )}
            {r.enabled && diag[s.id]?.code === 'healthy' && (
              <div className="hint" style={{ marginTop: 8 }}>
                ✓ {t('agent.diag.healthy')}
                {diag[s.id].lastContactAt && <> · {t('agent.lastContact', { ago: Math.round((diag[s.id].sinceContactMs || 0) / 1000) })}</>}
                {diag[s.id].agentVersion ? <> · v{diag[s.id].agentVersion}</> : null}
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
      {install && (
        <AgentInstallModal server={install} onClose={() => setInstall(null)} onEnrolled={load} />
      )}
      {centre && <AgentCentreModal onClose={() => setCentre(false)} onChanged={load} />}
    </div>
  );
}
