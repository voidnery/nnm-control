import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import { useConfirm } from '../confirm.jsx';
import Modal, { backdropClose } from '../components/Modal.jsx';
import Select from '../components/Select.jsx';
import SearchInput from '../components/SearchInput.jsx';

// Object kinds that can be grouped. Endpoint segment -> label key; mirrors the
// tabs a stream can live on.
const KINDS = [
  { value: 'udp', label: 'SRT Out', ep: 'udp', pick: d => d.settings || [] },
  { value: 'outgoing', label: 'SRT in Nimble', ep: 'outgoing', pick: d => d.streams || [] },
  { value: 'incoming', label: 'SRT In', ep: 'incoming', pick: d => d.streams || [] },
  { value: 'livepull', label: 'RTMP Pull', ep: 'livepull', pick: d => d.settings || [] },
  { value: 'republish', label: 'RTMP Push', ep: 'republish', pick: d => d.rules || [] },
  { value: 'hotswap', label: 'Hotswap', ep: 'hotswap', pick: d => d.settings || [] },
];
// The category API speaks the Functions engine's kind names; the proxy uses the
// endpoint segment. They differ for RTMP Pull only.
const apiKind = (k) => (k === 'livepull' ? 'live_pull' : k);
const uiKind = (k) => (k === 'live_pull' ? 'livepull' : k);

const titleOf = (kind, o) => {
  if (kind === 'republish') return `${o.src_app}/${o.src_strm || '*'} → ${o.dest_addr || ''}`;
  if (kind === 'hotswap') return `${o.original_app}/${o.original_stream}`;
  if (o.application) return `${o.application}/${o.stream || ''}`;
  return o.name || String(o.id).slice(-6);
};

