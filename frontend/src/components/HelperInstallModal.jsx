import { useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import Modal from './Modal.jsx';
import { copyText } from '../lib/clipboard.js';
import { purposeOf, helperState } from '../lib/capabilities.js';

// Installing the privileged helper, on its own.
//
// It used to exist only inside the gateway setup dialog, which is why a
// delivery media server could not get one: the dialog was gated on
// `purpose === 'gateway'`, so the button was absent and the operator's only
// route to a helper was to relabel the machine as an edge-proxy — a lie about
// what the machine is, told to the panel, to work around the panel.
//
// The helper is not a gateway thing. It is what lets the panel change a system
// at all, and two kinds of machine need one for two different reasons. The
// profile it installs follows from the purpose and is not asked: an operator
// answers what a machine is for, once, on the server card, and everything else
// is derived from that.
export default function HelperInstallModal({ server, onClose, onDone }) {
  const { t } = useI18n();
  const [script, setScript] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const purpose = purposeOf(server);
  const state = helperState(server);

  const get = async () => {
    setBusy(true); setError('');
    try {
      setScript(await api(`/servers/${server.id}/privileged/script`, { method: 'POST', body: {} }));
    } catch (e) {
      const code = e.data?.code;
      setError(code && t('err.' + code) !== 'err.' + code ? t('err.' + code) : (e.data?.error || e.message));
    } finally { setBusy(false); }
  };

  // Through the shared helper: `navigator.clipboard` is absent over plain
  // HTTP, which is exactly how a panel on a LAN address is reached, and the
  // direct call fails silently there.
  const copy = async () => setCopied(await copyText(script.script));

  return (
    <Modal onClose={onClose} size="wide">
      <h3>{t('helper.title', { server: server.name })}</h3>

        {/* What it will be able to do, before it can do anything. The two
            profiles differ in a way that matters and is invisible once
            installed. */}
        <p className="hint">{t('helper.what.' + purpose)}</p>
        <p className="hint">{t('helper.limits')}</p>

        {state === 'installed' && <p className="hint">{t('helper.already')}</p>}

        {!script && (
          <button disabled={busy} onClick={get}>{t('helper.get')}</button>
        )}

        {error && <div className="error-box">{error}</div>}

        {script && (
          <>
            {/* Shown, not run. This installs a root service; an operator who
                cannot read what they are about to run has not consented to
                it. */}
            <p className="hint">{t('helper.runIt')}</p>
            <pre className="mono helper-script">{script.script}</pre>
            <div className="row">
              <button onClick={copy}>{copied ? t('helper.copied') : t('helper.copy')}</button>
              <button onClick={() => { onDone?.(); onClose(); }}>{t('helper.done')}</button>
            </div>
          </>
        )}

      <div className="row">
        <button onClick={onClose}>{t('action.close')}</button>
      </div>
    </Modal>
  );
}
