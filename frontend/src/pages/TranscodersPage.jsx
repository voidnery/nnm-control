import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { backdropClose } from '../components/Modal.jsx';
import Select from '../components/Select.jsx';
import { useI18n } from '../i18n.jsx';
import { useConfirm } from '../confirm.jsx';
import Modal from '../components/Modal.jsx';
import PipelineEditor from '../components/PipelineEditor.jsx';
import SearchInput from '../components/SearchInput.jsx';

// Transcoders are account-level in WMSPanel; server_id is an attribute.
// Scope here: list + pause/resume/clone + raw details; licenses with expiry
// warnings. Pipeline editing is a later step (schemas land from live use).
export default function TranscodersPage() {
  const confirm = useConfirm();
  const { t } = useI18n();
  const tt = t; // i18n alias usable inside the `t`(transcoder) map scope
  const { can } = useAuth();
  const [transcoders, setTranscoders] = useState(null);
  const [licenses, setLicenses] = useState([]);
  const [servers, setServers] = useState([]);
  const [filter, setFilter] = useState('');
  const [serverFilter, setServerFilter] = useState('');
  const [detail, setDetail] = useState(null);
  const [editModal, setEditModal] = useState(null);
  const [pipeModal, setPipeModal] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError('');
    try {
      const [t, l, s] = await Promise.all([
        api('/wmspanel/transcoders'),
        api('/wmspanel/transcoders/licenses').catch(() => ({ licenses: [] })),
        api('/servers').catch(() => []),
      ]);
      setTranscoders(t.transcoders || []);
      setLicenses(l.licenses || []);
      setServers(s);
    } catch (e) { setError(e.message); setTranscoders([]); }
  };
  useEffect(() => { load(); }, []);

  const serverName = (wsid) => servers.find(s => s.wmspanelServerId === wsid)?.name || String(wsid || '').slice(-6);

  const act = async (t, action) => {
    if (action === 'clone' && !(await confirm(tt('tcp.confirmClone', { name: t.name })))) return;
    setBusy(true); setError('');
    try { await api(`/wmspanel/transcoders/${t.id}/${action}`, { method: 'POST' }); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const openDetail = async (t) => {
    setDetail({ loading: true, name: t.name });
    try { setDetail({ name: t.name, data: await api(`/wmspanel/transcoders/${t.id}`) }); }
    catch (e) { setDetail({ name: t.name, error: e.message }); }
  };

  const daysLeft = (expire) => Math.floor((new Date(expire) - Date.now()) / 86400000);

  if (!transcoders) return <div className="hint">{t('tcp.loading')}</div>;
  const q = filter.trim().toLowerCase();
  const list = transcoders.filter(t =>
    (!q || (t.name + ' ' + (t.description || '') + ' ' + (t.tags || []).join(' ')).toLowerCase().includes(q)) &&
    (!serverFilter || t.server_id === serverFilter));
  const usedServerIds = [...new Set(transcoders.map(t => t.server_id).filter(Boolean))];

  return (
    <div>
      <h1>{t('page.transcoders.title')}</h1>
      <div className="sub">{t('page.transcoders.sub')}</div>
      {error && <div className="error-box">{error}</div>}
      <div className="row" style={{ marginBottom: 12 }}>
        <SearchInput style={{ maxWidth: 260 }} placeholder={t('tcp.filter')} value={filter} onChange={setFilter} />
        <div style={{ maxWidth: 240 }}>
          <Select value={serverFilter} onChange={setServerFilter}
                  options={[{ value: '', label: t('tcp.allServers') }, ...usedServerIds.map(id => ({ value: id, label: serverName(id) }))]} />
        </div>
        <button onClick={load} disabled={busy}>{t('action.refresh')}</button>
        <span className="hint">{list.length} of {transcoders.length}</span>
      </div>
      <div className="panel">
        <table>
          <thead><tr><th>{t('tcp.name')}</th><th>{t('tcp.server')}</th><th>{t('tcp.tags')}</th><th>{t('tcp.state')}</th><th></th></tr></thead>
          <tbody>
            {list.map(t => (
              <tr key={t.id}>
                <td><b>{t.name}</b>{t.description && <div className="hint">{t.description}</div>}</td>
                <td className="mono">{serverName(t.server_id)}</td>
                <td>{(t.tags || []).map(x => <span key={x} className="badge" style={{ marginRight: 3 }}>{x}</span>)}</td>
                <td><span className={'lamp ' + (t.paused ? 'off' : 'on')} />{t.paused ? 'paused' : 'running'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button onClick={() => openDetail(t)}>{tt('action.details')}</button>{' '}
                    <button onClick={() => setPipeModal({ id: t.id, name: t.name })}>{tt('tc.pipelines')}</button>{' '}
                  {can('wmsobjects.manage') && <>
                    {t.paused
                      ? <button className="primary" disabled={busy} onClick={() => act(t, 'resume')}>{tt('action.resume')}</button>
                      : <button disabled={busy} onClick={() => act(t, 'pause')}>{tt('action.pause')}</button>}{' '}
                    <button disabled={busy} onClick={() => act(t, 'clone')}>{tt('action.clone')}</button>{' '}
                    <button disabled={busy} onClick={() => setEditModal({ id: t.id, name: t.name, description: t.description || '', tags: (t.tags || []).join(',') })}>{tt('action.edit')}</button>{' '}
                    <button className="danger" disabled={busy} onClick={async () => {
                      if (!(await confirm(tt('tcp.confirmDelete', { name: t.name })))) return;
                      setBusy(true); setError('');
                      try { await api(`/wmspanel/transcoders/${t.id}`, { method: 'DELETE' }); await load(); }
                      catch (e) { setError(e.message); }
                      finally { setBusy(false); }
                    }}>{tt('action.delete')}</button>
                  </>}
                </td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={5} className="hint">{t('tcp.noMatch')}</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>{t('tcp.licenses')}</h2>
        <table>
          <thead><tr><th>{t('tcp.server')}</th><th>{t('tcp.status')}</th><th>{t('tcp.started')}</th><th>{t('tcp.expires')}</th><th></th></tr></thead>
          <tbody>
            {licenses.map((l, i) => {
              const dl = daysLeft(l.expire);
              return (
                <tr key={i}>
                  <td>{l.server || '—'}</td>
                  <td><span className={'lamp ' + (l.status === 'Active' ? 'on' : 'off')} />{l.status}</td>
                  <td className="hint">{l.started}</td>
                  <td className="mono">{l.expire}</td>
                  <td>{dl <= 30 && dl >= 0 && <span className="badge" style={{ background: '#5c4a2a', color: '#e8d5a8' }}>expires in {dl}d</span>}
                      {dl < 0 && <span className="badge" style={{ background: '#4a2020', color: '#e8a8a8' }}>{t('tcp.expired')}</span>}</td>
                </tr>
              );
            })}
            {licenses.length === 0 && <tr><td colSpan={5} className="hint">{t('tcp.noLicenses')}</td></tr>}
          </tbody>
        </table>
      </div>

      {editModal && (
        <div className="modal-back" {...backdropClose(() => setEditModal(null))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{t('tcp.editTranscoder')}</h3>
            <label>{t('tcp.name')}</label>
            <input value={editModal.name} onChange={e => setEditModal(m => ({ ...m, name: e.target.value }))} />
            <label>{t('tcp.description')}</label>
            <input value={editModal.description} onChange={e => setEditModal(m => ({ ...m, description: e.target.value }))} />
            <label>{t('tcp.tagsComma')}</label>
            <input value={editModal.tags} onChange={e => setEditModal(m => ({ ...m, tags: e.target.value }))} />
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setEditModal(null)}>{t('action.cancel')}</button>
              <button className="primary" disabled={busy || !editModal.name} onClick={async () => {
                setBusy(true); setError('');
                try {
                  await api(`/wmspanel/transcoders/${editModal.id}`, { method: 'PUT', body: {
                    name: editModal.name, description: editModal.description,
                    tags: editModal.tags.split(',').map(x => x.trim()).filter(Boolean),
                  } });
                  setEditModal(null); await load();
                } catch (e) { setError(e.message); }
                finally { setBusy(false); }
              }}>{t('action.apply')}</button>
            </div>
          </div>
        </div>
      )}
      {detail && (
        <div className="modal-back" {...backdropClose(() => setDetail(null))}>
          <div className="modal" style={{ width: 700 }} onClick={e => e.stopPropagation()}>
            <h3>{detail.name}</h3>
            {detail.loading && <div className="hint">{t('tcp.loading')}</div>}
            {detail.error && <div className="error-box">{detail.error}</div>}
            {detail.data && (() => {
              const tr = detail.data.transcoder || detail.data;
              const pipelines = tr.pipelines || tr.pipeline || [];
              return (
                <div>
                  <div className="kv-grid">
                    <div className="kv-k">{tt('tcp.name')}</div><div className="kv-v mono">{tr.name || '—'}</div>
                    <div className="kv-k">{tt('tcp.description')}</div><div className="kv-v">{tr.description || <span className="hint">—</span>}</div>
                    <div className="kv-k">{tt('tcp.server')}</div><div className="kv-v mono">{serverName(tr.server_id)}</div>
                    <div className="kv-k">{tt('tcp.state')}</div><div className="kv-v"><span className={'lamp ' + (tr.paused ? 'off' : 'on')} />{tr.paused ? 'paused' : 'running'}</div>
                    <div className="kv-k">{tt('tcp.tags')}</div><div className="kv-v">{(tr.tags || []).map(x => <span key={x} className="badge" style={{ marginRight: 3 }}>{x}</span>) || '—'}</div>
                    {tr.id && <><div className="kv-k">ID</div><div className="kv-v mono hint">{tr.id}</div></>}
                  </div>
                  {Array.isArray(pipelines) && pipelines.length > 0 && (
                    <>
                      <h4 style={{ margin: '14px 0 6px' }}>Pipelines ({pipelines.length})</h4>
                      {pipelines.map((pl, i) => (
                        <div key={i} className="panel" style={{ padding: 10, marginBottom: 6 }}>
                          <div className="kv-grid">
                            {Object.entries(pl).map(([k, v]) => (
                              <div key={k} style={{ display: 'contents' }}>
                                <div className="kv-k">{k}</div>
                                <div className="kv-v mono">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              );
            })()}
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setDetail(null)}>{t('action.close')}</button>
            </div>
          </div>
        </div>
      )}
    {pipeModal && (
        <Modal onClose={() => setPipeModal(null)} size="xwide">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>{tt('tc.pipelines')} — {pipeModal.name}</h3>
            <button onClick={() => setPipeModal(null)}>{tt('action.close')}</button>
          </div>
          <div style={{ maxHeight: '78vh', overflow: 'auto', marginTop: 10 }}>
            <PipelineEditor transcoderId={pipeModal.id} onClose={() => setPipeModal(null)} />
          </div>
        </Modal>
      )}
    </div>
  );
}
