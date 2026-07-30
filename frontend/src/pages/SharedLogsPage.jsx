import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import LogWindow from '../components/LogWindow.jsx';

// iter10 m5 — a dashboard opened from a link, with no panel login.
//
// Deliberately does NOT use the shared `api()` helper: that one clears the
// stored token and redirects to /login on a 401, which is exactly the wrong
// thing to do to someone watching a wall display who has no account at all.
// A dead link should say the link is dead.
//
// The windows are read-only. Every filter comes from the database, so nothing
// here can be edited into a query for something the dashboard does not show —
// that is enforced on the server, and the UI simply matches it.
async function pub(path) {
  const res = await fetch(`/api${path}`);
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export default function SharedLogsPage({ token }) {
  const { t } = useI18n();
  const [dash, setDash] = useState(null);
  const [error, setError] = useState('');
  const [at, setAt] = useState(new Date());

  const load = useCallback(async () => {
    try { setDash(await pub(`/log-dashboards/shared/${encodeURIComponent(token)}`)); setError(''); }
    catch (e) { setError(e.message); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!dash?.refreshSec) return;
    const id = setInterval(() => setAt(new Date()), dash.refreshSec * 1000);
    return () => clearInterval(id);
  }, [dash?.refreshSec]);

  if (error) {
    return (
      <div style={{ padding: 40, maxWidth: 640, margin: '0 auto' }}>
        <h2>{t('dash.linkDead')}</h2>
        <div className="error-box">{error}</div>
        <div className="hint" style={{ marginTop: 8 }}>{t('dash.linkDeadHint')}</div>
      </div>
    );
  }
  if (!dash) return <div style={{ padding: 40 }} className="hint">{t('sd.loading')}</div>;

  return (
    <div style={{ padding: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>{dash.name}</h1>
        <span className="hint">{t('dash.readOnly')}</span>
      </div>
      {dash.description && <div className="sub">{dash.description}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${dash.columns}, minmax(0, 1fr))`, gap: 10, marginTop: 12 }}>
        {dash.windows.map(w => (
          <div key={w.id} style={{ gridColumn: `span ${Math.min(w.span || 1, dash.columns)}`, minWidth: 0 }}>
            <LogWindow
              key={`${w.id}-${at.getTime()}`}
              title={w.title || t(`logs.cat.${w.category}`)}
              category={w.category}
              initialLevels={w.levels || []}
              initialRange={w.range}
              height={w.height}
              controls={false}
              fetchData={() => pub(`/log-dashboards/shared/${encodeURIComponent(token)}/window/${encodeURIComponent(w.id)}`)}
            />
          </div>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 10 }}>
        {t('dash.updated', { at: at.toLocaleTimeString() })}
        {dash.refreshSec ? ` · ${t('dash.autoRefresh', { n: dash.refreshSec })}` : ''}
      </div>
    </div>
  );
}
