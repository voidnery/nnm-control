import { useState } from 'react';
import { api } from '../api.js';

// First-run setup: creates the single superadmin account.
// Requires the one-time setup token printed by the installer
// (`sudo apt install nnm-control` output, or `nnm-control setup-token`).
export default function SetupPage({ onDone }) {
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const valid = token && username && password.length >= 8 && password === confirm;

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api('/setup', { method: 'POST', body: { token, username, password } });
      onDone();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand">NNM<b>CONTROL</b></div>
        <h3 style={{ margin: '0 0 4px' }}>First-run setup</h3>
        <p className="hint">
          Create the superadmin account. The setup token was printed during
          installation — on the server run <code>nnm-control setup-token</code> to see it again.
        </p>
        <label>Setup token</label>
        <input value={token} onChange={e => setToken(e.target.value)} autoFocus className="mono" />
        <label>Superadmin username</label>
        <input value={username} onChange={e => setUsername(e.target.value)} />
        <label>Password (min 8 chars)</label>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} />
        <label>Confirm password</label>
        <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
               onKeyDown={e => e.key === 'Enter' && valid && submit()} />
        {password && confirm && password !== confirm && <div className="hint" style={{ color: 'var(--warn)', marginTop: 6 }}>Passwords do not match.</div>}
        {error && <div className="error-box">{error}</div>}
        <button className="primary" style={{ marginTop: 16, width: '100%' }} disabled={busy || !valid} onClick={submit}>
          {busy ? 'Creating…' : 'Create superadmin'}
        </button>
      </div>
    </div>
  );
}
