import { useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import Modal from './Modal.jsx';

// Turning a machine into a gateway.
//
// The first thing in this panel that changes a system. Everything it has
// written until now went into somebody else's API, where a wrong call is
// refused; apt-get is not refused.
//
// So the dialog is built around one idea: the operator sees the exact commands
// and the exact file, and nothing runs before they have. Not a summary — the
// argv and the bytes. Somebody about to let software install packages on their
// server is entitled to read what it will run, and a description instead of
// the thing is how consent becomes a formality.
export default function GatewaySetupModal({ server, onClose, onDone }) {
  const { t } = useI18n();
  const [domain, setDomain] = useState('');
  const [email, setEmail] = useState('');
  const [mode, setMode] = useState('redirect');
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showFile, setShowFile] = useState('');

  const preview = async () => {
    setBusy(true); setError(''); setResult(null);
    try { setPlan(await api(`/servers/${server.id}/gateway/plan`, { method: 'POST', body: { domain, mode, email } })); }
    catch (e) { setError(e.data?.error || e.message); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    setBusy(true); setError('');
    try {
      const r = await api(`/servers/${server.id}/gateway/apply`, { method: 'POST', body: { domain, mode, email } });
      setResult(r);
      if (r.ok) onDone?.();
    } catch (e) {
      const d = e.data || {};
      if (d.steps) setResult(d); else setError(d.error || e.message);
      // A blocked apply carries the plan that blocked it, which is more useful
      // than the word "blocked": the reason is in the findings.
      if (d.blocking) setPlan(d);
    } finally { setBusy(false); }
  };

  const rollback = async () => {
    setBusy(true);
    try {
      const r = await api(`/servers/${server.id}/gateway/rollback`, {
        method: 'POST', body: { domain, steps: result?.steps || [] },
      });
      setResult({ ...result, rolledBack: r.steps });
    } catch (e) { setError(e.data?.error || e.message); }
    finally { setBusy(false); }
  };

  const held = plan?.blocking?.find(b => b.code === 'ports-held')?.held || [];

  return (
    <Modal onClose={onClose} size="wide">
      <h3>{t('gw.setup.title', { name: server.name })}</h3>
      <div className="hint">{t('gw.setup.intro')}</div>
      {error && <div className="error-box">{error}</div>}

      {/* Asked, never guessed: the certificate is issued for this name and an
          invented one burns a rate-limited issuance to produce something
          nobody can use. */}
      <label>{t('gw.setup.domain')}</label>
      <input className="mono" placeholder="cdn.example.com" value={domain}
             onChange={e => { setDomain(e.target.value); setPlan(null); }} />
      <div className="hint">{t('gw.setup.domainHint')}</div>

      <label>{t('gw.setup.email')}</label>
      <input className="mono" placeholder="ops@example.com" value={email} onChange={e => setEmail(e.target.value)} />
      <div className="hint">{t('gw.setup.emailHint')}</div>

      <label>{t('gw.setup.mode')}</label>
      <div className="row" style={{ gap: 6 }}>
        {['redirect', 'proxy'].map(m => (
          <button key={m} className={'tagchip' + (mode === m ? ' on' : '')}
                  onClick={() => { setMode(m); setPlan(null); }}>{t('gw.mode.' + m)}</button>
        ))}
      </div>
      <div className="hint">{t('gw.setup.mode.' + mode)}</div>

      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <button onClick={preview} disabled={busy || !domain.trim()}>{t('gw.setup.preview')}</button>
        {plan && !plan.blocking?.length && !result && (
          <button className="primary" onClick={apply} disabled={busy}>{t('gw.setup.apply')}</button>
        )}
      </div>

      {/* Ports, first and blocking. Who holds them, not that they are held:
          the answer decides whether the operator stops a service or stops the
          install, and those are different decisions. */}
      {held.length > 0 && (
        <div className="error-box" style={{ marginTop: 10 }}>
          <b>{t('gw.setup.portsHeld')}</b>
          {held.map(h => (
            <div key={h.port}>
              <span className="mono">{h.port}</span>{' — '}
              {h.holders.map(x => `${x.process} (pid ${x.pid}${x.unit ? `, ${x.unit}` : t('gw.setup.noUnit')})`).join(', ')}
            </div>
          ))}
          <div className="hint">{t('gw.setup.portsChoice')}</div>
          <div className="row" style={{ gap: 8, marginTop: 6 }}>
            {/* Not offered as a button here. Stopping somebody else's service
                is its own decision, and burying it in a setup flow is how
                somebody stops a production web server by pressing Next. */}
            <span className="hint">{t('gw.setup.stopByHand')}</span>
          </div>
        </div>
      )}

      {plan?.blocking?.filter(b => b.code !== 'ports-held').map((b, i) => (
        <div key={i} className="error-box">
          {t('gw.block.' + b.code)}
          {/* The reason, when there is one. "Not checked" on its own is a dead
              end: an old agent and a dead one look identical and are fixed
              differently. */}
          {b.code === 'ports-not-checked' && plan.portsError && (
            <div className="mono hint">{plan.portsError}</div>
          )}
          {b.code === 'ports-not-checked' && plan.agent?.version < plan.agent?.need && (
            <div className="hint">{t('gw.block.agentOld', { have: plan.agent.version ?? '—', need: plan.agent.need })}</div>
          )}
        </div>
      ))}
      {/* Notes are not failures: a machine being prepared before it joins a
          network is the normal order of work. */}
      {plan?.problems?.filter(p2 => p2.severity === 'note').map((p2, i) => (
        <div key={i} className="hint">{t('gw.note.' + p2.code)}</div>
      ))}

      {plan && !plan.blocking?.length && (
        <div className="inset">
          <div className="eyebrow">{t('gw.setup.willRun')}</div>
          <div className="hint">{t('gw.setup.willRunHint', {
            p: plan.summary.packages, f: plan.summary.files, c: plan.summary.commands,
          })}</div>
          {plan.steps.map(s => (
            <div key={s.id} className="cfg-finding">
              <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span className="badge">{t('gw.kind.' + s.kind)}</span>
                <span>{s.why}</span>
              </div>
              {/* The argv, not a description of it. */}
              {s.command && <div className="mono hint">{s.command.join(' ')}</div>}
              {s.path && (
                <>
                  <div className="mono hint">{s.path}</div>
                  <button style={{ fontSize: 11, padding: '1px 8px' }}
                          onClick={() => setShowFile(showFile === s.id ? '' : s.id)}>
                    {showFile === s.id ? '▾' : '▸'} {t('gw.setup.showFile')}
                  </button>
                  {showFile === s.id && (
                    <pre className="mono" style={{ fontSize: 11, maxHeight: 320, overflow: 'auto' }}>{s.content}</pre>
                  )}
                </>
              )}
              {/* Said for every step, because a plan where some steps cannot be
                  undone should say which. */}
              <div className="hint">
                {s.undo === 'restore' ? t('gw.undo.restore')
                  : Array.isArray(s.undo) ? `${t('gw.undo.command')} ${s.undo.join(' ')}`
                  : t('gw.undo.none')}
              </div>
            </div>
          ))}
        </div>
      )}

      {result && (
        <div className="inset">
          <div className="eyebrow">{t(result.ok ? 'gw.setup.done' : 'gw.setup.stopped')}</div>
          {result.steps?.map((s, i) => (
            <div key={i} className="hint">
              {s.ok ? '✓' : '✗'} {s.id}
              {s.error && <> — <span className="mono">{s.error}</span></>}
              {s.backup && <> · {t('gw.setup.backedUp')} <span className="mono">{s.backup}</span></>}
            </div>
          ))}
          {/* The proof, and it is a handshake rather than an exit code: every
              step can return zero and the machine still not serve. */}
          {result.verify && (
            <div className={result.verify.http2 ? 'hint' : 'error-box'} style={{ marginTop: 6 }}>
              {result.verify.tls
                ? t('gw.setup.verified', { alpn: result.verify.alpn || '?' })
                : t('gw.setup.notServing')}
            </div>
          )}
          {result.steps?.some(s => s.ok) && (
            <button style={{ marginTop: 8 }} onClick={rollback} disabled={busy}>{t('gw.setup.rollback')}</button>
          )}
          {result.rolledBack && (
            <div className="hint">{t('gw.setup.rolledBack', { n: result.rolledBack.filter(x => x.ok).length })}</div>
          )}
        </div>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onClose}>{t('action.close')}</button>
      </div>
    </Modal>
  );
}
