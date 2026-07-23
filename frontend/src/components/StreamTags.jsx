import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import { useConfirm } from '../confirm.jsx';
import SearchInput from './SearchInput.jsx';

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

  // Vocabulary-level CRUD: applies to every object of this kind on this server.
  const renameTag = useCallback(async (from, to) => {
    await api(`/stream-tags/${serverId}/vocab/${kind}/rename`, { method: 'POST', body: { from, to } });
    await load();
  }, [serverId, kind, load]);

  const deleteTagEverywhere = useCallback(async (tag) => {
    await api(`/stream-tags/${serverId}/vocab/${kind}/delete`, { method: 'POST', body: { tag } });
    await load();
  }, [serverId, kind, load]);

  return { kind, map, catalog, selected, mode, setMode, toggleFilter, setSelected,
           getTags, setTags, matches, reload: load, renameTag, deleteTagEverywhere };
}

// Shared popover positioning: fixed + portal so no scroll container can clip it.
function usePopover(open, anchorRef) {
  const internal = useRef(null);
  const anchor = anchorRef || internal;
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

// Tag picker popover: one place to add AND remove (checklist toggle), create
// new values, and manage the tab's vocabulary. Modelled on how issue trackers
// handle labels — a single popover instead of a transient inline input, which
// also removes the class of bug where clicking a chip's × dismissed the editor
// before the click landed.
function TagPopover({ st, objId, kind, tags, cellRef, onClose }) {
  const { t } = useI18n();
  const { push } = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [manage, setManage] = useState(false);
  const [renaming, setRenaming] = useState(null);   // { tag, value }
  const [busy, setBusy] = useState(false);
  // Anchor to the whole cell: measured synchronously on open, and clicks on
  // chips (incl. their ×) count as "inside" so they never dismiss it mid-click.
  const { pop, pos } = usePopover(true, cellRef);

  useEffect(() => {
    const onDoc = (e) => {
      if (cellRef.current?.contains(e.target) || pop.current?.contains(e.target)) return;
      onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, cellRef, pop]);

  const needle = q.trim().toLowerCase();
  const shown = needle ? st.catalog.filter(c => c.toLowerCase().includes(needle)) : st.catalog;
  const value = q.trim();
  const canCreate = value && !st.catalog.some(c => c.toLowerCase() === value.toLowerCase());

  const apply = async (next) => {
    setBusy(true);
    try { await st.setTags(kind, objId, next); }
    catch (e) { push({ type: 'error', message: e.message }); }
    finally { setBusy(false); }
  };
  const toggle = (tag) => apply(tags.includes(tag) ? tags.filter(x => x !== tag) : [...tags, tag]);
  const create = async () => { setQ(''); await apply([...tags, value]); };

  const commitRename = async () => {
    const { tag, value: to } = renaming;
    setRenaming(null);
    if (!to.trim() || to.trim() === tag) return;
    setBusy(true);
    try { await st.renameTag(tag, to.trim()); push({ type: 'ok', message: t('tag.renamed') }); }
    catch (e) { push({ type: 'error', message: e.message }); }
    finally { setBusy(false); }
  };
  const removeEverywhere = async (tag) => {
    if (!(await confirm({ danger: true, message: t('tag.deleteAllConfirm', { tag }) }))) return;
    setBusy(true);
    try { await st.deleteTagEverywhere(tag); push({ type: 'ok', message: t('tag.deleted') }); }
    catch (e) { push({ type: 'error', message: e.message }); }
    finally { setBusy(false); }
  };

  if (!pos) return null;
  return createPortal(
    <div ref={pop} className="cselect-pop tag-pop"
         style={{
           left: pos.left, width: Math.max(pos.width, 230), maxHeight: pos.maxHeight,
           ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
         }}>
      <div className="tag-pop-search">
        <SearchInput autoFocus value={q} onChange={setQ} placeholder={t('tag.searchOrCreate')} />
      </div>

      {canCreate && !manage && (
        <div className="cselect-opt tag-create" onClick={create}>
          {t('tag.create')} <b className="mono">{value}</b>
        </div>
      )}

      {shown.map(tag => {
        const on = tags.includes(tag);
        if (manage) {
          return (
            <div key={tag} className="tag-manage-row">
              {renaming?.tag === tag ? (
                <input className="tag-input" autoFocus value={renaming.value}
                       onChange={e => setRenaming({ tag, value: e.target.value })}
                       onKeyDown={e => {
                         if (e.key === 'Enter') commitRename();
                         if (e.key === 'Escape') setRenaming(null);
                       }}
                       onBlur={commitRename} />
              ) : (
                <span className="tag-manage-name" onClick={() => setRenaming({ tag, value: tag })}
                      title={t('tag.renameHint')}>{tag}</span>
              )}
              <button className="tag-btn ghost" disabled={busy}
                      onClick={() => removeEverywhere(tag)} title={t('tag.deleteAll')}>🗑</button>
            </div>
          );
        }
        return (
          <div key={tag} className={'cselect-opt tagopt' + (on ? ' on' : '')}
               onClick={() => toggle(tag)}>
            <span className="tagopt-check">{on ? '✓' : ''}</span>{tag}
          </div>
        );
      })}

      {!shown.length && !canCreate && (
        <div className="cselect-opt" style={{ color: 'var(--text-dim)' }}>
          {st.catalog.length ? t('tag.noMatches') : t('tag.noneYet')}
        </div>
      )}

      <div className="tag-pop-foot">
        <button className="linklike" onClick={() => { setManage(m => !m); setRenaming(null); }}>
          {manage ? t('tag.doneManaging') : t('tag.manage')}
        </button>
        <button className="linklike" onClick={onClose}>{t('action.close')}</button>
      </div>
    </div>,
    document.body
  );
}

// Inline chips for one object + the picker trigger.
export function TagChips({ st, kind, objId }) {
  const { can } = useAuth();
  const { t } = useI18n();
  const { push } = useToast();
  const [open, setOpen] = useState(false);
  const cellRef = useRef(null);
  const k = kind || st.kind;
  const tags = st.getTags(k, objId);
  const editable = can('wmsobjects.manage');

  const remove = async (tag) => {
    try { await st.setTags(k, objId, tags.filter(x => x !== tag)); }
    catch (e) { push({ type: 'error', message: e.message }); }
  };

  return (
    <span className="tagcell" ref={cellRef}>
      {tags.map(tag => (
        <span key={tag} className="tagchip static">
          {tag}
          {editable && (
            <button className="x" onClick={() => remove(tag)} title={t('tag.remove')}>×</button>
          )}
        </span>
      ))}
      {!tags.length && <span className="hint" style={{ fontSize: 12 }}>—</span>}
      {editable && (
        <button className={'tag-btn ghost' + (open ? ' active' : '')}
                onClick={() => setOpen(o => !o)} title={t('tag.edit')}>+</button>
      )}
      {open && editable && (
        <TagPopover st={st} objId={objId} kind={k} tags={tags} cellRef={cellRef}
                    onClose={() => setOpen(false)} />
      )}
    </span>
  );
}
