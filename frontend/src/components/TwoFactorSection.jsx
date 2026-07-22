import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import Modal from './Modal.jsx';

export default function TwoFactorSection() {
  const { t } = useI18n();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [setup, setSetup] = useState(null);   // { secret, otpauth }
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [backupCodes, setBackupCodes] = useState(null);
  const [disableModal, setDisableModal] = useState(null); // { password, code }
  const qrRef = useRef(null);

  const load = () => api('/auth/me/2fa').then(setStatus).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (setup?.otpauth && qrRef.current) {
      QRCode.toCanvas(qrRef.current, setup.otpauth, { width: 200, margin: 1 }, () => {});
    }
  }, [setup]);

  const startSetup = async () => {
    setError(''); setBusy(true);
    try { setSetup(await api('/auth/me/2fa/setup', { method: 'POST' })); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const enable = async () => {
    setError(''); setBusy(true);
    try {
      const r = await api('/auth/me/2fa/enable', { method: 'POST', body: { code } });
      setBackupCodes(r.backupCodes);
      setSetup(null); setCode('');
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const disable = async () => {
    setError(''); setBusy(true);
    try {
      await api('/auth/me/2fa/disable', { method: 'POST', body: disableModal });
      setDisableModal(null);
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!status) return <div className="hint">{t('profile.2fa')}…</div>;

  return (
    <div>
      <label>{t('profile.2fa')}</label>
      {error && <div className="error-box">{error}</div>}

      {status.enabled ? (
        <div>
          <div className="hint" style={{ marginBottom: 8 }}>
            <span className="lamp on" />{t('twofa.enabled')} · {t('twofa.backupRemaining', { n: status.backupCodesRemaining })}
          </div>
          <button className="danger" onClick={() => setDisableModal({ password: '', code: '' })}>{t('twofa.disable')}</button>
        </div>
      ) : setup ? (
        <div className="panel" style={{ background: 'var(--bg-raise)' }}>
          <div className="hint">{t('twofa.scan')}</div>
          <canvas ref={qrRef} style={{ background: '#fff', borderRadius: 8, padding: 6, margin: '10px 0' }} />
          <div className="hint">{t('twofa.manual')}</div>
          <div className="mono" style={{ userSelect: 'all', marginBottom: 10, wordBreak: 'break-all' }}>{setup.secret}</div>
          <label>{t('twofa.enterCode')}</label>
          <input className="mono" value={code} onChange={e => setCode(e.target.value)} placeholder="123456"
                 style={{ maxWidth: 160, letterSpacing: 2 }} />
          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={() => { setSetup(null); setCode(''); }}>{t('action.cancel')}</button>
            <button className="primary" disabled={busy || code.length < 6} onClick={enable}>{t('twofa.enable')}</button>
          </div>
        </div>
      ) : (
        <div>
          <div className="hint" style={{ marginBottom: 8 }}>{t('twofa.desc')}</div>
          <button className="primary" disabled={busy} onClick={startSetup}>{t('twofa.setup')}</button>
        </div>
      )}

      {backupCodes && (
        <Modal onClose={() => setBackupCodes(null)}>
          <h3>{t('twofa.backupTitle')}</h3>
          <div className="hint">{t('twofa.backupHint')}</div>
          <div className="panel mono" style={{ columns: 2, marginTop: 10 }}>
            {backupCodes.map(c => <div key={c} style={{ userSelect: 'all', padding: '2px 0' }}>{c}</div>)}
          </div>
          <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
            <button onClick={() => { navigator.clipboard?.writeText(backupCodes.join('\n')); }}>{t('twofa.copy')}</button>
            <button className="primary" onClick={() => setBackupCodes(null)}>{t('twofa.saved')}</button>
          </div>
        </Modal>
      )}

      {disableModal && (
        <Modal onClose={() => setDisableModal(null)} size="narrow">
          <h3>{t('twofa.disable')}</h3>
          <label>{t('profile.currentPassword')}</label>
          <input type="password" value={disableModal.password} onChange={e => setDisableModal(m => ({ ...m, password: e.target.value }))} />
          <label>{t('twofa.enterCode')}</label>
          <input className="mono" value={disableModal.code} onChange={e => setDisableModal(m => ({ ...m, code: e.target.value }))} placeholder="123456 or backup" />
          <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
            <button onClick={() => setDisableModal(null)}>{t('action.cancel')}</button>
            <button className="danger" disabled={busy || !disableModal.password || !disableModal.code} onClick={disable}>{t('twofa.disable')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
