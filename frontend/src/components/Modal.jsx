import { useEffect, useRef } from 'react';

// Custom modal with SAFE close semantics: a click that STARTS inside the modal
// (e.g. text selection dragged out) must NOT close it. Only a genuine
// press-and-release on the backdrop closes. Esc also closes.
export default function Modal({ children, onClose, size = '' }) {
  const downOnBack = useRef(false);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal-back"
      onMouseDown={(e) => { downOnBack.current = e.target === e.currentTarget; }}
      onMouseUp={(e) => {
        // close only if BOTH press and release happened on the backdrop itself
        if (downOnBack.current && e.target === e.currentTarget) onClose?.();
        downOnBack.current = false;
      }}
    >
      <div className={'modal ' + (size ? 'w-' + size : '')} onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
