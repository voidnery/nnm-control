import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { backdropClose } from '../components/Modal.jsx';
import { useI18n } from '../i18n.jsx';
import { useConfirm } from '../confirm.jsx';
import { copyText } from '../lib/clipboard.js';

// Webhook subscriptions (evt/1 — eterix-contracts/evt-1.md; docs/api/PROPOSAL-nnm-api-1.md §3). Every
// delivery is signed: X-Eterix-Signature: v1=HMAC-SHA256(secret, timestamp + "." + body). The secret
// is shown once, right after the subscription is created.
const asList = (v) => (Array.isArray(v) ? v : []);

function SubscriptionModal({ types, onClose, onCreated }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('https://');
  const [picked, setPicked] = useState(new Set());
  const [allowHttp, setAllowHttp] = useState(false);
  const [error, setError] = useState('');
  const toggle = (k) => setPicked(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const create = async () => {
    setError('');
    try {
      onCreated(await api('/webhooks', { method: 'POST', body: { name, url, types: [...picked], allowHttp } }));
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="modal-back" {...backdropClose(onClose)}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>{t('wh.new')}</h3>
        <label>{t('wh.name')}</label>
        <input value={name} onChange={e => setName(e.target.value)} />
        <label>{t('wh.url')}</label>
        <input className="mono" value={url} onChange={e => setUrl(e.target.value)} />
        <label>
          <input type="checkbox" checked={allowHttp} onChange={e => setAllowHttp(e.target.checked)} /> {t('wh.allowHttp')}
        </label>
        <label>{t('wh.types')}</label>
        <div className="hint">{t('wh.typesHint')}</div>
        <div className="perm-grid">
          {types.map(k => (
            <label key={k}>
              <input type="checkbox" checked={picked.has(k)} onChange={() => toggle(k)} />
              <span className="mono">{k}</span>
            </label>
          ))}
        </div>
        {error && <div className="error-box">{error}</div>}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>{t('action.cancel')}</button>
          <button className="primary" onClick={create} disabled={!name.trim() || !url.trim()}>{t('wh.create')}</button>
        </div>
      </div>
    </div>
  );
}

function SecretModal({ created, onClose }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="modal-back" {...backdropClose(onClose)}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>{t('wh.secretTitle', { name: created.name })}</h3>
        <div className="hint">{t('wh.secretOnce')}</div>
        <input className="mono" readOnly value={created.secret} onFocus={e => e.target.select()} />
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={async () => setCopied(await copyText(created.secret))}>{copied ? t('tok.copied') : t('tok.copy')}</button>
          <button className="primary" onClick={onClose}>{t('action.close')}</button>
        </div>
      </div>
    </div>
  );
}

function DeliveriesModal({ sub, onClose }) {
  const { t } = useI18n();
  const [list, setList] = useState([]);
  const [error, setError] = useState('');
  const load = () => api(`/webhooks/${sub.id}/deliveries`).then(d => setList(asList(d))).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);
  const redeliver = async (d) => {
    try { await api(`/webhooks/${sub.id}/deliveries/${d.id}/redeliver`, { method: 'POST' }); load(); }
    catch (e) { setError(e.message); }
  };
  return (
    <div className="modal-back" {...backdropClose(onClose)}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>{t('wh.deliveriesTitle', { name: sub.name })}</h3>
        {error && <div className="error-box">{error}</div>}
        <table>
          <thead><tr><th>{t('wh.event')}</th><th>{t('wh.status')}</th><th>{t('wh.attempts')}</th><th>{t('wh.last')}</th><th></th></tr></thead>
          <tbody>
            {list.map(d => (
              <tr key={d.id}>
                <td className="mono">{d.type}<div className="hint">{d.eventId}</div></td>
                <td><span className="badge">{d.status}</span></td>
                <td>{d.attempts}</td>
                <td className="hint">{d.lastCode ? `HTTP ${d.lastCode}` : ''} {d.lastError}</td>
                <td style={{ textAlign: 'right' }}>
                  {d.status !== 'pending' && <button onClick={() => redeliver(d)}>{t('wh.redeliver')}</button>}
                </td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={5} className="hint">{t('wh.noDeliveries')}</td></tr>}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>{t('action.close')}</button>
        </div>
      </div>
    </div>
  );
}

// server.* and stream.* need the panel to look; how often, and how patiently (services/eventWatch.js).
function WatchPanel() {
  const { t } = useI18n();
  const [w, setW] = useState(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { api('/webhooks/watch').then(setW).catch(e => setMsg(e.message)); }, []);
  if (!w) return msg ? <div className="error-box">{msg}</div> : null;
  const save = async () => {
    try {
      setW(await api('/webhooks/watch', { method: 'PUT', body: { enabled: w.enabled, intervalSec: Number(w.intervalSec), downAfter: Number(w.downAfter) } }));
      setMsg(t('wh.watchSaved'));
    } catch (e) { setMsg(e.message); }
  };
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <h3>{t('wh.watch')}</h3>
      <div className="hint">{t('wh.watchHint', { days: w.certWarnDays ?? 20 })}</div>
      <div className="row" style={{ gap: 14, alignItems: 'flex-end', marginTop: 10 }}>
        <label><input type="checkbox" checked={w.enabled} onChange={e => setW({ ...w, enabled: e.target.checked })} /> {t('wh.watchOn')}</label>
        <label>{t('wh.watchEvery')}<input type="number" min={10} max={600} value={w.intervalSec} onChange={e => setW({ ...w, intervalSec: e.target.value })} /></label>
        <label>{t('wh.watchDownAfter')}<input type="number" min={1} max={10} value={w.downAfter} onChange={e => setW({ ...w, downAfter: e.target.value })} /></label>
        <button className="primary" onClick={save}>{t('wh.watchSave')}</button>
      </div>
      {msg && <div className="hint">{msg}</div>}
    </div>
  );
}

export default function WebhooksPage() {
  const confirm = useConfirm();
  const { t } = useI18n();
  const [subs, setSubs] = useState([]);
  const [types, setTypes] = useState([]);
  const [modal, setModal] = useState(false);
  const [created, setCreated] = useState(null);
  const [deliveries, setDeliveries] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = async () => {
    try {
      setSubs(asList(await api('/webhooks')));
      setTypes(asList(await api('/webhooks/types').catch(() => [])));
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const setEnabled = async (s, enabled) => {
    try { await api(`/webhooks/${s.id}`, { method: 'PUT', body: { enabled } }); load(); }
    catch (e) { setError(e.message); }
  };
  const remove = async (s) => {
    if (!(await confirm(t('wh.confirmDelete', { name: s.name })))) return;
    try { await api(`/webhooks/${s.id}`, { method: 'DELETE' }); load(); }
    catch (e) { setError(e.message); }
  };
  const test = async (s) => {
    try { await api(`/webhooks/${s.id}/test`, { method: 'POST' }); setNote(t('wh.testQueued', { name: s.name })); }
    catch (e) { setError(e.message); }
  };

  return (
    <div>
      <h1>{t('page.webhooks.title')}</h1>
      <div className="sub">{t('page.webhooks.sub')}</div>
      {error && <div className="error-box">{error}</div>}
      {note && <div className="hint">{note}</div>}
      <button className="primary" style={{ marginBottom: 14 }} onClick={() => setModal(true)}>+ {t('wh.new')}</button>
      <div className="panel">
        <table>
          <thead><tr><th>{t('wh.name')}</th><th>{t('wh.url')}</th><th>{t('wh.types')}</th><th>{t('wh.status')}</th><th></th></tr></thead>
          <tbody>
            {subs.map(s => (
              <tr key={s.id}>
                <td><b>{s.name}</b><div className="hint">{s.createdBy}</div></td>
                <td className="mono">{s.url}</td>
                <td>{s.types.length ? s.types.map(x => <span key={x} className="badge">{x}</span>) : <span className="hint">{t('wh.allTypes')}</span>}</td>
                <td>
                  <span className={'lamp ' + (s.enabled ? 'on' : 'off')} />{s.enabled ? t('wh.on') : t('wh.off')}
                  {s.disabledReason && <div className="hint">{s.disabledReason}</div>}
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button onClick={() => test(s)}>{t('wh.test')}</button>{' '}
                  <button onClick={() => setDeliveries(s)}>{t('wh.deliveries')}</button>{' '}
                  <button onClick={() => setEnabled(s, !s.enabled)}>{s.enabled ? t('wh.disable') : t('wh.enable')}</button>{' '}
                  <button className="danger" onClick={() => remove(s)}>{t('wh.delete')}</button>
                </td>
              </tr>
            ))}
            {subs.length === 0 && <tr><td colSpan={5} className="hint">{t('wh.none')}</td></tr>}
          </tbody>
        </table>
      </div>
      <WatchPanel />
      {modal && <SubscriptionModal types={types} onClose={() => setModal(false)}
                                   onCreated={(r) => { setModal(false); setCreated(r); load(); }} />}
      {created && <SecretModal created={created} onClose={() => setCreated(null)} />}
      {deliveries && <DeliveriesModal sub={deliveries} onClose={() => setDeliveries(null)} />}
    </div>
  );
}
