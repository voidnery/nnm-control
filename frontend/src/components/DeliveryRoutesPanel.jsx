import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import { useConfirm } from '../confirm.jsx';
import IconButton from './IconButton.jsx';
import DeliveryFlowBoard from './DeliveryFlowBoard.jsx';

// What the network implies, before anything is written.
//
// The plan is shown, not summarised: an operator about to point four edges at
// an origin should read the exact `from` and `to` that will be created, on
// which server, and every reason it might not behave as it reads. Blocking
// findings refuse the apply button rather than warning next to an enabled one.
const SEV = { block: 'err', warn: 'warn', note: '' };
const VERDICT = {
  flowing: 'live', 'origin-only': 'err', 'no-route': 'err',
  'nothing-upstream': '', 'edge-unreachable': 'warn', 'origin-unknown': 'warn',
};
export default function DeliveryRoutesPanel({ network, servers = [], dirty = false }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const { push } = useToast();
  const confirm = useConfirm();
  // The applications used to be typed into a box every visit and forgotten.
  // They are channels now: stored, named, and shared with the dashboard, so
  // this tab shows a list rather than asking the same question again.
  const [chans, setChans] = useState(null);
  const [sel, setSel] = useState('');
  const [plan, setPlan] = useState(null);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // What is actually on the account, as opposed to what a plan would do about
  // it. Without this the operator applies a route and has nowhere to look:
  // the panel showed intent and never state, and WMSPanel's own list lives
  // three menus away and per server.
  const [live, setLive] = useState(null);
  // What the servers say, as opposed to what is configured. Asked over the
  // native Nimble API, so it costs no WMSPanel quota and can be refreshed as
  // often as the operator wants to look.
  const [state, setState] = useState(null);
  const [showLive, setShowLive] = useState(false);
  const [watch, setWatch] = useState({});        // "edge|app" -> probe result

  // Live mode, the same shape the transcoder graph uses: an operator during a
  // broadcast wants the tab open and answering, not a button to keep pressing.
  const [autoRefresh, setAutoRefresh] = useState(false);
  // Offered rather than demanded. The page used to open with an empty field
  // and three disabled buttons, expecting the operator to know the names —
  // which live on the origin, so the panel goes and reads them.
  const [found, setFound] = useState(null);

  const loadApps = async () => {
    try { setFound(await api(`/cdn/networks/${network.id}/applications`)); }
    catch { setFound({ applications: [], asked: [] }); }
  };
  const loadChannels = async () => {
    try {
      const r = await api('/cdn/channels');
      const mine = (r.channels || []).filter(c => String(c.network) === String(network.id));
      setChans(mine);
      setSel(cur => (mine.some(c => c.id === cur) ? cur : (mine[0]?.id || '')));
    } catch { setChans([]); }
  };
  useEffect(() => { loadApps(); loadChannels(); }, [network.id]);

  // Adding a channel from what the origin is actually publishing: the stream
  // name is right there, and typing it again is how it gets typed wrong.
  const addChannel = async (application, stream) => {
    setBusy(true); setError('');
    try {
      await api('/cdn/channels', { method: 'POST', body: { application, stream, network: network.id } });
      await loadChannels();
    } catch (e) { setError(e.data?.code === 'channel-exists' ? t('ch.exists') : e.message); }
    finally { setBusy(false); }
  };



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

  // The plan and the state work per application; the detail works per channel.
  const list = [...new Set((chans || []).map(c => c.application))];
  const selected = (chans || []).find(c => c.id === sel) || null;

  const loadState = async () => {
    if (!list.length) { setState(null); return; }
    setBusy(true);
    try { setState(await api(`/cdn/networks/${network.id}/state`, { method: 'POST', body: { channels: list } })); }
    catch (e) { setError(e.data?.error || e.message); }
    finally { setBusy(false); }
  };

  const removeRoute = async (r) => {
    // Deleting a route stops delivery on that edge the moment Nimble syncs.
    // Viewers notice; the confirmation says so rather than asking "are you
    // sure" about something whose consequence is invisible from here.
    if (!(await confirm({ message: t('cdn.confirmDelete2', { from: r.from, to: r.to }) }))) return;
    setBusy(true); setError('');
    try { await api(`/cdn/routes/${r.id}`, { method: 'DELETE' }); await loadLive(); await loadState();
          push({ type: 'ok', message: t('cdn.routeDeleted') }); }
    catch (e) { setError(e.data?.error || e.message); }
    finally { setBusy(false); }
  };

  // Be the viewer. This is the only question a pull-based edge can be asked,
  // since a re-streaming route holds nothing until somebody requests it.
  const watchNow = async (application) => {
    const stream = (chans || []).find(c => c.application === application)?.stream;
    if (!stream) return;
    setBusy(true); setError('');
    try {
      const r = await api(`/cdn/networks/${network.id}/watch`, {
        method: 'POST', body: { application, stream },
      });
      setWatch(w => ({ ...w, ...Object.fromEntries(r.results.map(x => [`${x.server}|${application}`, x])) }));
    } catch (e) { setError(e.data?.error || e.message); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (!autoRefresh || !list.length) return;
    const id = setInterval(() => { loadState(); }, 10_000);
    return () => clearInterval(id);
  }, [autoRefresh, channels]);

  const run = async (what) => {
    setBusy(true); setError(''); if (what === 'plan') setReport(null);
    try {
      const r = await api(`/cdn/networks/${network.id}/${what}`, { method: 'POST', body: { channels: list } });
      if (what === 'plan') setPlan(r);
      else { setReport(r); setPlan(r.plan || plan); await loadLive(); await loadState(); push({ type: r.ok ? 'ok' : 'warn', message: t('cdn.applied', { n: r.applied }) }); }
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

      {/* Numbered, because the three buttons used to sit side by side as
          equals and the order between them was something the operator had to
          already know. Each step's result appears under that step, not at the
          bottom of the page. */}
      <div className="gsection">{t('cdn.step1')}</div>
      {/* A list, not a text box. What is delivered here is a property of the
          network now, so the page can show it instead of asking. */}
      <div className="ch-picker">
        {(chans || []).map(c => (
          <button key={c.id} className={'tagchip' + (sel === c.id ? ' on' : '')} onClick={() => setSel(c.id)}>
            {c.label || `${c.application}/${c.stream}`}
          </button>
        ))}
        {chans && !chans.length && <span className="hint">{t('cdn.noChannels')}</span>}
      </div>
      {found?.applications?.length > 0 && can('cdn.manage') && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          <span className="hint">{t('cdn.addFromOrigin')}</span>
          {found.applications
            .filter(a => !(chans || []).some(c => c.application === a.application))
            .map(a => (
              <button key={a.application} disabled={busy}
                      onClick={() => addChannel(a.application, a.streams?.[0]?.stream || a.application)}>
                + {a.application}
              </button>
            ))}
        </div>
      )}

      <div className="gsection">{t('cdn.step2')}</div>
      <div className="row" style={{ gap: 8 }}>
        <button onClick={() => run('plan')} disabled={busy || !list.length || dirty}>{t('cdn.showPlan')}</button>
        {can('cdn.manage') && (
          <button className="primary" onClick={apply} disabled={busy || !plan || blocked || !work.length || dirty}>
            {busy ? '…' : t('cdn.apply', { n: work.length })}
          </button>
        )}
        {!plan && <span className="hint">{t('cdn.planFirst')}</span>}
      </div>

      {plan?.problems?.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {plan.problems.map((p, i) => (
            <div key={i} className={p.severity === 'block' ? 'error-box' : 'hint'} style={{ marginBottom: 4 }}>
              <span className={'badge ' + (SEV[p.severity] || '')}>{t('cdn.sev.' + p.severity)}</span>{' '}
              {t('cdn.problem.' + p.code) !== 'cdn.problem.' + p.code ? t('cdn.problem.' + p.code) : p.code}
              {p.server && <> · <b>{p.server}</b></>}
              {p.application && <> · <span className="mono">{p.application}</span></>}
              {p.detail && <div style={{ marginTop: 2 }}>{p.detail}</div>}
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
                  {p.was && <div className="hint" >{t('cdn.was')} {p.was}</div>}
                  {/* Where the two guessable parts came from, next to the value
                      they produced — the port especially, since an assumed one
                      produces a route that resolves and never serves. */}
                  {p.portSource === 'nimble-default' && (
                    <div className="hint" >{t('cdn.portAssumed')}</div>
                  )}
                </td>
              </tr>
            ))}
            {!plan.planned.length && <tr><td colSpan={4} className="hint">{t('cdn.nothingToDo')}</td></tr>}
          </tbody>
        </table>
      )}

      {report && (
        <div className="inset">
          <b>{report.ok ? t('cdn.applyDone', { n: report.applied }) : t('cdn.applyStopped', { n: report.applied })}</b>
          {report.steps?.map((s, i) => (
            <div key={i} className="hint" style={{ fontSize: 12 }}>
              {s.ok ? '✓' : '✗'} {s.step}
              {s.verified ? ` — ${s.verified}` : ''}
              {s.error ? ` — ${s.error}` : ''}
              {s.rolledBack ? ` · ${s.rolledBack}` : ''}
              {s.upstreamError && (
                <div className="mono" style={{ marginLeft: 14, wordBreak: 'break-all' }}>
                  {t('cdn.upstreamSaid')} {typeof s.upstreamError === 'string' ? s.upstreamError : JSON.stringify(s.upstreamError)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="gsection">{t('cdn.step3')}</div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={loadState} disabled={busy || !list.length}>{t('cdn.checkState')}</button>
        {/* From the channel. The stream name was typed here every time, next
            to the place that already knew it. */}
        {selected && <span className="mono hint">{selected.application}/{selected.stream}</span>}
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0, fontSize: 12 }}>
          <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
          {t('cdn.liveMode')}
        </label>
        {!state && <span className="hint">{t('cdn.stateWhy')}</span>}
      </div>

      {state && (
        <div style={{ marginTop: 10 }}>
          {/* One line, always the same shape, so a glance during a broadcast
              answers "is anything wrong" without reading the boards. */}
          <div className="picked-row" style={{ marginBottom: 8 }}>
            <span className="picked-tag">{t('cdn.summary')}</span>
            {t('cdn.summaryLine', {
              flowing: state.summary.flowing, idle: state.summary.idle ?? 0,
              broken: state.summary.broken, unknown: state.summary.unknown,
            })}
          </div>
          <div className="hint" >{t('cdn.stateHint')}</div>
          {state.unreachable?.length > 0 && state.unreachable.map((u, i) => (
            <div key={i} className="hint" style={{ marginTop: 4 }}>
              <span className="badge warn">{t('cdn.unreachable')}</span>{' '}
              <b>{u.server}</b> — {t('cdn.reason.' + u.reason)}
              {u.error && <span className="mono" > · {u.error}</span>}
            </div>
          ))}
          {state.rows.map((r, i) => <DeliveryFlowBoard key={i} row={r} />)}
          {state.drift?.map((d, i) => (
            <div key={i} className="hint" style={{ marginTop: 4 }}>
              <span className="badge warn">{t('cdn.driftTag')}</span>{' '}
              {t('cdn.drift.' + d.code)}
              {d.edge && <> · {d.edge}</>} · <span className="mono">{d.from} → {d.to}</span>
            </div>
          ))}
        </div>
      )}

      {/* Reference, not part of the flow: folded away so the three steps above
          are what the page is, with the count visible so it is never a
          surprise that something is there. */}
      <div style={{ marginTop: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <button onClick={() => setShowLive(v => !v)}>
            {showLive ? '▾' : '▸'} {t('cdn.liveRoutes')}{live ? ` · ${live.length}` : ''}
          </button>
          {showLive && <button onClick={loadLive} disabled={busy}>{t('action.refresh')}</button>}
        </div>
        {showLive && <div className="hint" >{t('cdn.liveRoutesHint')}</div>}
        {showLive && <table style={{ marginTop: 6 }}>
          <thead><tr><th>{t('cdn.from')}</th><th>{t('cdn.to')}</th><th>{t('cdn.onServers')}</th><th /></tr></thead>
          <tbody>
            {(live || []).map(r => (
              <tr key={r.id}>
                <td className="mono" style={{ fontSize: 12 }}>{r.from}</td>
                <td className="mono" style={{ fontSize: 12 }}>{r.to}</td>
                <td style={{ fontSize: 12 }}>{(r.servers || []).map(nameOf).join(', ') || '—'}</td>
                <td>{can('cdn.manage') && <IconButton action="remove" danger disabled={busy} onClick={() => removeRoute(r)} />}</td>
              </tr>
            ))}
            {live && !live.length && <tr><td colSpan={4} className="hint">{t('cdn.noLiveRoutes')}</td></tr>}
            {!live && <tr><td colSpan={4} className="hint">{t('sd.loading')}</td></tr>}
          </tbody>
        </table>}
      </div>

    </div>
  );
}
