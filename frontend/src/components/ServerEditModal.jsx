import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import Modal from './Modal.jsx';

// Edits the WMSPanel "Server" object (tag: Server) for a mapped server:
// display name, custom IPs/domains, and WMSPanel tags. Applies on the next
// WMSPanel sync. This is distinct from the panel's own server record.
export default function ServerEditModal({ serverId, onClose, onSaved }) {
  const { t } = useI18n();
  const { push } = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [ips, setIps] = useState([]);         // custom_ips (editable list)
  const [tags, setTags] = useState('');       // comma-separated in the UI
  const [readonly, setReadonly] = useState({ ip: [], status: '', kind: '' });

  useEffect(() => {
    let alive = true;
    api(`/wmspanel/server/${serverId}/wmsinfo`)
      .then(d => {
        if (!alive) return;
        const sv = d.server || d;
        setName(sv.name || '');
        setIps(Array.isArray(sv.custom_ips) ? sv.custom_ips : []);
        setTags((sv.tags || []).join(', '));
        setReadonly({ ip: sv.ip || [], status: sv.status || '', kind: sv.kind || '' });
      })
      .catch(e => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [serverId]);

  const save = async () => {
    setBusy(true); setError('');
    try {
      await api(`/wmspanel/server/${serverId}/wmsinfo`, {
        method: 'PUT',
        body: {
          name: name.trim(),
          custom_ips: ips.map(x => x.trim()).filter(Boolean),
          tags: tags.split(',').map(x => x.trim()).filter(Boolean),
        },
      });
      push({ type: 'ok', message: t('srv.saved') });
      onSaved?.();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose}>
      <h3>{t('srv.editTitle')}</h3>
      <div className="hint" style={{ marginBottom: 10 }}>{t('srv.editHint')}</div>
      {error && <div className="error-box">{error}</div>}
      {loading ? <div className="hint">Loading…</div> : (
        <div>
          <div style={{ marginBottom: 10 }}>
            <label>{t('srv.name')}</label>
            <input value={name} onChange={e => setName(e.target.value)} />
          </div>

          <div style={{ marginBottom: 10 }}>
            <label>{t('srv.customIps')}</label>
            <div className="hint" style={{ marginBottom: 4 }}>{t('srv.customIpsHint')}</div>
            {ips.map((ip, i) => (
              <div className="row" key={i} style={{ marginBottom: 4 }}>
                <input className="mono" style={{ flex: 1 }} value={ip}
                       onChange={e => setIps(ips.map((x, j) => j === i ? e.target.value : x))}
                       placeholder="198.51.100.10 or host.example.com" />
                <button className="danger" onClick={() => setIps(ips.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <button onClick={() => setIps([...ips, ''])}>+ {t('srv.addIp')}</button>
          </div>

          <div style={{ marginBottom: 10 }}>
            <label>{t('srv.tags')}</label>
            <input value={tags} onChange={e => setTags(e.target.value)} placeholder="edge, moscow" />
          </div>

          <div className="kv-grid" style={{ marginTop: 8 }}>
            <div className="kv-k">{t('srv.reportedIps')}</div><div className="kv-v mono">{(readonly.ip || []).join(', ') || '—'}</div>
            <div className="kv-k">{t('srv.status')}</div><div className="kv-v">{readonly.status || '—'}</div>
            <div className="kv-k">{t('srv.kind')}</div><div className="kv-v">{readonly.kind || '—'}</div>
          </div>

          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button onClick={onClose}>{t('action.cancel')}</button>
            <button className="primary" disabled={busy || !name.trim()} onClick={save}>{t('action.save')}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
