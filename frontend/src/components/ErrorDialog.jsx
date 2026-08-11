import { useState } from 'react';
import { useI18n } from '../i18n.jsx';
import Modal from './Modal.jsx';

// The house style for showing a failure.
//
// A red bar at the top of a long page carrying a machine word is the worst of
// both: it is far from whatever the operator just clicked, and it says nothing
// they can act on. This is a dialog, next to the action, with the sentence
// first, the fix second, and the technical detail folded for whoever needs it.
//
// It takes either one problem or a list of them, because a bulk action fails
// per item and "3 failed" is the summary that makes the operator go find out
// which three, one at a time — the work the bulk button existed to save.
function One({ p }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="panel" style={{ marginBottom: 8 }}>
      {p.server && (
        <div className="row" style={{ gap: 6, alignItems: 'baseline' }}>
          <b>{p.server}</b>
          {p.host && <span className="mono hint" style={{ fontSize: 12 }}>{p.host}</span>}
        </div>
      )}
      <div style={{ marginTop: 4 }}>{p.title}</div>
      {p.subject && <div className="hint mono" style={{ fontSize: 12 }}>{t('err.lookedAt')} {p.subject}</div>}
      {p.fix && <div className="hint" style={{ marginTop: 6 }}>{p.fix}</div>}
      {p.detail && (
        <div style={{ marginTop: 6 }}>
          <button onClick={() => setOpen(v => !v)} style={{ fontSize: 11, padding: '1px 6px' }}>
            {open ? '▾' : '▸'} {t('err.detail')}
          </button>
          {open && (
            <div className="mono hint" style={{ fontSize: 11, marginTop: 4, wordBreak: 'break-all' }}>
              {p.status ? `HTTP ${p.status} · ` : ''}{p.code ? `${p.code} · ` : ''}{p.detail}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ErrorDialog({ problem, onClose, onFix = null }) {
  const { t } = useI18n();
  if (!problem) return null;
  const items = problem.items || [problem];

  return (
    <Modal onClose={onClose}>
      <h3>{problem.items ? problem.title : t('err.title')}</h3>
      <div style={{ maxHeight: '55vh', overflow: 'auto' }}>
        {items.map((p, i) => <One key={i} p={p} />)}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        {onFix && <button className="primary" onClick={onFix}>{t('err.fixNow')}</button>}
        <button onClick={onClose}>{t('action.close')}</button>
      </div>
    </Modal>
  );
}
