import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { explainError } from '../lib/errors.js';

// The other half of LL-HLS: the checkbox in WMSPanel, and the part duration.
//
// Neither half alone produces low latency, and each succeeds on its own —
// which is why they are two sections rather than one button. An operator who
// presses this on an edge whose transport is not up gets a setting that
// applies and a viewer who sees ordinary HLS, so the state of the transport is
// carried in and said out loud.
//
// Three things this must not lose, all of them measured rather than read:
//
//   * the part is refused outside 500 ms … half the chunk, never clamped;
//   * switching container removes plain HLS, so it is its own consent;
//   * **the input stream has to be restarted**, and the panel cannot do it for
//     a published stream — so it says so instead of reporting the write as a
//     working feature.

export default function EdgeApplications({ edgeId, transportReady, onProblem, onChanged }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const canManage = can('servers.manage');

  const [apps, setApps] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState('');
  const [parts, setParts] = useState({});
  const [fmp4, setFmp4] = useState({});
  const [done, setDone] = useState(null);

  const load = () => {
    setError(null);
    api(`/llhls/edges/${edgeId}/applications`)
      .then(d => {
        setApps(d.applications || []);
        // Prefill each row with what it already has, or with the vendor's
        // recommendation where it fits. Not a blank box the operator has to
        // fill from memory.
        setParts(Object.fromEntries((d.applications || []).map(a => [
          a.id, a.part ?? (a.range ? Math.min(2000, a.range.max) : ''),
        ])));
      })
      .catch(e => setError(explainError(e, t)));
  };
  useEffect(load, [edgeId]);

  const apply = async (app, enable) => {
    setBusy(app.id); setDone(null);
    try {
      const r = await api(`/llhls/edges/${edgeId}/applications/${app.id}`, {
        method: 'POST',
        body: { enable, partMs: Number(parts[app.id]), switchToFmp4: Boolean(fmp4[app.id]) },
      });
      setDone({ app: app.name, ...r });
      load();
      onChanged?.();
    } catch (e) { onProblem(explainError(e, t)); }
    finally { setBusy(''); }
  };

  if (error) return <div className="error-box">{error.title}{error.fix ? ` — ${error.fix}` : ''}</div>;
  if (!apps) return <div className="hint">{t('llhls.loading')}</div>;
  if (!apps.length) return <div className="hint">{t('llhls.app.none')}</div>;

  return (
    <div className="llhls-apps">
      <h4>{t('llhls.app.title')}</h4>

      {/* Stated before anything can be pressed, not after it has been. */}
      {transportReady === false && <div className="error-box">{t('llhls.app.transportNotReady')}</div>}

      <table className="llhls-grid">
        <thead>
          <tr>
            <th>{t('llhls.app.name')}</th>
            <th>{t('llhls.app.chunk')}</th>
            <th>{t('llhls.app.state')}</th>
            <th>{t('llhls.app.part')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {apps.map(a => (
            <tr key={a.id}>
              <td className="mono">{a.name}</td>
              <td className="mono">{a.chunk}</td>
              <td>
                {/* Three states. `null` means the application carries no HLS
                    container at all, so the checkbox does not exist for it —
                    which is not the same as being switched off. */}
                {a.applicable === false ? <span className="hint">{t('llhls.app.na')}</span>
                  : a.alhls ? <span className="llhls-mark ok">✓</span>
                  : <span className="llhls-mark bad">✗</span>}
              </td>
              <td>
                {a.applicable !== false && (
                  <>
                    <input type="number" className="mono" style={{ width: 90 }}
                           value={parts[a.id] ?? ''}
                           onChange={e => setParts(p => ({ ...p, [a.id]: e.target.value }))} />
                    {a.range && <span className="hint"> {a.range.min}…{a.range.max}</span>}
                    {!a.range && <span className="hint"> {t('llhls.app.chunkTooShort')}</span>}
                  </>
                )}
              </td>
              <td>
                {a.applicable !== false && a.range && (
                  <>
                    <button disabled={!canManage || busy === a.id}
                            onClick={() => apply(a, !a.alhls)}>
                      {t(a.alhls ? 'llhls.app.turnOff' : 'llhls.app.turnOn')}
                    </button>
                    {a.containerNote && !a.alhls && (
                      <label className="hint" style={{ display: 'block', marginTop: 4 }}>
                        <input type="checkbox" checked={Boolean(fmp4[a.id])}
                               onChange={e => setFmp4(f => ({ ...f, [a.id]: e.target.checked }))} />
                        {' '}{t('llhls.app.switchFmp4')}
                      </label>
                    )}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* The container advice, once, rather than on every row. Measured:
          adding fMP4 removes plain HLS, so this is a switch and it interrupts
          every current viewer of that application. */}
      {apps.some(a => a.containerNote) && (
        <div className="hint">{t('llhls.app.containerNote')}</div>
      )}

      {done && (
        <div className={done.applied ? 'hint' : 'error-box'}>
          <b>{t(done.applied ? 'llhls.app.written' : 'llhls.app.notWritten', { app: done.app })}</b>
          {done.dropped?.length > 0 && <div>{t('llhls.app.dropped', { list: done.dropped.join(', ') })}</div>}
          {/* The step nothing here can do. Every time, because it is what
              decides whether any of this reaches a viewer. */}
          {done.restartRequired && <div className="error-box">{t('llhls.app.restart')}</div>}
        </div>
      )}
    </div>
  );
}
