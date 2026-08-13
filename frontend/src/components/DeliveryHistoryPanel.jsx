import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';

// How delivery has been holding up, rather than whether it works right now.
//
// One reading answers a question somebody had at the moment they were already
// worried. The useful question — did this channel hold through the match, and
// if not, when did it stop — is about a stretch of time, and needs the panel
// to have been asking while nobody watched.
//
// Availability is deliberately three numbers rather than one percentage:
// every edge serving, some edges serving, and none. Averaging them hides which
// happened, and they call for different work — one is a machine, the other is
// the channel.
function Bar({ recent }) {
  const { t } = useI18n();
  if (!recent?.length) return null;
  // Oldest on the left, which is how time is read. The API returns newest
  // first because that is how it is queried.
  return (
    <div className="hist-bar" title={t('hist.barHint')}>
      {[...recent].reverse().map((c, i) => (
        <span key={i}
              className={'hist-tick ' + (c.total === 0 ? '' : c.ok === c.total ? 'ok' : c.ok > 0 ? 'part' : 'bad')}
              title={`${new Date(c.at).toLocaleTimeString()} — ${c.ok}/${c.total}`} />
      ))}
    </div>
  );
}

export default function DeliveryHistoryPanel({ network }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const [data, setData] = useState(null);
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async (h = hours) => {
    try { setData(await api(`/cdn/networks/${network.id}/history?hours=${h}`)); setError(''); }
    catch (e) { setError(e.data?.error || e.message); }
  };
  useEffect(() => { load(); }, [network.id, hours]);

  const setMonitor = async (patch) => {
    setBusy(true);
    try { await api(`/cdn/networks/${network.id}/monitor`, { method: 'PUT', body: patch }); await load(); }
    catch (e) { setError(e.data?.error || e.message); }
    finally { setBusy(false); }
  };

  if (error) return <div className="error-box">{error}</div>;
  // Shaped, not merely present. A response that arrived without the fields
  // this reads is not "loaded" — treating it as such took the whole delivery
  // step down with an undefined, which is how a monitoring panel becomes the
  // outage.
  if (!data?.monitor || !Array.isArray(data.channels)) {
    return <div className="hint">{t('sd.loading')}</div>;
  }

  return (
    <>
      <div className="gsection">{t('hist.title')}</div>
      <div className="hint">{t('hist.intro')}</div>

      <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
        {/* Off by default and switched on per network: being the viewer is
            real traffic to real servers, so the operator decides. */}
        {can('cdn.manage') && (
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
            <input type="checkbox" checked={data.monitor.enabled} disabled={busy}
                   onChange={e => setMonitor({ enabled: e.target.checked })} />
            {t('hist.watch')}
          </label>
        )}
        {data.monitor.enabled && (
          <span className="hint">{t('hist.every', { n: data.monitor.intervalMin })}</span>
        )}
        <div style={{ flex: 1 }} />
        {[1, 24, 168].map(h => (
          <button key={h} className={'tagchip' + (hours === h ? ' on' : '')} onClick={() => setHours(h)}>
            {t('hist.window.' + h)}
          </button>
        ))}
      </div>

      {!data.channels.length ? (
        // Never checked is not "healthy": 100% of nothing is the most
        // flattering number available and the panel does not print it.
        <div className="hint inset">{t(data.monitor.enabled ? 'hist.waiting' : 'hist.none')}</div>
      ) : (
        <table style={{ marginTop: 10 }}>
          <thead><tr>
            <th>{t('ch.channel')}</th><th>{t('hist.avail')}</th>
            <th>{t('hist.recent')}</th><th>{t('hist.worst')}</th>
          </tr></thead>
          <tbody>
            {data.channels.map(c => (
              <tr key={c.channel}>
                <td className="mono">{c.channel}</td>
                <td>
                  {c.availability ? (
                    <>
                      <b>{c.availability.pct}%</b>
                      <div className="hint">
                        {t('hist.counts', {
                          served: c.availability.served,
                          partial: c.availability.partial,
                          failed: c.availability.failed,
                        })}
                      </div>
                      {c.availability.reasons?.length > 0 && (
                        <div className="hint">
                          {c.availability.reasons.map(r => t('cdn.w.' + r.code) + ` ×${r.n}`).join(' · ')}
                        </div>
                      )}
                    </>
                  ) : <span className="hint">{t('hist.never')}</span>}
                </td>
                <td><Bar recent={c.recent} /></td>
                <td>{c.availability?.worstMs != null
                  ? <span className={c.availability.worstMs > 2000 ? 'badge warn' : ''}>
                      {c.availability.worstMs} ms
                    </span>
                  : <span className="hint">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
