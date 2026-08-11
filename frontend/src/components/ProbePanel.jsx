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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
      </div>

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
