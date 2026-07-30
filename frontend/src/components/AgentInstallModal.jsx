import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import Modal from './Modal.jsx';
import { copyText } from '../lib/clipboard.js';

// iter11 m1 — installing an agent without giving the panel a way into the box.
//
// The operator asks for a ticket, runs one command, and the server calls back.
// The panel never holds an SSH credential and never initiates anything.
//
// The dialog deliberately makes two distinctions the operator has to see:
//   * enrollment proves the SERVER reached the PANEL. Everything the panel
//     does afterwards runs the other way round, so the two are checked
//     separately and reported separately.
//   * a private address is fine on a shared network and fatal across NAT.
//     The panel says which one it is looking at rather than guessing.
export default function AgentInstallModal({ server, onClose, onEnrolled }) {
  const { t } = useI18n();
  const { push } = useToast();
  const [form, setForm] = useState({
    baseUrl: server.host ? `http://${server.host}:8090` : '',
    agentPort: 8090,
    logDir: '/var/log/nimble',
    // Whatever address the browser used is only a guess at what the SERVER can
    // use. A public name may have a certificate that does not cover it, or may
    // not resolve from inside the fleet at all, so this is editable.
    panelUrl: window.location.origin,
  });
  const [safe, setSafe] = useState(true);
  const [ticket, setTicket] = useState(null);
  const [status, setStatus] = useState(null);
  const [verify, setVerify] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const poll = useRef(null);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Polling stops the moment the ticket resolves either way — a dialog left
  // open overnight should not keep hitting the API.
  useEffect(() => {
    if (!ticket) return;
    const tick = async () => {
      try {
        const d = await api(`/servers/${server.id}/agent/enrollment`);
        setStatus(d.enrollment);
        if (d.enrollment?.status === 'enrolled') {
          clearInterval(poll.current); poll.current = null;
          setVerify(await api(`/servers/${server.id}/agent/verify`, { method: 'POST' }).catch(() => null));
          onEnrolled?.();
        } else if (d.enrollment?.status === 'expired' || d.enrollment?.status === 'revoked') {
          clearInterval(poll.current); poll.current = null;
        }
      } catch { /* transient; the next tick retries */ }
    };
    tick();
    poll.current = setInterval(tick, 3000);
    return () => { if (poll.current) clearInterval(poll.current); poll.current = null; };
  }, [ticket, server.id, onEnrolled]);

  const issue = async () => {
    setBusy(true); setError(''); setVerify(null); setStatus(null);
    try {
      setTicket(await api(`/servers/${server.id}/agent/enrollment`, {
        method: 'POST',
        body: {
          baseUrl: form.baseUrl.trim(),
          panelUrl: form.panelUrl.trim(),
          agentPort: Number(form.agentPort) || 8090,
          logDir: form.logDir.trim(),
        },
      }));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const revoke = async () => {
    try { await api(`/servers/${server.id}/agent/enrollment`, { method: 'DELETE' }); } catch { /* already gone */ }
    setTicket(null); setStatus(null); setVerify(null);
  };

  const copy = async (s) => push(await copyText(s)
    ? { type: 'ok', message: t('srt.copied') }
    : { type: 'error', message: t('copy.failed') });

  const state = status?.status || (ticket ? 'pending' : null);

  return (
    <Modal onClose={onClose} size="wide">
      <h3>{t('inst.title', { name: server.name })}</h3>

      {!ticket && (
        <>
          <p className="hint">{t('inst.intro')}</p>
          <div className="grid" style={{ gridTemplateColumns: '2fr 1fr', gap: 8 }}>
            <div>
              <label>{t('inst.baseUrl')}</label>
              <input className="mono" value={form.baseUrl} placeholder="http://10.0.0.5:8090"
                     onChange={e => set('baseUrl', e.target.value)} />
              <div className="hint">{t('inst.baseUrlHint')}</div>
            </div>
            <div>
              <label>{t('inst.port')}</label>
              <input type="number" value={form.agentPort} onChange={e => set('agentPort', e.target.value)} />
            </div>
          </div>
          <label>{t('inst.panelUrl')}</label>
          <input className="mono" value={form.panelUrl} onChange={e => set('panelUrl', e.target.value)} />
          <div className="hint">{t('inst.panelUrlHint')}</div>
          <label>{t('inst.logDir')}</label>
          <input className="mono" value={form.logDir} onChange={e => set('logDir', e.target.value)} />
          {error && <div className="error-box">{error}</div>}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <button onClick={onClose}>{t('action.cancel')}</button>
            <button className="primary" disabled={busy || !form.baseUrl.trim()} onClick={issue}>
              {busy ? '…' : t('inst.issue')}
            </button>
          </div>
        </>
      )}

      {ticket && (
        <>
          {ticket.warnings?.includes('panelNotHttps') && (
            <div className="error-box">{t('inst.warnHttp')}</div>
          )}
          {ticket.warnings?.includes('panelPrivateAddress') && (
            <div className="hint" style={{ marginBottom: 8 }}>{t('inst.warnPanelPrivate')}</div>
          )}

          <p className="hint">{t('inst.runThis')}</p>
          <div className="row" style={{ gap: 12, marginBottom: 6 }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
              <input type="radio" checked={safe} onChange={() => setSafe(true)} />{t('inst.formVerified')}
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
              <input type="radio" checked={!safe} onChange={() => setSafe(false)} />{t('inst.formShort')}
            </label>
          </div>
          <div className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
            <textarea readOnly rows={safe ? 4 : 2} className="mono" style={{ flex: 1, fontSize: 12 }}
                      value={safe ? ticket.safeCommand : ticket.command} onFocus={e => e.target.select()} />
            <button onClick={() => copy(safe ? ticket.safeCommand : ticket.command)}>{t('srt.copy')}</button>
          </div>
          <div className="hint" style={{ marginTop: 4 }}>
            {safe ? t('inst.verifiedHint') : t('inst.shortHint')}
          </div>
          <div className="hint" style={{ marginTop: 4 }}>
            {t('inst.inspectFirst')} <a href={ticket.scriptUrl} target="_blank" rel="noreferrer" className="mono">{t('inst.viewScript')}</a>
            {' · '}{t('inst.expires', { at: new Date(ticket.expiresAt).toLocaleTimeString() })}
          </div>
          {/* The most common way this fails is TLS: the panel redirects to
              https and the certificate does not cover the name, so curl
              aborts before it ever reaches us. Say it here, next to the
              command, rather than leaving the operator with curl error 60. */}
          <div className="hint" style={{ marginTop: 6 }}>{t('inst.tlsHint')}</div>

          <div className="panel" style={{ marginTop: 12 }}>
            <b>{t('inst.progress')}</b>
            <div style={{ marginTop: 6 }}>
              <div><span className={'lamp ' + (state ? 'on' : '')} />{t('inst.stepIssued')}</div>
              <div>
                <span className={'lamp ' + (['fetched', 'enrolled'].includes(state) ? 'on' : '')} />
                {t('inst.stepFetched')}
                {status?.fetchedFrom && <span className="hint mono"> · {status.fetchedFrom}</span>}
              </div>
              <div>
                <span className={'lamp ' + (state === 'enrolled' ? 'on' : '')} />
                {t('inst.stepEnrolled')}
                {status?.reportedHostname && <span className="hint mono"> · {status.reportedHostname}</span>}
              </div>
            </div>
            {state === 'expired' && <div className="error-box" style={{ marginTop: 8 }}>{t('inst.expired')}</div>}
            {state === 'revoked' && <div className="hint" style={{ marginTop: 8 }}>{t('inst.revoked')}</div>}
          </div>

          {/* The whole point of the separate check: the box reaching the panel
              says nothing about the panel reaching the box, and everything the
              panel does afterwards runs in that second direction. */}
          {verify && (
            <div className="panel" style={{ marginTop: 8, borderColor: verify.reachable ? 'var(--ok)' : 'var(--warn)' }}>
              <b>{t('inst.reachTitle')}</b>
              {verify.reachable
                ? <div className="hint" style={{ marginTop: 4 }}>
                    ✓ {t('inst.reachOk')}
                    {verify.health?.logs === false && <> · {t('agent.logsOff')}</>}
                  </div>
                : <div style={{ marginTop: 4 }}>
                    <div className="hint">{t('inst.reachFail')}</div>
                    <div className="mono hint" style={{ fontSize: 12 }}>{verify.error}</div>
                    {verify.privateAddress && <div className="hint" style={{ marginTop: 4 }}>{t('inst.reachNat')}</div>}
                  </div>}
            </div>
          )}

          <div className="row" style={{ justifyContent: 'space-between', marginTop: 14 }}>
            <button className="danger" onClick={revoke}>{t('inst.revokeBtn')}</button>
            <button className={state === 'enrolled' ? 'primary' : ''} onClick={onClose}>{t('action.close')}</button>
          </div>
        </>
      )}
    </Modal>
  );
}
