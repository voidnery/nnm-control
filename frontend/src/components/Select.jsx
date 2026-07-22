import { useEffect, useRef, useState } from 'react';

// Custom themed select. Drop-in-ish: value + onChange(value) + options
// [{value,label}] or children via `options`. Supports optional search.
export default function Select({ value, onChange, options = [], placeholder = '— select —', searchable = false, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const current = options.find(o => String(o.value) === String(value));
  const shown = searchable && q
    ? options.filter(o => o.label.toLowerCase().includes(q.toLowerCase()))
    : options;

  return (
    <div className="cselect" ref={ref}>
      <button type="button" className="cselect-btn" disabled={disabled}
              onClick={() => !disabled && setOpen(v => !v)}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {current ? current.label : <span style={{ color: 'var(--text-dim)' }}>{placeholder}</span>}
        </span>
        <span className="caret">▼</span>
      </button>
      {open && (
        <div className="cselect-pop">
          {searchable && (
            <div className="cselect-search">
              <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Filter…" />
            </div>
          )}
          {shown.map(o => (
            <div key={o.value}
                 className={'cselect-opt' + (String(o.value) === String(value) ? ' selected' : '')}
                 onClick={() => { onChange(o.value); setOpen(false); setQ(''); }}>
              {o.label}
            </div>
          ))}
          {shown.length === 0 && <div className="cselect-opt" style={{ color: 'var(--text-dim)' }}>No matches</div>}
        </div>
      )}
    </div>
  );
}
