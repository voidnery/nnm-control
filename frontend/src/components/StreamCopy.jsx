import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import Modal from './Modal.jsx';

// Cross-server copy of stream objects. Selection lives per (server, kind).
// The backend does the field mapping, pausing, and source-portability warnings.
export function useStreamCopy(serverId, kind, onDone) {
  const [selected, setSelected] = useState([]);   // source object ids
  const [open, setOpen] = useState(false);

  const isSel = useCallback((id) => selected.includes(String(id)), [selected]);
  const toggle = useCallback((id) => {
    const s = String(id);
    setSelected(sel => sel.includes(s) ? sel.filter(x => x !== s) : [...sel, s]);
  }, []);
  const setMany = useCallback((ids, on) => {
    setSelected(sel => {
      const set = new Set(sel);
      ids.map(String).forEach(id => on ? set.add(id) : set.delete(id));
      return Array.from(set);
    });
  }, []);
  const clear = useCallback(() => setSelected([]), []);

  const copy = useCallback(async (targetServerId, startPaused) => {
    const body = { sourceServerId: serverId, targetServerId, kind, ids: selected, startPaused };
    return api('/wmspanel/copy-streams', { method: 'POST', body });
  }, [serverId, kind, selected]);

  return { selected, isSel, toggle, setMany, clear, open, setOpen, copy, kind, onDone };
}

export function CopyCheckbox({ cp, id }) {
  return <input type="checkbox" checked={cp.isSel(id)} onChange={() => cp.toggle(id)} onClick={e => e.stopPropagation()} />;
}

// Selection toolbar — appears only when at least one row is selected.
export function CopySelectionBar({ cp, visibleIds = [] }) {
  const { t } = useI18n();
  if (!cp.selected.length) {
    // still offer select-all affordance when there are rows
    return null;
  }
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => cp.isSel(id));
  return (
    <div className="row copybar" style={{ alignItems: 'center', gap: 10, marginBottom: 10 }}>
      <b>{t('copy.selected', { n: cp.selected.length })}</b>
      <button className="primary" onClick={() => cp.setOpen(true)}>{t('copy.copyTo')}</button>
      {visibleIds.length > 0 && (
        <button onClick={() => cp.setMany(visibleIds, !allVisibleSelected)}>
          {allVisibleSelected ? t('copy.deselectVisible') : t('copy.selectVisible')}
        </button>
      )}
      <button className="linklike" onClick={cp.clear}>{t('copy.clear')}</button>
    </div>
  );
}

// Target-server picker + startPaused + per-object results.
export function CopyModal({ cp, currentServerId }) {
  const { t } = useI18n();
  const [servers, setServers] = useState(null);
  const [target, setTarget] = useState('');
  const [startPaused, setStartPaused] = useState(true);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!cp.open) return;
    setResults(null); setError(''); setTarget('');
    api('/servers')
      .then(list => setServers((list || []).filter(s => s.id !== currentServerId && s.wmspanelServerId)))
      .catch(e => setError(e.message));
  }, [cp.open, currentServerId]);

  if (!cp.open) return null;

  const run = async () => {
    if (!target) return;
    setBusy(true); setError('');
    try { setResults(await cp.copy(target, startPaused)); cp.onDone?.(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={() => cp.setOpen(false)}>
      <h3>{t('copy.title', { n: cp.selected.length })}</h3>
      {error && <div className="error-box">{error}</div>}

      {!results ? (
        <div>
          <div style={{ marginBottom: 10 }}>
            <label>{t('copy.target')}</label>
            {servers === null ? <div className="hint">Loading…</div>
              : servers.length === 0 ? <div className="hint">{t('copy.noTargets')}</div>
              : (
                <select value={target} onChange={e => setTarget(e.target.value)}>
                  <option value="">— {t('copy.pick')} —</option>
                  {servers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              )}
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <input type="checkbox" checked={startPaused} onChange={e => setStartPaused(e.target.checked)} />
            {t('copy.startPaused')}
          </label>
          <div className="hint" style={{ marginBottom: 12 }}>{t('copy.hint')}</div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button onClick={() => cp.setOpen(false)}>{t('action.cancel')}</button>
            <button className="primary" disabled={busy || !target} onClick={run}>{t('copy.doCopy')}</button>
          </div>
        </div>
      ) : (
        <div>
          <div style={{ marginBottom: 8 }}>
            <b>{t('copy.done', { ok: results.okCount, total: results.total })}</b>
          </div>
          <div className="panel" style={{ maxHeight: 320, overflow: 'auto' }}>
            <table>
              <thead><tr><th>{t('copy.source')}</th><th></th><th>{t('copy.notes')}</th></tr></thead>
              <tbody>
                {results.results.map(r => (
                  <tr key={r.sourceId}>
                    <td className="mono">{String(r.sourceId).slice(-8)}</td>
                    <td>{r.ok ? <span className="lamp on" /> : <span className="lamp off" />}{r.ok ? t('copy.ok') : t('copy.fail')}</td>
                    <td className="hint">
                      {r.error && <div>{r.error}</div>}
                      {(r.warnings || []).map((w, i) => <div key={i}>⚠ {w}</div>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="primary" onClick={() => { cp.setOpen(false); cp.clear(); }}>{t('action.done')}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
