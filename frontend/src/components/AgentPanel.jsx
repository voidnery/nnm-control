import { useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import Modal from './Modal.jsx';
import Select from './Select.jsx';

// Deploying a playlist to a server through its file agent.
//
// The agent SETUP UI used to live here too, behind a button on the Playlists
// page. It moved to its own section in iter10 (pages/ServerAgentsPage.jsx):
// an agent is server infrastructure — a per-server token, config writes, and
// since m1 the log source the collector tails — not a playlist feature.
// Deploying a playlist through one genuinely is a playlist action, so that
// stayed here.

export function DeployPlaylistModal({ playlist, servers, onClose }) {
  const { t } = useI18n();
  const { push } = useToast();
  const [serverId, setServerId] = useState('');
  const [filename, setFilename] = useState('playlist.json');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const deploy = async () => {
    setBusy(true); setError('');
    try {
      setResult(await api(`/servers/${serverId}/agent/deploy-playlist`, {
        method: 'POST', body: { playlistId: playlist.id, filename },
      }));
      push({ type: 'ok', message: t('agent.deployed') });
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose}>
      <h3>{t('agent.deployTitle', { name: playlist.name })}</h3>
      {error && <div className="error-box">{error}</div>}
      <label>{t('cat.server')}</label>
      <Select value={serverId} onChange={setServerId} searchable
              options={[{ value: '', label: '— ' + t('cat.pickServer') + ' —' },
                        ...servers.map(s => ({ value: s.id, label: s.name }))]} />
      <label>{t('agent.filename')}</label>
      <input className="mono" value={filename} onChange={e => setFilename(e.target.value)} />
      <div className="hint" style={{ marginTop: 6 }}>{t('agent.deployHint')}</div>
      {result && (
        <div className="picked-row" style={{ marginTop: 10 }}>
          <span className="picked-tag">OK</span>
          <b className="mono picked-val">{result.name} · {result.size} B</b>
        </div>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onClose}>{t('action.close')}</button>
        <button className="primary" disabled={busy || !serverId || !filename.trim()} onClick={deploy}>
          {busy ? '…' : t('agent.deploy')}
        </button>
      </div>
    </Modal>
  );
}
