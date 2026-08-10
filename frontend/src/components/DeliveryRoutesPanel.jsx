import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import { useConfirm } from '../confirm.jsx';

// What the network implies, before anything is written.
//
// The plan is shown, not summarised: an operator about to point four edges at
// an origin should read the exact `from` and `to` that will be created, on
// which server, and every reason it might not behave as it reads. Blocking
// findings refuse the apply button rather than warning next to an enabled one.
const SEV = { block: 'err', warn: 'warn', note: '' };

export default function DeliveryRoutesPanel({ network, servers = [], dirty = false }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const { push } = useToast();
  const confirm = useConfirm();
  const [channels, setChannels] = useState('');
  const [plan, setPlan] = useState(null);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // What is actually on the account, as opposed to what a plan would do about
  // it. Without this the operator applies a route and has nowhere to look:
  // the panel showed intent and never state, and WMSPanel's own list lives
  // three menus away and per server.
  const [live, setLive] = useState(null);

  const loadLive = async () => {
    try { const r = await api('/cdn/routes'); setLive(Array.isArray(r?.routes) ? r.routes : []); }
    catch { setLive([]); }
  };
  useEffect(() => { loadLive(); }, [network.id]);

  // WMSPanel ids mean nothing to a person; the fleet knows the names.
  const nameOf = useMemo(() => {
    const m = new Map(servers.filter(s => s.wmspanelServerId).map(s => [String(s.wmspanelServerId), s.name]));
    return (id) => m.get(String(id)) || String(id).slice(-6);
  }, [servers]);

  const list = channels.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);

  const run = async (what) => {
    setBusy(true); setError(''); if (what === 'plan') setReport(null);
    try {
      const r = await api(`/cdn/networks/${network.id}/${what}`, { method: 'POST', body: { channels: list } });
      if (what === 'plan') setPlan(r);
      else { setReport(r); setPlan(r.plan || plan); await loadLive(); push({ type: r.ok ? 'ok' : 'warn', message: t('cdn.applied', { n: r.applied }) }); }
    } catch (e) {
      // The response body is on `e.data` — reading `e.body` meant every
      // failure arrived as a bare status line while the thing worth reading,
      // the per-route steps and the upstream message, was thrown away.
      const d = e.data || {};
      // A blocked plan comes back 422 with the findings attached: that is the
      // answer, not a failure to get one.
      if (d.problems) setPlan(d);
      // A failed apply comes back 502 with the steps that got as far as they
      // did, which route stopped it, what WMSPanel said, and what was rolled
      // back. That is the whole point of running it through a plan.
      if (d.steps) setReport(d);
      setError(d.steps || d.problems ? '' : (e.message || String(e)));
    } finally { setBusy(false); }
  };

  const apply = async () => {
    if (!(await confirm({ message: t('cdn.confirmApply', { n: work.length, net: network.name }) }))) return;
    run('apply');
  };

  const work = (plan?.planned || []).filter(p => p.action !== 'keep');
  const blocked = (plan?.blocking || []).length > 0;

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>{t('cdn.routes')}</h2>
      <div className="hint">{t('cdn.routesHint')}</div>
      {error && <div className="error-box">{error}</div>}

      <label>{t('cdn.channels')}</label>
      <input className="mono" placeholder="kp_24-7 blastdotakk" value={channels}
             onChange={e => setChannels(e.target.value)} />
      <div className="hint" style={{ fontSize: 11 }}>{t('cdn.channelsHint')}</div>

      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button onClick={() => run('plan')} disabled={busy || !list.length || dirty}>{t('cdn.showPlan')}</button>
        {can('cdn.manage') && (
          <button className="primary" onClick={apply} disabled={busy || !plan || blocked || !work.length || dirty}>
            {busy ? '…' : t('cdn.apply', { n: work.length })}
          </button>
        )}
      </div>

      {plan?.problems?.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {plan.problems.map((p, i) => (
            <div key={i} className={p.severity === 'block' ? 'error-box' : 'hint'} style={{ marginBottom: 4 }}>
              <span className={'badge ' + (SEV[p.severity] || '')}>{t('cdn.sev.' + p.severity)}</span>{' '}
              {t('cdn.problem.' + p.code) !== 'cdn.problem.' + p.code ? t('cdn.problem.' + p.code) : p.code}
              {p.server && <> · <b>{p.server}</b></>}
              {p.application && <> · <span className="mono">{p.application}</span></>}
              {p.detail && <div style={{ fontSize: 11, marginTop: 2 }}>{p.detail}</div>}
            </div>
          ))}
        </div>
      )}

      {plan && (
        <table style={{ marginTop: 10 }}>
          <thead>
            <tr><th>{t('cdn.action')}</th><th>{t('cdn.server')}</th><th>{t('cdn.from')}</th><th>{t('cdn.to')}</th></tr>
          </thead>
          <tbody>
            {plan.planned.map((p, i) => (
              <tr key={i} style={{ opacity: p.action === 'keep' ? 0.55 : 1 }}>
                <td><span className={'badge' + (p.action === 'create' ? ' live' : '')}>{t('cdn.act.' + p.action)}</span></td>
                <td>{p.server}</td>
                <td className="mono" style={{ fontSize: 12 }}>{p.from}</td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {p.to}
                  {p.was && <div className="hint" style={{ fontSize: 11 }}>{t('cdn.was')} {p.was}</div>}
                  {/* Where the two guessable parts came from, next to the value
                      they produced — the port especially, since an assumed one
                      produces a route that resolves and never serves. */}
                  {p.portSource === 'nimble-default' && (
                    <div className="hint" style={{ fontSize: 11 }}>{t('cdn.portAssumed')}</div>
                  )}
                </td>
              </tr>
            ))}
            {!plan.planned.length && <tr><td colSpan={4} className="hint">{t('cdn.nothingToDo')}</td></tr>}
          </tbody>
        </table>
      )}

      <div style={{ marginTop: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <b>{t('cdn.liveRoutes')}</b>
          <button onClick={loadLive} disabled={busy}>{t('action.refresh')}</button>
        </div>
        <div className="hint" style={{ fontSize: 11 }}>{t('cdn.liveRoutesHint')}</div>
        <table style={{ marginTop: 6 }}>
          <thead><tr><th>{t('cdn.from')}</th><th>{t('cdn.to')}</th><th>{t('cdn.onServers')}</th></tr></thead>
          <tbody>
            {(live || []).map(r => (
              <tr key={r.id}>
                <td className="mono" style={{ fontSize: 12 }}>{r.from}</td>
                <td className="mono" style={{ fontSize: 12 }}>{r.to}</td>
                <td style={{ fontSize: 12 }}>{(r.servers || []).map(nameOf).join(', ') || '—'}</td>
              </tr>
            ))}
            {live && !live.length && <tr><td colSpan={3} className="hint">{t('cdn.noLiveRoutes')}</td></tr>}
            {!live && <tr><td colSpan={3} className="hint">{t('sd.loading')}</td></tr>}
          </tbody>
        </table>
      </div>

      {report && (
        <div className="panel" style={{ marginTop: 10 }}>
          <b>{report.ok ? t('cdn.applyDone', { n: report.applied }) : t('cdn.applyStopped', { n: report.applied })}</b>
          {report.steps?.map((s, i) => (
            <div key={i} className="hint" style={{ fontSize: 12 }}>
              {s.ok ? '✓' : '✗'} {s.step}
              {s.verified ? ` — ${s.verified}` : ''}
              {s.error ? ` — ${s.error}` : ''}
              {s.rolledBack ? ` · ${s.rolledBack}` : ''}
              {s.upstreamError && (
                <div className="mono" style={{ fontSize: 11, marginLeft: 14, wordBreak: 'break-all' }}>
                  {t('cdn.upstreamSaid')} {typeof s.upstreamError === 'string' ? s.upstreamError : JSON.stringify(s.upstreamError)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
