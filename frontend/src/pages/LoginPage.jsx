import { useState } from 'react';
import { useAuth } from '../auth.jsx';

export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setError('');
    try { await login(username, password); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand">NNM<b>CONTROL</b></div>
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
      </div>
    </div>
  );
}
