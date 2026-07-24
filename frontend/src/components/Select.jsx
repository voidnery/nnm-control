import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import SearchInput from './SearchInput.jsx';
import { useI18n } from '../i18n.jsx';

// Custom themed select. Drop-in-ish: value + onChange(value) + options
// [{value,label}] or children via `options`. Supports optional search.
//
// The dropdown renders in a portal with fixed positioning: modals are scroll
// containers (overflow:auto), which would clip an absolutely-positioned popup
// and break the form layout. Fixed + portal keeps it above everything and
// leaves the modal's own layout untouched.
export default function Select({ value, onChange, options = [], placeholder = '— select —', searchable = false, disabled = false }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pos, setPos] = useState(null); // { left, top, width, maxHeight, dropUp }
  const ref = useRef(null);
  const popRef = useRef(null);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 4;
    const below = window.innerHeight - r.bottom - gap - 8;
    const above = r.top - gap - 8;
    const dropUp = below < 180 && above > below;
    const maxHeight = Math.max(120, Math.min(280, dropUp ? above : below));
    setPos({
      left: r.left,
      top: dropUp ? r.top - gap : r.bottom + gap,
      // A narrow trigger must not produce an unreadable dropdown.
      width: Math.max(r.width, 180),
      maxHeight,
      dropUp,
    });
  }, []);

  useLayoutEffect(() => { if (open) measure(); }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (ref.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const onMove = () => measure();
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    // capture:true so we also follow scrolling inside modals/panels
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, measure]);

  const current = options.find(o => String(o.value) === String(value));
  const shown = searchable && q
    ? options.filter(o => String(o.label).toLowerCase().includes(q.toLowerCase()))
    : options;

  const pop = open && pos && createPortal(
    <div ref={popRef} className="cselect-pop"
         style={{
           left: pos.left, width: pos.width, maxHeight: pos.maxHeight,
           ...(pos.dropUp ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
         }}>
      {searchable && (
        <div className="cselect-search">
          <SearchInput autoFocus value={q} onChange={setQ} />
        </div>
      )}
      {shown.map(o => (
        <div key={o.value}
             className={'cselect-opt' + (String(o.value) === String(value) ? ' selected' : '')}
             onClick={() => { onChange(o.value); setOpen(false); setQ(''); }}>
          {o.label}
        </div>
      ))}
      {shown.length === 0 && <div className="cselect-opt" style={{ color: 'var(--text-dim)' }}>{t('cm.noMatches')}</div>}
    </div>,
    document.body
  );

  return (
    <div className="cselect" ref={ref}>
      <button type="button" className="cselect-btn" disabled={disabled}
              onClick={() => !disabled && setOpen(v => !v)}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {current ? current.label : <span style={{ color: 'var(--text-dim)' }}>{placeholder}</span>}
        </span>
        <span className="caret">▼</span>
      </button>
      {pop}
    </div>
  );
}
