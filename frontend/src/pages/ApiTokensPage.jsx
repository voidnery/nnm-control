import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { backdropClose } from '../components/Modal.jsx';
import { useI18n } from '../i18n.jsx';
import { useConfirm } from '../confirm.jsx';
import { copyText } from '../lib/clipboard.js';

// API tokens for /api/v1 (docs/api/PROPOSAL-nnm-api-1.md §2.2). A token is shown once — in the dialog
// right after it is issued — and the panel never holds it again, only its hash. A token can be given
// only rights its issuer has, and never the right to make rights (the backend refuses those too).
const NEVER_FOR_TOKENS = ['users.manage', 'roles.manage', 'apitokens.manage', 'webhooks.manage'];

function TokenModal({ catalog, onClose, onIssued }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const [name, setName] = useState('');
  const [perms, setPerms] = useState(new Set());
  const [cidrs, setCidrs] = useState('');
  const [days, setDays] = useState('');
  const [error, setError] = useState('');
  const offer = catalog.filter(p => !NEVER_FOR_TOKENS.includes(p.key) && can(p.key));
  const toggle = (k) => setPerms(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const issue = async () => {
    setError('');
    try {
      const body = {
        name, permissions: [...perms],
        allowCidrs: cidrs.split(/[\s,]+/).filter(Boolean),
        expiresInDays: days === '' ? null : Number(days),
      };
      onIssued(await api('/api-tokens', { method: 'POST', body }));
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="modal-back" {...backdropClose(onClose)}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>{t('tok.new')}</h3>
        <label>{t('tok.name')}</label>
        <input value={name} onChange={e => setName(e.target.value)} placeholder={t('tok.namePh')} />
        <label>{t('tok.permissions')}</label>
        <div className="perm-grid">
          {offer.map(p => (
            <label key={p.key}>
              <input type="checkbox" checked={perms.has(p.key)} onChange={() => toggle(p.key)} />
              <span>{p.label}</span>
            </label>
          ))}
        </div>
        <label>{t('tok.cidrs')}</label>
        <input className="mono" value={cidrs} onChange={e => setCidrs(e.target.value)} placeholder="10.0.0.0/8, 192.0.2.7" />
        <label>{t('tok.days')}</label>
        <input value={days} onChange={e => setDays(e.target.value.replace(/\D/g, ''))} placeholder={t('tok.daysPh')} />
        {error && <div className="error-box">{error}</div>}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>{t('action.cancel')}</button>
          <button className="primary" onClick={issue} disabled={!name.trim() || perms.size === 0}>{t('tok.issue')}</button>
        </div>
      </div>
    </div>
  );
}

function IssuedModal({ issued, onClose }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="modal-back" {...backdropClose(onClose)}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>{t('tok.issuedTitle', { name: issued.name })}</h3>
        <div className="hint">{t('tok.onlyOnce')}</div>
        <input className="mono" readOnly value={issued.token} onFocus={e => e.target.select()} />
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={async () => setCopied(await copyText(issued.token))}>{copied ? t('tok.copied') : t('tok.copy')}</button>
          <button className="primary" onClick={onClose}>{t('action.close')}</button>
        </div>
      </div>
    </div>
  );
}

export default function ApiTokensPage() {
  const confirm = useConfirm();
  const { t } = useI18n();
  const [tokens, setTokens] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [modal, setModal] = useState(false);
  const [issued, setIssued] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      // Lists only: anything else (an error page, a proxy's HTML) must not take the page down.
      const list = await api('/api-tokens');
      setTokens(Array.isArray(list) ? list : []);
      const cat = await api('/roles/permissions/catalog').catch(() => []);
      setCatalog(Array.isArray(cat) ? cat : []);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const revoke = async (tk) => {
    if (!(await confirm(t('tok.confirmRevoke', { name: tk.name })))) return;
    try { await api(`/api-tokens/${tk.id}/revoke`, { method: 'POST' }); load(); }
    catch (e) { setError(e.message); }
  };
  const when = (d) => (d ? new Date(d).toLocaleString() : '—');

  return (
    <div>
      <h1>{t('page.tokens.title')}</h1>
      <div className="sub">{t('page.tokens.sub')}</div>
      {error && <div className="error-box">{error}</div>}
      <button className="primary" style={{ marginBottom: 14 }} onClick={() => setModal(true)}>+ {t('tok.new')}</button>
      <div className="panel">
        <table>
          <thead><tr>
            <th>{t('tok.name')}</th><th>{t('tok.prefix')}</th><th>{t('tok.permissions')}</th>
            <th>{t('tok.lastUsed')}</th><th>{t('tok.expires')}</th><th></th>
          </tr></thead>
          <tbody>
            {tokens.map(tk => (
              <tr key={tk.id}>
                <td><b>{tk.name}</b><div className="hint">{tk.createdBy}</div></td>
                <td className="mono">{tk.prefix}</td>
                <td>{tk.permissions.map(p => <span key={p} className="badge">{p}</span>)}</td>
                <td className="hint">{when(tk.lastUsedAt)}{tk.lastUsedIp ? ` · ${tk.lastUsedIp}` : ''}</td>
                <td className="hint">{tk.revokedAt ? t('tok.revoked') : when(tk.expiresAt)}</td>
                <td style={{ textAlign: 'right' }}>
                  {!tk.revokedAt && <button className="danger" onClick={() => revoke(tk)}>{t('tok.revoke')}</button>}
                </td>
              </tr>
            ))}
            {tokens.length === 0 && <tr><td colSpan={6} className="hint">{t('tok.none')}</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && <TokenModal catalog={catalog} onClose={() => setModal(false)}
                            onIssued={(r) => { setModal(false); setIssued(r); load(); }} />}
      {issued && <IssuedModal issued={issued} onClose={() => setIssued(null)} />}
    </div>
  );
}
