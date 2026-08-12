import { useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';

// Measuring the paths between the nodes, and towards places we do not own.
//
// The matrix is read as a grid because that is what it is: rows are the box
// doing the asking, columns the box being reached. The number in a cell is the
// best connect time seen, with the spread beside it — an average would smooth
// away the one attempt in five that took a second, which is the attempt worth
// knowing about.
//
// Empty cells are never zeros. A node with no agent cannot be measured *from*,
// and the panel does not substitute its own vantage point: that would answer a
// different question in the same shape.

const fmtMs = (ms) => ms === null || ms === undefined ? '—' : `${ms} ms`;

function Cell({ c, t }) {
  if (!c) return <td className="hint">—</td>;
  if (!c.ok) {
    return (
      <td>
        <span className="badge err">{t('pr.noAnswer')}</span>
        {c.error && <div className="hint mono" >{c.error}</div>}
      </td>
    );
  }
  return (
    <td>
      <b>{fmtMs(c.minMs)}</b>
      <div className="hint" >
        {c.jitterMs ? t('pr.spread', { j: c.jitterMs }) : t('pr.steady')}
        {c.lossPct > 0 && <> · {t('pr.loss', { p: c.lossPct })}</>}
      </div>
    </td>
  );
}

export default function ProbePanel({ network }) {
  const { t } = useI18n();
  const [matrix, setMatrix] = useState(null);
  // The cache, which is the number that says whether this is a delivery
  // network or three parallel proxies. It lives beside the path measurements
  // because both answer "is the plumbing doing its job".
  const [cache, setCache] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const readCache = async () => {
    setBusy(true); setError('');
    try { setCache(await api(`/cdn/networks/${network.id}/cache`, { method: 'POST', body: {} })); }
    catch (e) { setError(e.data?.error || e.message); }
    finally { setBusy(false); }
  };

  const run = async () => {
    setBusy(true); setError('');
    try { setMatrix(await api(`/cdn/networks/${network.id}/probe/matrix`, { method: 'POST', body: {} })); }
    catch (e) { setError(e.data?.error || e.message); }
    finally { setBusy(false); }
  };

  // Rows and columns come from the cells themselves, so a node that could not
  // be asked simply has no row — rather than a row of zeros that reads as a
  // dead machine.
  const froms = [...new Set((matrix?.cells || []).map(c => c.from))];
  const tos = [...new Set((matrix?.cells || []).map(c => c.to))];
  const at = (from, to) => (matrix?.cells || []).find(c => c.from === from && c.to === to);

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>{t('pr.title')}</h2>
      <div className="hint">{t('pr.intro')}</div>
      {error && <div className="error-box">{error}</div>}

      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button className="primary" onClick={run} disabled={busy}>{busy ? '…' : t('pr.run')}</button>
        {matrix?.at && <span className="hint">{t('pr.measuredAt', { at: new Date(matrix.at).toLocaleTimeString() })}</span>}
        <button onClick={readCache} disabled={busy}>{t('cache.read')}</button>
      </div>

      {cache && (
        <div className="inset">
          <div className="gsection">{t('cache.title')}</div>
          <div className="hint">{t('cache.intro')}</div>
          {cache.rows.map((r, i) => (
            <div key={i} className="cfg-finding">
              <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <b>{r.server}</b>
                {!r.ok && <span className="badge err">{t('cdn.reason.' + r.reason)}</span>}
                {r.ok && r.hitRatio?.ratio != null && (
                  <span className={'badge ' + (r.hitRatio.ratio >= 95 ? 'live' : 'warn')}>
                    {t('cache.ratio', { pct: r.hitRatio.ratio })}
                  </span>
                )}
                {/* The honest case, and the likely one: the server answered and
                    said nothing about its cache. Saying so beats a zero. */}
                {r.ok && !r.hasAnyCacheData && <span className="badge">{t('cache.nothingReported')}</span>}
                {/* Said once, as a fact about Nimble rather than a gap in the
                    panel: this version reports sizes and no counters, so a hit
                    ratio is not obtainable here however long one waits. */}
                {r.ok && r.hasAnyCacheData && !r.ratioAvailable && (
                  <span className="hint">{t('cache.noCounters')}</span>
                )}
              </div>
              {/* Occupancy against capacity, which is what this Nimble
                  actually reports. The raw fields stay below it, named as the
                  server named them, so a number can be traced. */}
              {r.ok && r.stores?.map(st => (
                <div key={st.store} className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                  <span className="hint">{t('cache.store.' + st.store)}</span>
                  <b>{st.used} / {st.capacity} {st.unit}</b>
                  {st.fullPct != null && (
                    <span className={'badge ' + (st.fullPct > 90 ? 'warn' : '')}>
                      {t('cache.full', { pct: st.fullPct })}
                    </span>
                  )}
                </div>
              ))}
              {/* Hit ratio's question, in the form the data can answer. Shown
                  with its preconditions rather than as a bare number: a ratio
                  computed outside them is confidently wrong, which is worse
                  than the missing metric it replaced. */}
              {r.ok && r.amplification?.ok && r.amplification.ratio != null && (
                <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span className="hint">{t('cache.amp')}</span>
                  <b>×{r.amplification.ratio}</b>
                  <span className={'badge ' + (r.amplification.code === 'cache-absorbing' ? 'live'
                                             : r.amplification.code === 'cache-not-absorbing' ? 'err' : 'warn')}>
                    {t('cache.' + r.amplification.code)}
                  </span>
                  <span className="hint">{t('cache.ampOf', { n: r.viewers })}</span>
                </div>
              )}
              {r.ok && r.amplification?.ok && r.amplification.ratio == null && (
                <div className="hint">{t('cache.' + r.amplification.code)}</div>
              )}
              {r.ok && r.amplification && !r.amplification.ok && (
                <div className="hint">
                  {t('cache.ampBlocked')} {r.amplification.blocking.map(b => t('cache.block.' + b)).join('; ')}
                </div>
              )}
              {r.ok && r.reported?.length > 0 && (
                <div className="hint mono">
                  {r.reported.map(f => `${f.path}=${f.value}`).join(' · ')}
                </div>
              )}
              {/* Only when there is a bitrate to compute from. An idle edge
                  reports zero, and "should hold about 0.0 MB" is the absence of
                  an input dressed as an answer. */}
              {r.ok && r.expected?.bytes != null && (
                <div className="hint">
                  {t('cache.expected', {
                    mb: (r.expected.bytes / 1e6).toFixed(1),
                    n: r.expected.knownBitrates, chunks: r.expected.chunksPerStream,
                  })}
                </div>
              )}
              {r.ok && r.expected && r.expected.bytes == null && r.expected.streams > 0 && (
                <div className="hint">{t('cache.expectedUnknown', { n: r.expected.streams })}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {matrix && froms.length > 0 && (
        <table style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>{t('pr.fromTo')}</th>
              {tos.map(to => <th key={to}>{to}</th>)}
            </tr>
          </thead>
          <tbody>
            {froms.map(from => (
              <tr key={from}>
                <td><b>{from}</b></td>
                {tos.map(to => (from === to
                  ? <td key={to} className="hint">·</td>
                  : <Cell key={to} c={at(from, to)} t={t} />))}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {matrix && froms.length === 0 && (
        <div className="hint" style={{ marginTop: 10 }}>{t('pr.nothingMeasured')}</div>
      )}

      {matrix?.skipped?.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="hint">{t('pr.skippedTitle')}</div>
          {matrix.skipped.map((s, i) => (
            <div key={i} className="hint" style={{ fontSize: 12 }}>
              <span className="badge warn">{s.node}</span>{' '}
              {t('pr.skip.' + s.code, { have: s.have, need: s.need })}
              {s.error && <span className="mono"> · {s.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
