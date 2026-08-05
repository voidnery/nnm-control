import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useI18n } from './i18n.jsx';

// Where the panel's technical remarks go.
//
// Lines like "64 streams matched; 12 more shown from WMSPanel data" were
// printed above the table they described. Each is true and worth having, and
// each pushed the actual content further down the page — so on a tab with
// three of them the list started below the fold and the notices were read
// once, on the first day, and never again.
//
// They collect here instead: out of the way, countable, and clearable by the
// person who has finished reading them.
//
// Deliberately NOT toasts. A toast is for something that just happened and
// disappears; these describe a standing condition of the page and are wanted
// on the fifth visit as much as the first.

const Ctx = createContext(null);

export function NoticeProvider({ children }) {
  const [items, setItems] = useState([]);

  // Keyed by text: a notice recomputed on every refresh would otherwise stack
  // up twenty copies of itself in a morning.
  const notify = useCallback((text, scope = '') => {
    const line = String(text || '').trim();
    if (!line) return;
    setItems(prev => {
      const at = prev.findIndex(x => x.text === line && x.scope === scope);
      if (at >= 0) {
        const next = [...prev];
        next[at] = { ...next[at], at: Date.now(), n: next[at].n + 1 };
        return next;
      }
      // Bounded: a page in a loop must not grow this without limit.
      return [{ id: `${Date.now()}-${Math.random()}`, text: line, scope, at: Date.now(), n: 1 },
              ...prev].slice(0, 50);
    });
  }, []);

  const clear = useCallback(() => setItems([]), []);
  const value = useMemo(() => ({ items, notify, clear }), [items, notify, clear]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNotices() {
  // A no-op outside the provider rather than a throw: a component that reports
  // something should not be the reason a page fails to render.
  return useContext(Ctx) || { items: [], notify: () => {}, clear: () => {} };
}

/** The reader, for the top-right corner. */
export function NoticeTray() {
  const { items, clear } = useNotices();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!items.length) return null;

  return (
    <div className="notice-tray">
      <button className={open ? 'primary' : ''} onClick={() => setOpen(v => !v)}>
        {t('notice.count', { n: items.length })}
      </button>
      {open && (
        <div className="notice-list panel">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <b>{t('notice.title')}</b>
            <button onClick={() => { clear(); setOpen(false); }}>{t('notice.clear')}</button>
          </div>
          {items.map(it => (
            <div key={it.id} className="notice-item">
              {it.scope && <div className="hint" style={{ fontSize: 11 }}>{it.scope}</div>}
              <div>{it.text}</div>
              {it.n > 1 && <div className="hint" style={{ fontSize: 11 }}>{t('notice.repeated', { n: it.n })}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
