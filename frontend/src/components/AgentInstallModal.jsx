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
// The stages the installer announces, in the order it announces them.
//
// Matched on what the script already prints rather than on a second progress
// channel: the installer is a POSIX script run over SSH, and a separate
// reporting path would be a second thing that can disagree with the log
// underneath it.
const INSTALL_STAGES = [
  { id: 'connect', match: /connect|ssh|host key/i },
  { id: 'checks', match: /root|curl|node|prerequisite/i },
  { id: 'fetch', match: /download|fetch|nnm-agent\.mjs/i },
  { id: 'install', match: /install|write|systemd|unit/i },
  { id: 'start', match: /start|enable|active/i },
  { id: 'enroll', match: /enroll|token|panel/i },
];

// How far the output says it got. The last stage whose marker appeared, not
// the first — an installer mentions what it is about to do and then does it,
// so the newest mention is the truthful one.
function stageFrom(output = '') {
  let idx = 0;
  INSTALL_STAGES.forEach((st, i) => { if (st.match.test(output)) idx = i; });
  return idx;
}

// The last line that looks like a failure, for the operator who should not
// have to scroll a log to find out what went wrong.
function lastErrorLine(output = '') {
  const lines = String(output).split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/error|failed|cannot|refused|denied|not found|no such/i.test(lines[i])) return lines[i].trim();
  }
  return null;
}

