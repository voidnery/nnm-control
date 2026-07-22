import { createContext, useCallback, useContext, useRef, useState } from 'react';
import Modal from './components/Modal.jsx';
import { useI18n } from './i18n.jsx';

// Promise-based confirm dialog in the app's own style.
//   const confirm = useConfirm();
//   if (await confirm({ title, message, danger })) { ... }
const ConfirmCtx = createContext(() => Promise.resolve(false));

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null); // { title, message, danger }
  const resolver = useRef(null);
  let t = (k) => k;
  try { t = useI18n().t; } catch { /* i18n may be unavailable */ }

  const confirm = useCallback((opts) => {
    return new Promise((resolve) => {
      resolver.current = resolve;
      setState({
        title: opts?.title || '',
        message: typeof opts === 'string' ? opts : (opts?.message || ''),
        danger: Boolean(opts?.danger),
        confirmLabel: opts?.confirmLabel,
        cancelLabel: opts?.cancelLabel,
      });
    });
  }, []);

  const close = (val) => { setState(null); resolver.current?.(val); resolver.current = null; };

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {state && (
        <Modal onClose={() => close(false)} size="narrow">
          {state.title && <h3>{state.title}</h3>}
          <div style={{ color: 'var(--text-dim)', marginBottom: 4 }}>{state.message}</div>
          <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
            <button onClick={() => close(false)}>{state.cancelLabel || t('action.cancel')}</button>
            <button className={state.danger ? 'danger' : 'primary'} autoFocus onClick={() => close(true)}>
              {state.confirmLabel || t('action.confirm')}
            </button>
          </div>
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}
export const useConfirm = () => useContext(ConfirmCtx);
