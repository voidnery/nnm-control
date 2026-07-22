import { createContext, useCallback, useContext, useState } from 'react';

// Lightweight toast system. useToast().push({ type, title, message }).
// Types: 'ok' | 'error' | 'info'. Auto-dismiss after a timeout.
const ToastCtx = createContext({ push: () => {} });

let idc = 0;
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const remove = useCallback((id) => setToasts(ts => ts.filter(t => t.id !== id)), []);
  const push = useCallback((t) => {
    const id = ++idc;
    const toast = { id, type: t.type || 'info', title: t.title || '', message: t.message || '' };
    setToasts(ts => [...ts, toast]);
    setTimeout(() => remove(id), t.duration || 3800);
  }, [remove]);

  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toast-wrap">
        {toasts.map(t => (
          <div key={t.id} className={'toast ' + t.type} onClick={() => remove(t.id)}>
            {t.title && <div className="toast-title">{t.title}</div>}
            {t.message && <div className="toast-msg">{t.message}</div>}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);
