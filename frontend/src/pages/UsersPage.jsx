import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

function UserModal({ initial, roles, onClose, onSaved }) {
  const { user: me } = useAuth();
  const isEdit = Boolean(initial.id);
  const [form, setForm] = useState({
    username: initial.username || '',
    password: '',
    roleType: initial.roleType === 'superadmin' ? 'superadmin' : (initial.roleType || 'custom'),
    roleId: initial.roleId || (roles[0]?._id ?? ''),
    active: initial.active !== false,
  });
  const [error, setError] = useState('');
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const isSuperTarget = initial.roleType === 'superadmin';

  const save = async () => {
    setError('');
    try {
      if (isEdit) {
        const body = { active: form.active };
        if (form.password) body.password = form.password;
        if (!isSuperTarget) {
          body.roleType = form.roleType;
          if (form.roleType === 'custom') body.roleId = form.roleId;
        }
        await api(`/users/${initial.id}`, { method: 'PUT', body });
      } else {
        const body = { username: form.username, password: form.password, roleType: form.roleType };
        if (form.roleType === 'custom') body.roleId = form.roleId;
        await api('/users', { method: 'POST', body });
      }
      onSaved();
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>{isEdit ? `Edit user: ${initial.username}` : 'New user'}</h3>
        {!isEdit && <>
          <label>Username</label>
          <input value={form.username} onChange={e => set('username', e.target.value)} />
        </>}
        <label>{isEdit ? 'New password (empty = keep)' : 'Password'}</label>
        <input type="password" value={form.password} onChange={e => set('password', e.target.value)} />
        {!isSuperTarget && <>
          <label>Role</label>
          <select value={form.roleType} onChange={e => set('roleType', e.target.value)}>
            {me.roleType === 'superadmin' && <option value="admin">Administrator (full access)</option>}
            <option value="custom">Custom role</option>
          </select>
          {form.roleType === 'custom' && (
            <>
              <label>Custom role</label>
              <select value={form.roleId} onChange={e => set('roleId', e.target.value)}>
                {roles.map(r => <option key={r._id} value={r._id}>{r.name}</option>)}
              </select>
              {roles.length === 0 && <div className="hint">No custom roles yet — create one on the Roles page.</div>}
            </>
          )}
          {isEdit && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={form.active}
                     onChange={e => set('active', e.target.checked)} /> Active
            </label>
          )}
        </>}
        {error && <div className="error-box">{error}</div>}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}
                  disabled={(!isEdit && (!form.username || !form.password)) ||
                            (form.roleType === 'custom' && !form.roleId && !isSuperTarget)}>Save</button>
        </div>
      </div>
    </div>
  );
}

export default function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [modal, setModal] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setUsers(await api('/users'));
      setRoles(await api('/roles').catch(() => []));
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const roleName = (u) => {
    if (u.roleType !== 'custom') return u.roleType;
    return roles.find(r => r._id === u.roleId)?.name || 'custom (?)';
  };

  const remove = async (u) => {
    if (!window.confirm(`Delete user "${u.username}"?`)) return;
    try { await api(`/users/${u.id}`, { method: 'DELETE' }); load(); }
    catch (e) { setError(e.message); }
  };

  return (
    <div>
      <h1>Users</h1>
      <div className="sub">Panel accounts. Superadmin is unique and protected; admins have full access; custom roles are granular.</div>
      {error && <div className="error-box">{error}</div>}
      <button className="primary" style={{ marginBottom: 14 }} onClick={() => setModal({})}>+ New user</button>
      <div className="panel">
        <table>
          <thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Created</th><th></th></tr></thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id}>
                <td className="mono"><b>{u.username}</b>{u.id === me.id && <span className="badge" style={{ marginLeft: 6 }}>you</span>}</td>
                <td><span className="badge">{roleName(u)}</span></td>
                <td><span className={'lamp ' + (u.active ? 'on' : 'off')} />{u.active ? 'active' : 'disabled'}</td>
                <td className="hint">{new Date(u.createdAt).toLocaleDateString()}</td>
                <td style={{ textAlign: 'right' }}>
                  <button onClick={() => setModal(u)}>Edit</button>{' '}
                  {u.roleType !== 'superadmin' &&
                    <button className="danger" onClick={() => remove(u)}>Delete</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {modal && <UserModal initial={modal} roles={roles} onClose={() => setModal(null)}
                           onSaved={() => { setModal(null); load(); }} />}
    </div>
  );
}