export default function AgentInstallModal({ server, onClose, onEnrolled }) {
  const { t } = useI18n();
  const { push } = useToast();
  const [form, setForm] = useState({
    agentPort: 8090,
    logDir: '/var/log/nimble',
    // Whatever address the browser used is only a guess at what the SERVER can
    // use. A public name may have a certificate that does not cover it, or may
    // not resolve from inside the fleet at all, so this is editable.
    panelUrl: window.location.origin,
  });
  const [safe, setSafe] = useState(true);
  // iter11 m2 — two ways to do the same enrollment: the operator runs the
  // command, or the panel runs it for them over SSH. Same ticket, same
  // checksum-verified command; only the typing differs.
  const [mode, setMode] = useState('manual');
  const [ssh, setSsh] = useState({ host: server.host || '', port: 22, username: 'root', password: '', privateKey: '', passphrase: '', useSudo: false });
  const [hostKey, setHostKey] = useState(null);
  const [job, setJob] = useState(null);
  const [ticket, setTicket] = useState(null);
  const [status, setStatus] = useState(null);
  const [showLog, setShowLog] = useState(false);
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
    setBusy(true); setError(''); setStatus(null);
    try {
      setTicket(await api(`/servers/${server.id}/agent/enrollment`, {
        method: 'POST',
        body: {
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
    setTicket(null); setStatus(null);
  };

  const setS = (k, v) => setSsh(x => ({ ...x, [k]: v }));

  const probe = async () => {
    setBusy(true); setError(''); setHostKey(null);
    try {
      setHostKey(await api(`/servers/${server.id}/agent/ssh/probe`, {
        method: 'POST', body: { host: ssh.host.trim(), port: Number(ssh.port) || 22 },
      }));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const install = async () => {
    setBusy(true); setError(''); setJob(null);
    try {
      const { jobId } = await api(`/servers/${server.id}/agent/ssh/install`, {
        method: 'POST',
        body: {
          host: ssh.host.trim(), port: Number(ssh.port) || 22, username: ssh.username.trim(),
          password: ssh.password || undefined,
          privateKey: ssh.privateKey || undefined,
          passphrase: ssh.passphrase || undefined,
          useSudo: ssh.useSudo,
          fingerprint: hostKey.fingerprint,
          panelUrl: form.panelUrl.trim(),
          agentPort: Number(form.agentPort) || 8090,
          logDir: form.logDir.trim(),
        },
      });
      // The credential was needed for exactly one request. Dropping it here
      // means a dialog left open does not keep a root password in a form.
      setSsh(x => ({ ...x, password: '', privateKey: '', passphrase: '' }));
      const tick = async () => {
        try {
          const j = await api(`/servers/${server.id}/agent/ssh/jobs/${jobId}`);
          setJob(j);
          if (j.status !== 'running') { clearInterval(poll.current); poll.current = null; if (j.status === 'done') onEnrolled?.(); }
        } catch { /* the next tick retries */ }
      };
      await tick();
      poll.current = setInterval(tick, 1500);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const copy = async (s) => push(await copyText(s)
    ? { type: 'ok', message: t('srt.copied') }
    : { type: 'error', message: t('copy.failed') });

  const state = status?.status || (ticket ? 'pending' : null);
  const stageIndex = job ? stageFrom(job.output) : 0;
  const lastError = job?.status === 'failed' ? lastErrorLine(job.output) : null;

  return (
    <Modal onClose={onClose} size="wide">
      <h3>{t('inst.title', { name: server.name })}</h3>

      {!ticket && !job && (
        <>
          <div className="row" style={{ gap: 12, marginBottom: 8 }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
              <input type="radio" checked={mode === 'manual'} onChange={() => setMode('manual')} />{t('inst.modeManual')}
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
              <input type="radio" checked={mode === 'ssh'} onChange={() => setMode('ssh')} />{t('inst.modeSsh')}
            </label>
          </div>
          <p className="hint">{mode === 'ssh' ? t('inst.sshIntro') : t('inst.intro')}</p>
          {/* iter12 m5 — the only address in this dialog is the one the SERVER
              needs. How the panel would reach the agent is no longer a
              question anyone has to answer, because it never does. */}
          <label>{t('inst.panelUrl')}</label>
          <input className="mono" value={form.panelUrl} onChange={e => set('panelUrl', e.target.value)} />
          <div className="hint">{t('inst.panelUrlHint')}</div>
          <label>{t('inst.logDir')}</label>
          <input className="mono" value={form.logDir} onChange={e => set('logDir', e.target.value)} />
          {mode === 'ssh' && (
            <div className="panel" style={{ marginTop: 10 }}>
              <div className="grid" style={{ gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
                <div><label>{t('inst.sshHost')}</label>
                  <input className="mono" value={ssh.host} onChange={e => setS('host', e.target.value)} /></div>
                <div><label>{t('inst.sshPort')}</label>
                  <input type="number" value={ssh.port} onChange={e => setS('port', e.target.value)} /></div>
                <div><label>{t('inst.sshUser')}</label>
                  <input className="mono" value={ssh.username} onChange={e => setS('username', e.target.value)} /></div>
              </div>

              {/* The fingerprint is confirmed before any credential is typed.
                  ssh2 offers the host key during the handshake, so the probe
                  never authenticates — and a mismatch later aborts before the
                  password is sent. */}
              {!hostKey
                ? <div style={{ marginTop: 8 }}>
                    <button disabled={busy || !ssh.host.trim()} onClick={probe}>{t('inst.sshProbe')}</button>
                    <div className="hint" style={{ marginTop: 4 }}>{t('inst.sshProbeHint')}</div>
                  </div>
                : <>
                    <div className="hint" style={{ marginTop: 8 }}>{t('inst.sshFingerprint')}</div>
                    <div className="row" style={{ gap: 6 }}>
                      <code className="mono" style={{ flex: 1, wordBreak: 'break-all' }}>{hostKey.fingerprint}</code>
                      <button onClick={() => { setHostKey(null); }}>{t('action.cancel')}</button>
                    </div>
                    <div className="hint" style={{ marginTop: 4 }}>{t('inst.sshFingerprintHint')}</div>

                    <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
                      <div><label>{t('inst.sshPassword')}</label>
                        <input type="password" value={ssh.password} onChange={e => setS('password', e.target.value)} /></div>
                      <div><label>{t('inst.sshPassphrase')}</label>
                        <input type="password" value={ssh.passphrase} onChange={e => setS('passphrase', e.target.value)} /></div>
                    </div>
                    <label>{t('inst.sshKey')}</label>
                    <textarea rows={3} className="mono" style={{ fontSize: 11 }} value={ssh.privateKey}
                              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                              onChange={e => setS('privateKey', e.target.value)} />
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input type="checkbox" checked={ssh.useSudo} onChange={e => setS('useSudo', e.target.checked)} />
                      {t('inst.sshSudo')}
                    </label>
                    <div className="hint">{t('inst.sshNotStored')}</div>
                  </>}
            </div>
          )}
          {error && <div className="error-box">{error}</div>}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <button onClick={onClose}>{t('action.cancel')}</button>
            {mode === 'ssh'
              ? <button className="primary"
                        disabled={busy || !hostKey || !ssh.username.trim() || (!ssh.password && !ssh.privateKey)}
                        onClick={install}>{busy ? '…' : t('inst.sshInstall')}</button>
              : <button className="primary" disabled={busy || !form.panelUrl.trim()} onClick={issue}>
                  {busy ? '…' : t('inst.issue')}
                </button>}
          </div>
        </>
      )}

      {job && (
        <>
          {/* An install reported as a wall of console output asks the operator
              to be the parser: to read apt's noise and work out how far it got
              and whether that is normal. The installer already announces its
              own stages, so the bar reads those and the log becomes evidence
              rather than the interface.

              The stages are recognised from the output rather than reported
              separately, because the installer is a POSIX script run over SSH
              and inventing a second channel for progress would be a second
              thing that can disagree with the first. */}
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <b>{t(`inst.job.${job.status}`)}</b>
            <span className="hint">{t('inst.stageOf', { n: stageIndex + 1, total: INSTALL_STAGES.length })}</span>
          </div>

          <div className={'progress' + (job.status === 'failed' ? ' failed' : '')}>
            {/* Never a full bar on failure: a bar that fills to the end and
                then says it went wrong contradicts itself, and people believe
                the bar. */}
            <div className="progress-fill"
                 style={{ width: `${job.status === 'done' ? 100 : Math.round((stageIndex / INSTALL_STAGES.length) * 100)}%` }} />
          </div>

          <div className="inst-stages">
            {INSTALL_STAGES.map((st, i) => {
              const state = job.status === 'done' ? 'done'
                : i < stageIndex ? 'done'
                : i === stageIndex ? (job.status === 'failed' ? 'failed' : 'running')
                : 'waiting';
              return (
                <div key={st.id} className={'inst-stage ' + state}>
                  <span className="inst-stage-mark">
                    {state === 'done' ? '✓' : state === 'failed' ? '!' : i + 1}
                  </span>
                  <span>{t('inst.stage.' + st.id)}</span>
                  {state === 'running' && job.status !== 'failed' && <span className="hint">…</span>}
                </div>
              );
            })}
          </div>

          {job.error && <div className="error-box">{job.error}</div>}
          {/* The failing line, lifted out. Somebody whose install just failed
              should not have to scroll a log to find the one line that says
              why — and the whole log is still one click away. */}
          {job.status === 'failed' && lastError && (
            <div className="error-box mono" style={{ fontSize: 12 }}>{lastError}</div>
          )}

          <button style={{ marginTop: 8 }} onClick={() => setShowLog(v => !v)}>
            {showLog ? '▾' : '▸'} {t('inst.showLog')}
            {job.exitCode ? ` · exit ${job.exitCode}` : ''}
          </button>
          {showLog && (
            <pre className="mono" style={{ fontSize: 11, maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
              {job.output || '…'}
            </pre>
          )}

          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
            <button className={job.status === 'done' ? 'primary' : ''} onClick={onClose}>{t('action.close')}</button>
          </div>
        </>
      )}

      {ticket && (
        <>
          {ticket.warnings?.includes('panelNotHttps') && (
            <div className="error-box">{t('inst.warnHttp')}</div>
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

          <div className="row" style={{ justifyContent: 'space-between', marginTop: 14 }}>
            <button className="danger" onClick={revoke}>{t('inst.revokeBtn')}</button>
            <button className={state === 'enrolled' ? 'primary' : ''} onClick={onClose}>{t('action.close')}</button>
          </div>
        </>
      )}
    </Modal>
  );
}
