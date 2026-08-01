import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import Select from '../components/Select.jsx';
import { useToast } from '../toast.jsx';
import { useI18n } from '../i18n.jsx';

const BASE_URLS = [
  'https://api.wmspanel.com/v1',
  'https://api.wmspanel.ru/v1',
];

export default function SettingsPage() {
  const { t } = useI18n();
  const { push } = useToast();
  const { refreshSystem } = useAuth();
  const [settings, setSettings] = useState(null);
  const [clientId, setClientId] = useState('');
  const [apiKey, setApiKey] = useState('');       // empty = keep stored key
  const [baseUrl, setBaseUrl] = useState(BASE_URLS[0]);
  const [customUrl, setCustomUrl] = useState(false);
  const [controlPlane, setControlPlane] = useState('native');
  const [srtHelperEnabled, setSrtHelperEnabled] = useState(true);
  const [publicUrl, setPublicUrl] = useState('');
  const [host, setHost] = useState({ enabled: false, intervalSec: 10 });
  const [apiQuota, setApiQuota] = useState({ enabled: true, dailyLimit: 15000 });
  const [logs, setLogs] = useState({ enabled: false, files: ['nimble.log'] });
  const [logStatus, setLogStatus] = useState(null);
  const [stats, setStats] = useState({ enabled: false, intervalSec: 10, retentionDays: 3,
                                       groups: { streams: true, republish: true, srt: true, server: true } });
  const [usage, setUsage] = useState(null);
  const [test, setTest] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const s = await api('/settings');
    setSettings(s);
    setClientId(s.wmspanel.clientId);
    setBaseUrl(s.wmspanel.baseUrl);
    setCustomUrl(!BASE_URLS.includes(s.wmspanel.baseUrl));
    setControlPlane(s.controlPlane);
    setSrtHelperEnabled(s.srtHelperEnabled !== false);
    if (s.stats) setStats(s.stats);
    setPublicUrl(s.publicUrl || '');
    if (s.host) setHost({ enabled: Boolean(s.host.enabled), intervalSec: Number(s.host.intervalSec) || 10 });
    if (s.apiQuota) setApiQuota({ enabled: s.apiQuota.enabled !== false, dailyLimit: Number(s.apiQuota.dailyLimit) || 15000 });
    if (s.logs) setLogs({ enabled: Boolean(s.logs.enabled), files: s.logs.files?.length ? s.logs.files : ['nimble.log'] });
    // Status alongside the switch, because "is it on" and "is anything
    // arriving" are different questions and only the second one is useful
    // when an operator has just turned it on and nothing is happening.
    api('/logs/status').then(setLogStatus).catch(() => setLogStatus(null));
  };
  useEffect(() => { load().catch(e => setMsg({ ok: false, text: e.message })); }, []);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const body = { controlPlane, srtHelperEnabled, stats, logs, host, apiQuota, publicUrl, wmspanel: { baseUrl, clientId } };
      if (apiKey !== '') body.wmspanel.apiKey = apiKey;
      const s = await api('/settings', { method: 'PUT', body });
      push({ type: 'ok', message: 'Settings saved' });
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
      <h1>{t('page.settings.title')}</h1>
      <div className="sub">{t('page.settings.sub')}</div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Control plane</h2>
        <p className="hint">
          How the panel applies persistent changes (republish rules, stream sources).
        </p>
        <div className="radio-cards">
          <label className={'radio-card' + (controlPlane === 'wmspanel' ? ' on' : '')}>
            <input type="radio" name="controlPlane" checked={controlPlane === 'wmspanel'}
                   onChange={() => setControlPlane('wmspanel')} />
            <span className="radio-card-body">
              <span className="radio-card-title">WMSPanel API <span className="badge">primary</span></span>
              <span className="radio-card-desc">
                Changes are persistent and visible in WMSPanel. Recommended for normal operation.
              </span>
            </span>
          </label>
          <label className={'radio-card' + (controlPlane === 'native' ? ' on' : '')}>
            <input type="radio" name="controlPlane" checked={controlPlane === 'native'}
                   onChange={() => setControlPlane('native')} />
            <span className="radio-card-body">
              <span className="radio-card-title">Native Nimble API <span className="badge">backup</span></span>
              <span className="radio-card-desc">
                For WMSPanel outages. Rules created this way are ephemeral (reset on Nimble reload)
                and cannot modify WMSPanel-created rules.
              </span>
            </span>
          </label>
        </div>
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
        <div className="panel">
        <h2 style={{ marginTop: 0 }}>{t('settings.srtHelper')}</h2>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={srtHelperEnabled} onChange={e => setSrtHelperEnabled(e.target.checked)} />
          {t('settings.srtHelper.desc')}
        </label>
      </div>
      {/* Links the panel hands out have to be built from an address that works
          from outside. A reverse proxy with `proxy_set_header Host $host`
          strips the port, so a panel on :8095 was generating share links to
          :443 — where something else answers. */}
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>{t('settings.public')}</h2>
        <p className="hint">{t('settings.public.desc')}</p>
        <input className="mono" value={publicUrl} placeholder={window.location.origin}
               onChange={e => setPublicUrl(e.target.value)} />
        <div className="hint" style={{ marginTop: 4 }}>
          {publicUrl
            ? t('settings.public.set')
            : t('settings.public.derived', { url: window.location.origin })}
        </div>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>{t('settings.quota')}</h2>
        <p className="hint">{t('settings.quota.desc')}</p>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={Boolean(apiQuota.enabled)}
                 onChange={e => setApiQuota(v => ({ ...v, enabled: e.target.checked }))} />
          {t('settings.quota.enabled')}
        </label>
        {apiQuota.enabled && (
          <>
            <label style={{ marginTop: 8 }}>{t('settings.quota.limit')}</label>
            <input type="number" min={100} value={apiQuota.dailyLimit}
                   onChange={e => setApiQuota(v => ({ ...v, dailyLimit: Number(e.target.value) }))} />
            {/* The plan is the operator's to know; only they can correct it. */}
            <div className="hint">{t('settings.quota.limitHint')}</div>
          </>
        )}
      </div>

      {/* Host metrics. The setting, the gateway delivery and the agent side all
          shipped in iter15 m1 — and nothing turned it on, so every agent
          dutifully collected nothing and the dashboard showed empty cards.
          Exactly the omission the log collector had, repeated. */}
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>{t('settings.host')}</h2>
        <p className="hint">{t('settings.host.desc')}</p>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={Boolean(host.enabled)}
                 onChange={e => setHost(v => ({ ...v, enabled: e.target.checked }))} />
          {t('settings.host.enabled')}
        </label>
        {host.enabled && (
          <>
            <label style={{ marginTop: 8 }}>{t('settings.host.interval')}</label>
            <input type="number" min={2} max={300} value={host.intervalSec}
                   onChange={e => setHost(v => ({ ...v, intervalSec: Number(e.target.value) }))} />
            <div className="hint">{t('settings.host.intervalHint')}</div>
            <div className="hint" style={{ marginTop: 6 }}>{t('settings.host.applyHint')}</div>
          </>
        )}
      </div>

      {/* Log collection. The setting has existed since iter10 m1 and the agents
          have always honoured it, but it was never given a control here — so
          the Logs page sent operators to a page with nothing on it. */}
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>{t('settings.logs')}</h2>
        <p className="hint">{t('settings.logs.desc')}</p>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={Boolean(logs.enabled)}
                 onChange={e => setLogs(v => ({ ...v, enabled: e.target.checked }))} />
          {t('settings.logs.enabled')}
        </label>
        {logs.enabled && (
          <>
            <label style={{ marginTop: 8 }}>{t('settings.logs.files')}</label>
            <input className="mono" value={logs.files.join(', ')}
                   onChange={e => setLogs(v => ({ ...v, files: e.target.value.split(',').map(x => x.trim()).filter(Boolean) }))} />
            <div className="hint">{t('settings.logs.filesHint')}</div>
            <div className="hint" style={{ marginTop: 6 }}>{t('settings.logs.applyHint')}</div>
          </>
        )}
        {logStatus && (
          <div className="panel" style={{ marginTop: 10, marginBottom: 0 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <b>{t('settings.logs.status')}</b>
              <div className="row" style={{ flexShrink: 0 }}>
                <span className="hint">
                  {t('settings.logs.stored', { n: new Intl.NumberFormat().format(logStatus.storedRecords || 0), cap: logStatus.capMb })}
                </span>
                <button onClick={() => api('/logs/status').then(setLogStatus).catch(() => {})}>{t('action.refresh')}</button>
              </div>
            </div>
            {logStatus.agentServers === 0 && <div className="hint" style={{ marginTop: 4 }}>{t('settings.logs.noAgents')}</div>}
            {(logStatus.cursors || []).length === 0 && logStatus.agentServers > 0 && (
              <div className="hint" style={{ marginTop: 4 }}>{t('settings.logs.noneYet')}</div>
            )}
            {(logStatus.cursors || []).map(c => (
              <div key={c.serverId + c.file} className="hint mono" style={{ fontSize: 12, marginTop: 3 }}>
                {c.serverName} · {c.file} · {new Intl.NumberFormat().format(c.recordsStored)} rec
                {c.bytesMissed > 0 && <span style={{ color: 'var(--warn)' }}> · missed {c.bytesMissed} B</span>}
                {c.lastError && <span style={{ color: 'var(--warn)' }}> · {c.lastError}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>{t('settings.stats')}</h2>
        <p className="hint">{t('settings.stats.desc')}</p>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={Boolean(stats.enabled)}
                 onChange={e => setStats(v => ({ ...v, enabled: e.target.checked }))} />
          {t('settings.stats.enabled')}
        </label>
        {stats.enabled && (
          <>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', marginTop: 8 }}>
              <div>
                <label>{t('settings.stats.interval')}</label>
                <input type="number" min="5" max="600" value={stats.intervalSec}
                       onChange={e => setStats(v => ({ ...v, intervalSec: Number(e.target.value) }))} />
              </div>
              <div>
                <label>{t('settings.stats.retention')}</label>
                <input type="number" min="1" max="30" value={stats.retentionDays}
                       onChange={e => setStats(v => ({ ...v, retentionDays: Number(e.target.value) }))} />
              </div>
            </div>
            <label style={{ marginTop: 8 }}>{t('settings.stats.groups')}</label>
            {['streams', 'republish', 'srt', 'server'].map(g => (
              <label key={g} style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0' }}>
                <input type="checkbox" checked={stats.groups?.[g] !== false}
                       onChange={e => setStats(v => ({ ...v, groups: { ...v.groups, [g]: e.target.checked } }))} />
                {t('settings.stats.g.' + g)}
              </label>
            ))}
            <div className="row" style={{ marginTop: 8, alignItems: 'center' }}>
              <button onClick={async () => { try { setUsage(await api('/stats/_usage')); } catch { /* optional */ } }}>
                {t('action.refresh')}
              </button>
              {/* A response without `docs` used to take the whole Settings page
                  down. The click gate found it once the section actually
                  rendered under test. */}
              {Number.isFinite(usage?.docs) && (
                <span className="hint">
                  {t('settings.stats.usage', {
                    docs: usage.docs.toLocaleString(),
                    mb: ((usage.storageBytes || 0) / 1e6).toFixed(1),
                  })}
                </span>
              )}
            </div>
          </>
        )}
      </div>
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
