import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import Select from '../components/Select.jsx';
import { useToast } from '../toast.jsx';

const BASE_URLS = [
  'https://api.wmspanel.com/v1',
  'https://api.wmspanel.ru/v1',
];

export default function SettingsPage() {
  const { push } = useToast();
  const { refreshSystem } = useAuth();
  const [settings, setSettings] = useState(null);
  const [clientId, setClientId] = useState('');
  const [apiKey, setApiKey] = useState('');       // empty = keep stored key
  const [baseUrl, setBaseUrl] = useState(BASE_URLS[0]);
  const [customUrl, setCustomUrl] = useState(false);
  const [controlPlane, setControlPlane] = useState('native');
  const [test, setTest] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const s = await api('/settings');
      push({ type: 'ok', message: 'Settings saved' });
    setSettings(s);
    setClientId(s.wmspanel.clientId);
    setBaseUrl(s.wmspanel.baseUrl);
    setCustomUrl(!BASE_URLS.includes(s.wmspanel.baseUrl));
    setControlPlane(s.controlPlane);
  };
  useEffect(() => { load().catch(e => setMsg({ ok: false, text: e.message })); }, []);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const body = { controlPlane, wmspanel: { baseUrl, clientId } };
      if (apiKey !== '') body.wmspanel.apiKey = apiKey;
      const s = await api('/settings', { method: 'PUT', body });
      setSettings(s); setApiKey('');
      await refreshSystem();
      setMsg({ ok: true, text: s.sync && !s.sync.skipped
        ? `Settings saved. Fleet synced: +${s.sync.created} new, ${s.sync.updated} updated.`
        : 'Settings saved.' });
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  const runTest = async () => {
    setBusy(true); setTest(null);
    try {
      const body = { baseUrl, clientId };
      if (apiKey !== '') body.apiKey = apiKey;
      setTest(await api('/settings/wmspanel/test', { method: 'POST', body }));
    } catch (e) { setTest({ ok: false, error: e.message }); }
    finally { setBusy(false); }
  };

  if (!settings) return <div className="hint">Loading…</div>;
  return (
    <div>
      <h1>Settings</h1>
      <div className="sub">System settings. Visible to superadmin, admins and roles with the settings permission.</div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Control plane</h2>
        <p className="hint">
          How the panel applies persistent changes (republish rules, stream sources).
          <b> WMSPanel API</b> — primary mode, changes are persistent and visible in WMSPanel.{' '}
          <b>Native API</b> — backup mode for WMSPanel outages: rules created this way are
          ephemeral (reset on Nimble reload) and cannot modify WMSPanel-created rules.
        </p>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="radio" style={{ width: 'auto' }} checked={controlPlane === 'wmspanel'}
                 onChange={() => setControlPlane('wmspanel')} /> WMSPanel API (primary)
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="radio" style={{ width: 'auto' }} checked={controlPlane === 'native'}
                 onChange={() => setControlPlane('native')} /> Native Nimble API (backup mode)
        </label>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>WMSPanel API</h2>
        <p className="hint">
          Enable the API in WMSPanel: Control → API setup → Pull API. Copy Client ID, generate an API key,
          and add THIS panel's public IP to the whitelist there. Account limit: 15 000 calls/day —
          the panel only calls WMSPanel for changes, monitoring stays on the native API.
        </p>
        <label>API base URL</label>
        {!customUrl ? (
          <Select value={baseUrl}
                  onChange={v => { if (v === 'custom') setCustomUrl(true); else setBaseUrl(v); }}
                  options={[...BASE_URLS.map(u => ({ value: u, label: u })), { value: 'custom', label: 'Custom…' }]} />
        ) : (
          <div className="row">
            <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.wmspanel.com/v1" />
            <button onClick={() => { setCustomUrl(false); setBaseUrl(BASE_URLS[0]); }}>Presets</button>
          </div>
        )}
        <label>Client ID</label>
        <input value={clientId} onChange={e => setClientId(e.target.value)} className="mono" />
        <label>API key {settings.wmspanel.hasApiKey && <span className="hint">(set — leave empty to keep)</span>}</label>
        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
               placeholder={settings.wmspanel.hasApiKey ? '•••••••••••' : ''} className="mono" />
        <div className="row" style={{ marginTop: 14 }}>
          <button onClick={runTest} disabled={busy || !clientId}>Test connection</button>
          <button className="primary" onClick={save} disabled={busy}>Save settings</button>
        </div>
        {test && (
          test.ok
            ? <div className="hint" style={{ marginTop: 10 }}>
                <span className="lamp on" />Connected. WMSPanel servers visible: {test.servers.length}
                {test.servers.slice(0, 8).map(s => (
                  <div key={s.id} className="mono" style={{ marginLeft: 16 }}>
                    {s.name} — {s.id} ({s.status})
                  </div>
                ))}
              </div>
            : <div className="error-box">{test.error}</div>
        )}
        {msg && (msg.ok ? <div className="hint" style={{ marginTop: 10 }}><span className="lamp on" />{msg.text}</div>
                        : <div className="error-box">{msg.text}</div>)}
      </div>
    </div>
  );
}
