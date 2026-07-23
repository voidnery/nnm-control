import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';

// Panel-side stream tags. Tags are stored per (serverId, kind, objId), so the
// tag vocabulary is scoped to ONE tab: tags created on RTMP Pull are not
// offered on RTMP Push. The hook therefore takes the kind and derives its
// catalog from the tags actually in use for that kind on this server.
export function useStreamTags(serverId, kind) {
  const [map, setMap] = useState({});            // "kind:objId" -> tags[]
  const [selected, setSelected] = useState([]);  // active filter tags
  const [mode, setMode] = useState('or');         // 'or' | 'and'

  const load = useCallback(() => {
    if (!serverId) return;
    api(`/stream-tags/${serverId}`)
      .then(d => setMap(d.map || {}))
      .catch(() => {});
  }, [serverId]);
  useEffect(() => { load(); }, [load]);

  // Catalog = distinct tags used by objects of THIS kind on THIS server.
  const catalog = useMemo(() => {
    const set = new Set();
    const prefix = `${kind}:`;
    for (const [key, tags] of Object.entries(map)) {
      if (key.startsWith(prefix)) (tags || []).forEach(t => set.add(t));
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [map, kind]);

  const getTags = useCallback((k, objId) => map[`${k}:${objId}`] || [], [map]);

  const setTags = useCallback(async (k, objId, tags) => {
    const key = `${k}:${objId}`;
    const prev = map[key];
    setMap(m => ({ ...m, [key]: tags }));          // optimistic
    try {
      const res = await api(`/stream-tags/${serverId}/${k}/${objId}`, { method: 'PUT', body: { tags } });
      setMap(m => ({ ...m, [key]: res.tags }));
      return res.tags;
    } catch (e) {
      setMap(m => ({ ...m, [key]: prev || [] }));  // roll back on failure
      throw e;
    }
  }, [serverId, map]);

  const toggleFilter = useCallback((tag) => {
    setSelected(sel => sel.includes(tag) ? sel.filter(t => t !== tag) : [...sel, tag]);
  }, []);

  // Drop filter chips that no longer exist in this tab's catalog.
  useEffect(() => {
    setSelected(sel => sel.filter(t => catalog.includes(t)));
  }, [catalog]);

  const matches = useCallback((k, objId) => {
    if (selected.length === 0) return true;
    const tset = new Set(getTags(k, objId));
    return mode === 'and' ? selected.every(t => tset.has(t)) : selected.some(t => tset.has(t));
  }, [selected, mode, getTags]);

  return { kind, map, catalog, selected, mode, setMode, toggleFilter, setSelected, getTags, setTags, matches, reload: load };
}

// Shared popover positioning: fixed + portal so no scroll container can clip it.
function usePopover(open) {
  const anchor = useRef(null);
  const pop = useRef(null);
  const [pos, setPos] = useState(null);
  const measure = useCallback(() => {
    const el = anchor.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 4;
    const below = window.innerHeight - r.bottom - gap - 8;
    const above = r.top - gap - 8;
    const up = below < 160 && above > below;
    setPos({
      left: r.left, width: Math.max(r.width, 170), top: up ? r.top - gap : r.bottom + gap,
      maxHeight: Math.max(110, Math.min(240, up ? above : below)), up,
    });
  }, []);
  useLayoutEffect(() => { if (open) measure(); }, [open, measure]);
  useEffect(() => {
    if (!open) return;
    const onMove = () => measure();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, measure]);
  return { anchor, pop, pos };
}

// Filter bar: catalog chips as toggles + AND/OR mode switch.
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

// Themed tag entry: input + our own dropdown of this tab's existing tags
// (native <datalist> can't be styled and looked foreign).
function TagCombo({ st, existing, onAdd, onClose }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(true);
  const { anchor, pop, pos } = usePopover(open);

  const suggestions = useMemo(() => {
    const avail = st.catalog.filter(c => !existing.includes(c));
    const needle = q.trim().toLowerCase();
    return needle ? avail.filter(c => c.toLowerCase().includes(needle)) : avail;
  }, [st.catalog, existing, q]);

  const value = q.trim();
  const canCreate = value && !st.catalog.includes(value) && !existing.includes(value);

  useEffect(() => {
    const onDoc = (e) => {
      if (anchor.current?.contains(e.target) || pop.current?.contains(e.target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose, anchor, pop]);

  const commit = (tag) => { onAdd(tag); setQ(''); setOpen(true); };

  return (
    <span className="tagcombo" ref={anchor}>
      <input className="tag-input" autoFocus value={q}
             placeholder={t('tag.addPlaceholder')}
             onChange={e => { setQ(e.target.value); setOpen(true); }}
             onFocus={() => setOpen(true)}
             onKeyDown={e => {
               if (e.key === 'Enter' && value) { e.preventDefault(); commit(value); }
               else if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
             }} />
      {open && pos && createPortal(
        <div ref={pop} className="cselect-pop tag-pop"
             style={{
               left: pos.left, width: pos.width, maxHeight: pos.maxHeight,
               ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
             }}>
          {canCreate && (
            <div className="cselect-opt tag-create" onClick={() => commit(value)}>
              {t('tag.create')} <b className="mono">{value}</b>
            </div>
          )}
          {suggestions.map(c => (
            <div key={c} className="cselect-opt" onClick={() => commit(c)}>{c}</div>
          ))}
          {!canCreate && suggestions.length === 0 && (
            <div className="cselect-opt" style={{ color: 'var(--text-dim)' }}>
              {st.catalog.length ? t('tag.noMatches') : t('tag.noneYet')}
            </div>
          )}
        </div>,
        document.body
      )}
    </span>
  );
}

// Inline chips + editor for one object.
export function TagChips({ st, kind, objId }) {
  const { can } = useAuth();
  const { t } = useI18n();
  const { push } = useToast();
  const [editing, setEditing] = useState(false);
  const k = kind || st.kind;
  const tags = st.getTags(k, objId);
  const editable = can('wmsobjects.manage');

  const commit = async (next) => {
    try { await st.setTags(k, objId, next); }
    catch (e) { push({ type: 'error', message: e.message }); }
  };
  const add = (tag) => { if (tag && !tags.includes(tag)) commit([...tags, tag]); };
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
          <TagCombo st={st} existing={tags} onAdd={add} onClose={() => setEditing(false)} />
          <button className="tag-btn" onClick={() => setEditing(false)}>{t('action.done')}</button>
        </>
      ) : (
        <button className="tag-btn ghost" onClick={() => setEditing(true)} title={t('tag.edit')}>🏷</button>
      ))}
    </span>
  );
}
