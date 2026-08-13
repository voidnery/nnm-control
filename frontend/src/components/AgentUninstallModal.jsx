import { useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import Modal from './Modal.jsx';
import { copyText } from '../lib/clipboard.js';

// Taking the agent off a machine.
//
// The same two ways as installing — a script to run, or SSH credentials used
// once — because it is the same act in reverse and somebody who chose one for
// the install will expect it for the removal.
//
// What differs is that there is no undo. An install that goes wrong leaves a
// service to look at; an uninstall that goes wrong has already removed it. So
// the dialog says what will be removed and what will not, before anything
// happens, and the confirmation is the operator reading that rather than a
// dialog asking "are you sure" about a list they have not seen.
export default function AgentUninstallModal({ server, onClose, onDone }) {
  const { t } = useI18n();
  const [mode, setMode] = useState('script');
  const [purge, setPurge] = useState(false);
  const [script, setScript] = useState('');
  const [copied, setCopied] = useState(false);
  const [ssh, setSsh] = useState({ host: server.host || '', port: 22, username: 'root', password: '' });
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const getScript = async () => {
    setBusy(true); setError('');
    try {
      const r = await api('/agents/uninstall/script', { method: 'POST', body: { purge, server: server.name } });
      setScript(r.script);
    } catch (e) { setError(e.data?.error || e.message); }
    finally { setBusy(false); }
  };

  const runSsh = async () => {
    setBusy(true); setError('');
    try {
      const r = await api('/agents/uninstall/ssh', {
        method: 'POST',
        body: { serverId: server.id, purge, ...ssh },
      });
      setJob(r);
      onDone?.();
    } catch (e) { setError(e.data?.error || e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} size="wide">
      <h3>{t('agent.uninstall.title', { name: server.name })}</h3>

      {/* Said before the choice of how, not after it. What an uninstall leaves
          behind is the part people are actually unsure about. */}
      <div className="inset">
        <div className="eyebrow">{t('agent.uninstall.willRemove')}</div>
        <div className="hint">{t('agent.uninstall.removeList')}</div>
        <div className="eyebrow" style={{ marginTop: 8 }}>{t('agent.uninstall.willKeep')}</div>
        <div className="hint">{t('agent.uninstall.keepList')}</div>
      </div>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
        <input type="checkbox" checked={purge} onChange={e => setPurge(e.target.checked)} />
        {t('agent.uninstall.purge')}
      </label>
      <div className="hint">{t('agent.uninstall.purgeWhy')}</div>

      <div className="row" style={{ gap: 6, marginTop: 10 }}>
        {['script', 'ssh'].map(m => (
          <button key={m} className={'tagchip' + (mode === m ? ' on' : '')} onClick={() => setMode(m)}>
            {t('agent.uninstall.mode.' + m)}
          </button>
        ))}
      </div>

      {error && <div className="error-box">{error}</div>}

      {mode === 'script' ? (
        <>
          <button style={{ marginTop: 8 }} onClick={getScript} disabled={busy}>{t('agent.uninstall.getScript')}</button>
          {script && (
            <div className="inset">
              <div className="row" style={{ gap: 8 }}>
                <button onClick={async () => setCopied(await copyText(script))}>
                  {copied ? t('ch.copied') : t('ch.copy')}
                </button>
                <span className="hint">{t('agent.uninstall.thenRun')}</span>
              </div>
              <pre className="mono" style={{ fontSize: 11, maxHeight: 300, overflow: 'auto' }}>{script}</pre>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="hint" style={{ marginTop: 8 }}>{t('agent.uninstall.sshWhy')}</div>
          <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            <input className="mono" style={{ maxWidth: 200 }} placeholder="host"
                   value={ssh.host} onChange={e => setSsh({ ...ssh, host: e.target.value })} />
            <input type="number" style={{ maxWidth: 90 }} value={ssh.port}
                   onChange={e => setSsh({ ...ssh, port: e.target.value })} />
            <input className="mono" style={{ maxWidth: 140 }} value={ssh.username}
                   onChange={e => setSsh({ ...ssh, username: e.target.value })} />
            <input type="password" style={{ maxWidth: 180 }} placeholder={t('agent.uninstall.password')}
                   value={ssh.password} onChange={e => setSsh({ ...ssh, password: e.target.value })} />
          </div>
          <button className="primary" style={{ marginTop: 8 }} disabled={busy || !ssh.host} onClick={runSsh}>
            {busy ? '…' : t('agent.uninstall.run')}
          </button>
          {job && <div className="hint" style={{ marginTop: 6 }}>{t('agent.uninstall.started')}</div>}
        </>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onClose}>{t('action.close')}</button>
      </div>
    </Modal>
  );
}
