import { useState } from 'react';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';

export default function LoginPage() {
  const { login, loginVerify2fa } = useAuth();
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState(null); // set when 2FA is required
  const [code, setCode] = useState('');

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const r = await login(username, password);
      if (r?.twoFactorRequired) setTicket(r.ticket);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const verify = async () => {
    setBusy(true); setError('');
    try { await loginVerify2fa(ticket, code); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand">NNM<b>CONTROL</b></div>
        {!ticket ? (
          <>
            <label>Username</label>
            <input value={username} onChange={e => setUsername(e.target.value)} autoFocus />
            <label>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                   onKeyDown={e => e.key === 'Enter' && submit()} />
            {error && <div className="error-box">{error}</div>}
            <button className="primary" style={{ marginTop: 16, width: '100%' }}
                    disabled={busy || !username || !password} onClick={submit}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </>
        ) : (
          <>
            <h3 style={{ margin: '4px 0 6px' }}>{t('login.2faTitle')}</h3>
            <div className="hint" style={{ marginBottom: 10 }}>{t('login.2faPrompt')}</div>
            <input className="mono" value={code} autoFocus placeholder="123456"
                   style={{ letterSpacing: 2 }} onChange={e => setCode(e.target.value)}
                   onKeyDown={e => e.key === 'Enter' && code && verify()} />
            {error && <div className="error-box">{error}</div>}
            <button className="primary" style={{ marginTop: 16, width: '100%' }}
                    disabled={busy || code.length < 6} onClick={verify}>
              {busy ? '…' : t('login.verify')}
            </button>
            <button style={{ marginTop: 8, width: '100%' }}
                    onClick={() => { setTicket(null); setCode(''); setError(''); }}>
              {t('action.cancel')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
