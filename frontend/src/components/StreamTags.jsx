import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';

// Panel-side stream tags. One hook per server loads the tag map + catalog and
// carries the filter state (selected tags + AND/OR mode). Assigning tags is a
// panel-only write, so streams are never reloaded.
export function useStreamTags(serverId) {
  const [map, setMap] = useState({});           // "kind:objId" -> tags[]
  const [catalog, setCatalog] = useState([]);   // distinct tags on this server
  const [selected, setSelected] = useState([]); // active filter tags
  const [mode, setMode] = useState('or');        // 'or' | 'and'

  const load = useCallback(() => {
    if (!serverId) return;
    api(`/stream-tags/${serverId}`)
      .then(d => { setMap(d.map || {}); setCatalog(d.catalog || []); })
      .catch(() => {});
  }, [serverId]);
  useEffect(() => { load(); }, [load]);

  const getTags = useCallback((kind, objId) => map[`${kind}:${objId}`] || [], [map]);

  const setTags = useCallback(async (kind, objId, tags) => {
    const key = `${kind}:${objId}`;
    setMap(m => ({ ...m, [key]: tags }));            // optimistic
    const res = await api(`/stream-tags/${serverId}/${kind}/${objId}`, { method: 'PUT', body: { tags } });
    setMap(m => ({ ...m, [key]: res.tags }));
    // refresh catalog (a new tag may have appeared / an old one vanished)
    setCatalog(prev => {
      const all = new Set(prev);
      res.tags.forEach(t => all.add(t));
      return Array.from(all).sort((a, b) => a.localeCompare(b));
    });
    return res.tags;
  }, [serverId]);

  const toggleFilter = useCallback((tag) => {
    setSelected(sel => sel.includes(tag) ? sel.filter(t => t !== tag) : [...sel, tag]);
  }, []);

  const matches = useCallback((kind, objId) => {
    if (selected.length === 0) return true;
    const tset = new Set(getTags(kind, objId));
    return mode === 'and' ? selected.every(t => tset.has(t)) : selected.some(t => tset.has(t));
  }, [selected, mode, getTags]);

  return { map, catalog, selected, mode, setMode, toggleFilter, setSelected, getTags, setTags, matches, reload: load };
}

// Filter bar: catalog chips as toggles + AND/OR switch. Renders nothing until
// at least one tag exists on the server.
export function TagFilterBar({ st }) {
  const { t } = useI18n();
  if (!st.catalog.length) return null;
  return (
    <div className="row" style={{ flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 10 }}>
      <span className="hint" style={{ marginRight: 2 }}>{t('tag.filter')}:</span>
      {st.catalog.map(tag => (
        <button key={tag} className={'tagchip' + (st.selected.includes(tag) ? ' on' : '')}
                onClick={() => st.toggleFilter(tag)}>{tag}</button>
      ))}
      {st.selected.length > 0 && <>
        <span className="tag-modeswitch">
          <button className={st.mode === 'or' ? 'on' : ''} onClick={() => st.setMode('or')} title={t('tag.orHint')}>{t('tag.or')}</button>
          <button className={st.mode === 'and' ? 'on' : ''} onClick={() => st.setMode('and')} title={t('tag.andHint')}>{t('tag.and')}</button>
        </span>
        <button className="linklike" onClick={() => st.setSelected([])}>{t('tag.clear')}</button>
      </>}
    </div>
  );
}

// Inline chips + editor for one object. Editing is gated by wmsobjects.manage.
export function TagChips({ st, kind, objId }) {
  const { can } = useAuth();
  const { t } = useI18n();
  const { push } = useToast();
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const tags = st.getTags(kind, objId);
  const editable = can('wmsobjects.manage');
  const listId = `tagcat-${kind}`;

  const commit = async (next) => {
    try { await st.setTags(kind, objId, next); }
    catch (e) { push({ type: 'error', message: e.message }); }
  };
  const add = async () => {
    const v = input.trim();
    if (!v || tags.includes(v)) { setInput(''); return; }
    setInput('');
    await commit([...tags, v]);
  };
  const remove = (tag) => commit(tags.filter(x => x !== tag));

  return (
    <span className="tagcell">
      {tags.map(tag => (
        <span key={tag} className="tagchip static">
          {tag}{editing && editable && <button className="x" onClick={() => remove(tag)} title={t('tag.remove')}>×</button>}
        </span>
      ))}
      {!tags.length && !editing && <span className="hint" style={{ fontSize: 12 }}>—</span>}
      {editable && (editing ? (
        <>
          <input className="tag-input" value={input} list={listId} autoFocus
                 onChange={e => setInput(e.target.value)}
                 onKeyDown={e => { if (e.key === 'Enter') add(); if (e.key === 'Escape') setEditing(false); }}
                 placeholder={t('tag.addPlaceholder')} />
          <datalist id={listId}>{st.catalog.map(c => <option key={c} value={c} />)}</datalist>
          <button className="tag-btn" onClick={add}>+</button>
          <button className="tag-btn" onClick={() => setEditing(false)}>{t('action.done')}</button>
        </>
      ) : (
        <button className="tag-btn ghost" onClick={() => setEditing(true)} title={t('tag.edit')}>🏷</button>
      ))}
    </span>
  );
}
