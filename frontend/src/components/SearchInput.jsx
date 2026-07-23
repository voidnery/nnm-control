import { useRef } from 'react';

// Text search field with a clear (×) affordance. Used for every filter/search
// box in the app so they behave identically: Escape clears too, and focus
// returns to the field after clearing.
export default function SearchInput({
  value, onChange, placeholder = 'Filter…', autoFocus = false,
  style, className = '', title,
}) {
  const ref = useRef(null);
  const clear = () => { onChange(''); ref.current?.focus(); };
  return (
    <div className={'searchbox ' + className} style={style}>
      <input
        ref={ref}
        value={value}
        autoFocus={autoFocus}
        title={title}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape' && value) { e.stopPropagation(); clear(); } }}
      />
      {value && (
        <button type="button" className="searchbox-clear" onClick={clear}
                title="Clear" aria-label="Clear">×</button>
      )}
    </div>
  );
}
