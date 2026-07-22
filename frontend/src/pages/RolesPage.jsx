import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { backdropClose } from '../components/Modal.jsx';
import { useI18n } from '../i18n.jsx';
import { useConfirm } from '../confirm.jsx';

function RoleModal({ initial, catalog, functions, onClose, onSaved }) {
  const isEdit = Boolean(initial._id);
  const [name, setName] = useState(initial.name || '');
  const [description, setDescription] = useState(initial.description || '');
  const [perms, setPerms] = useState(new Set(initial.permissions || []));
  const [fnIds, setFnIds] = useState(new Set((initial.functionIds || []).map(String)));
  const [error, setError] = useState('');
  const toggleFn = (id) => setFnIds(p => {
    const next = new Set(p);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggle = (key) => setPerms(p => {
    const next = new Set(p);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const save = async () => {
    setError('');
    try {
      const body = { name, description, permissions: [...perms], functionIds: [...fnIds] };
      if (isEdit) await api(`/roles/${initial._id}`, { method: 'PUT', body });
      else await api('/roles', { method: 'POST', body });
      onSaved();
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="modal-back" {...backdropClose(onClose)}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>{isEdit ? 'Edit role' : 'New custom role'}</h3>
        <label>Name</label>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Stream operator" />
        <label>Description</label>
        <input value={description} onChange={e => setDescription(e.target.value)} />
        <label>Permissions</label>
        <div className="perm-grid">
          {catalog.map(p => (
            <label key={p.key}>
              <input type="checkbox" checked={perms.has(p.key)} onChange={() => toggle(p.key)} />
              <span>{p.label}</span>
            </label>
          ))}
        </div>
        {perms.has('functions.execute') && (
          <>
            <label>Allowed functions (for functions.execute)</label>
            <div className="perm-grid">
              {functions.map(f => (
                <label key={f._id}>
                  <input type="checkbox" checked={fnIds.has(String(f._id))} onChange={() => toggleFn(String(f._id))} />
                  <span>{f.name}</span>
                </label>
              ))}
              {functions.length === 0 && <span className="hint">No functions defined yet.</span>}
            </div>
          </>
        )}
        {error && <div className="error-box">{error}</div>}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!name} onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

export default function RolesPage() {
  const confirm = useConfirm();
  const { t } = useI18n();
  const [roles, setRoles] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [functions, setFunctions] = useState([]);
  const [modal, setModal] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setRoles(await api('/roles'));
      setCatalog(await api('/roles/permissions/catalog'));
      setFunctions(await api('/functions').catch(() => []));
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const remove = async (r) => {
    if (!(await confirm(`Delete role "${r.name}"?`))) return;
    try { await api(`/roles/${r._id}`, { method: 'DELETE' }); load(); }
    catch (e) { setError(e.message); }
  };

  return (
    <div>
      <h1>{t('page.roles.title')}</h1>
      <div className="sub">{t('page.roles.sub')}</div>
      {error && <div className="error-box">{error}</div>}
      <button className="primary" style={{ marginBottom: 14 }} onClick={() => setModal({})}>+ New role</button>
      <div className="panel">
        <table>
          <thead><tr><th>Name</th><th>Description</th><th>Permissions</th><th></th></tr></thead>
          <tbody>
            {roles.map(r => (
              <tr key={r._id}>
                <td><b>{r.name}</b></td>
                <td className="hint">{r.description}</td>
                <td>{r.permissions.map(p => <span key={p} className="badge" style={{ margin: '1px 3px 1px 0' }}>{p}</span>)}</td>
                <td style={{ textAlign: 'right' }}>
                  <button onClick={() => setModal(r)}>Edit</button>{' '}
                  <button className="danger" onClick={() => remove(r)}>Delete</button>
                </td>
              </tr>
            ))}
            {roles.length === 0 && <tr><td colSpan={4} className="hint">No custom roles yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && <RoleModal initial={modal} catalog={catalog} functions={functions} onClose={() => setModal(null)}
                           onSaved={() => { setModal(null); load(); }} />}
    </div>
  );
}