function MemberPicker({ servers, onAdd, onClose, existing }) {
  const { t } = useI18n();
  const [serverId, setServerId] = useState('');
  const [kind, setKind] = useState('udp');
  const [objects, setObjects] = useState(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    setError(''); setObjects(null);
    const spec = KINDS.find(k => k.value === kind);
    try {
      const d = await api(`/wmspanel/server/${serverId}/${spec.ep}`);
      setObjects(spec.pick(d));
    } catch (e) { setError(e.message); }
  };

  const shown = (objects || []).filter(o => {
    const label = titleOf(kind, o);
    return !q || label.toLowerCase().includes(q.toLowerCase());
  });

  return (
    <Modal onClose={onClose}>
      <h3>{t('cat.addMembers')}</h3>
      {error && <div className="error-box">{error}</div>}
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label>{t('cat.server')}</label>
          <Select value={serverId} onChange={setServerId} searchable
                  options={[{ value: '', label: '— ' + t('cat.pickServer') + ' —' },
                            ...servers.map(s => ({ value: s.id, label: s.name }))]} />
        </div>
        <div>
          <label>{t('cat.kind')}</label>
          <Select value={kind} onChange={setKind} options={KINDS.map(k => ({ value: k.value, label: k.label }))} />
        </div>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" disabled={!serverId} onClick={load}>{t('cat.loadObjects')}</button>
      </div>

      {objects && (
        <div style={{ marginTop: 10 }}>
          <SearchInput value={q} onChange={setQ} />
          <div className="panel" style={{ maxHeight: 280, overflow: 'auto', marginTop: 6 }}>
            {shown.map(o => {
              const key = `${serverId}:${apiKind(kind)}:${o.id}`;
              const already = existing.has(key);
              return (
                <div key={o.id} className="row" style={{ justifyContent: 'space-between', padding: '3px 4px' }}>
                  <span className="mono" style={{ fontSize: 12 }}>{titleOf(kind, o)}</span>
                  <button disabled={already}
                          onClick={() => onAdd({ serverId, kind: apiKind(kind), objId: String(o.id), title: titleOf(kind, o) })}>
                    {already ? t('cat.added') : t('action.add')}
                  </button>
                </div>
              );
            })}
            {shown.length === 0 && <div className="hint">{t('cat.noObjects')}</div>}
          </div>
        </div>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onClose}>{t('action.close')}</button>
      </div>
    </Modal>
  );
}

export default function CategoriesPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const { push } = useToast();
  const confirm = useConfirm();
  const [cats, setCats] = useState(null);
  const [servers, setServers] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [state, setState] = useState({});
  const [selected, setSelected] = useState([]);
  const [picker, setPicker] = useState(false);
  const [editModal, setEditModal] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const manage = can('category.manage');
  const active = useMemo(() => (cats || []).find(c => c.id === activeId) || null, [cats, activeId]);

  const load = useCallback(async () => {
    try {
      const [list, srv] = await Promise.all([api('/categories'), api('/servers')]);
      setCats(list);
      setServers((srv || []).filter(s => s.wmspanelServerId));
      setActiveId(id => id || list[0]?.id || null);
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const loadState = useCallback(async () => {
    if (!activeId) return;
    try { setState((await api(`/categories/${activeId}/state`)).state || {}); }
    catch (e) { setError(e.message); }
  }, [activeId]);
  useEffect(() => { setSelected([]); loadState(); }, [activeId, loadState]);

  const saveMembers = async (members) => {
    const res = await api(`/categories/${activeId}/members`, { method: 'PUT', body: { members } });
    setCats(cs => cs.map(c => (c.id === res.id ? res : c)));
    loadState();
  };

  const removeMember = async (key) => {
    await saveMembers(active.members.filter(m => m.key !== key).map(({ key: _k, ...m }) => m));
  };

  const runAction = async (action) => {
    const label = t('cat.confirmAction', { action: t('fn.action.' + action), n: selected.length || active.members.length });
    if (!(await confirm({ danger: action !== 'resume', message: label }))) return;
    setBusy(true);
    try {
      const res = await api(`/categories/${activeId}/action`, { method: 'POST', body: { action, keys: selected } });
      push({ type: res.okCount === res.total ? 'ok' : 'error',
             message: t('cat.actionDone', { ok: res.okCount, total: res.total }) });
      const failed = res.results.filter(r => !r.ok);
      if (failed.length) setError(failed.map(f => `${f.title || f.key}: ${f.error}`).join('; '));
      else setError('');
      setTimeout(loadState, 1000);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const createCat = async () => {
    const name = (editModal?.name || '').trim();
    if (!name) return;
    try {
      if (editModal.id) {
        const res = await api(`/categories/${editModal.id}`, { method: 'PUT', body: { name, description: editModal.description } });
        setCats(cs => cs.map(c => (c.id === res.id ? res : c)));
      } else {
        const res = await api('/categories', { method: 'POST', body: { name, description: editModal.description || '' } });
        setCats(cs => [...cs, res]); setActiveId(res.id);
      }
      setEditModal(null); setError('');
    } catch (e) { setError(e.message); }
  };

  const removeCat = async (c) => {
    if (!(await confirm({ danger: true, message: t('cat.confirmDelete', { name: c.name }) }))) return;
    await api(`/categories/${c.id}`, { method: 'DELETE' });
    setCats(cs => cs.filter(x => x.id !== c.id));
    setActiveId(null);
  };

  const existingKeys = useMemo(() => new Set((active?.members || []).map(m => m.key)), [active]);
  const allSelected = active && selected.length === active.members.length && active.members.length > 0;

  return (
    <div>
      <h1>{t('page.categories.title')}</h1>
      <div className="sub">{t('page.categories.sub')}</div>
      {error && <div className="error-box">{error}</div>}

      <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {(cats || []).map(c => (
          <button key={c.id} className={'tagchip' + (c.id === activeId ? ' on' : '')} onClick={() => setActiveId(c.id)}>
            {c.name} <span className="hint">({c.members.length})</span>
          </button>
        ))}
        {manage && <button onClick={() => setEditModal({ name: '', description: '' })}>+ {t('cat.new')}</button>}
      </div>

      {!cats ? <div className="hint">{t('sd.loading')}</div> : !active ? (
        <div className="panel hint">{t('cat.empty')}</div>
      ) : (
        <>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <div>
              <b>{active.name}</b>
              {active.description && <div className="hint">{active.description}</div>}
            </div>
            <div className="row">
              <button onClick={loadState}>{t('action.refresh')}</button>
              {manage && <>
                <button onClick={() => setPicker(true)}>+ {t('cat.addMembers')}</button>
                <button onClick={() => setEditModal(active)}>{t('action.edit')}</button>
                <button className="danger" onClick={() => removeCat(active)}>{t('action.delete')}</button>
              </>}
            </div>
          </div>

          {manage && active.members.length > 0 && (
            <div className="row copybar" style={{ alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <b>{selected.length ? t('copy.selected', { n: selected.length }) : t('cat.allMembers', { n: active.members.length })}</b>
              <button disabled={busy} onClick={() => runAction('resume')}>{t('fn.action.resume')}</button>
              <button disabled={busy} onClick={() => runAction('pause')}>{t('fn.action.pause')}</button>
              <button disabled={busy} onClick={() => runAction('restart')}>{t('fn.action.restart')}</button>
              <button onClick={() => setSelected(allSelected ? [] : active.members.map(m => m.key))}>
                {allSelected ? t('copy.deselectVisible') : t('copy.selectVisible')}
              </button>
            </div>
          )}

          <div className="panel">
            <table>
              <thead><tr>
                <th></th><th>{t('cat.member')}</th><th>{t('cat.server')}</th><th>{t('cat.kind')}</th>
                <th>{t('wo.state')}</th><th></th>
              </tr></thead>
              <tbody>
                {active.members.map(m => {
                  const st = state[m.key] || {};
                  return (
                    <tr key={m.key}>
                      <td>
                        <input type="checkbox" checked={selected.includes(m.key)}
                               onChange={() => setSelected(s => s.includes(m.key) ? s.filter(x => x !== m.key) : [...s, m.key])} />
                      </td>
                      <td className="mono">{m.title || m.objId}</td>
                      <td className="hint">{st.serverName || m.serverId.slice(-6)}</td>
                      <td><span className="badge">{KINDS.find(k => k.value === uiKind(m.kind))?.label || m.kind}</span></td>
                      <td>
                        {st.error ? <span className="hint">⚠ {st.error}</span>
                          : st.found === false ? <span className="hint">{t('cat.gone')}</span>
                          : st.found ? <><span className={'lamp ' + (st.paused ? 'off' : 'on')} />{st.paused ? t('cat.stopped') : t('cat.running')}</>
                          : <span className="hint">…</span>}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {manage && <button className="danger" onClick={() => removeMember(m.key)}>{t('cat.removeMember')}</button>}
                      </td>
                    </tr>
                  );
                })}
                {active.members.length === 0 && (
                  <tr><td colSpan={6} className="hint">{t('cat.noMembers')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {picker && (
        <MemberPicker servers={servers} existing={existingKeys} onClose={() => setPicker(false)}
                      onAdd={(m) => saveMembers([...active.members.map(({ key: _k, ...x }) => x), m])} />
      )}

      {editModal && (
        <div className="modal-back" {...backdropClose(() => setEditModal(null))}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{editModal.id ? t('cat.edit') : t('cat.new')}</h3>
            <label>{t('cat.name')}</label>
            <input value={editModal.name} onChange={e => setEditModal(m => ({ ...m, name: e.target.value }))} />
            <label>{t('cat.description')}</label>
            <input value={editModal.description || ''} onChange={e => setEditModal(m => ({ ...m, description: e.target.value }))} />
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button onClick={() => setEditModal(null)}>{t('action.cancel')}</button>
              <button className="primary" disabled={!editModal.name?.trim()} onClick={createCat}>{t('action.save')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
