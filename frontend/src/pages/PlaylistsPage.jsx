import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import { useConfirm } from '../confirm.jsx';
import Modal, { backdropClose } from '../components/Modal.jsx';
import Select from '../components/Select.jsx';
import * as E from '../lib/playlistEngine.js';

// ---- small field helpers ----
function Field({ label, children }) {
  return <div style={{ marginBottom: 8 }}><label>{label}</label>{children}</div>;
}
function NumOrEmpty({ value, onChange, placeholder }) {
  return <input value={value ?? ''} placeholder={placeholder}
                onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
}

// ---- Stream editor ----
function StreamEditor({ stream, onChange, onRemove, onDup, isDefault }) {
  const { t } = useI18n();
  const set = (k, v) => onChange({ ...stream, [k]: v });
  const isVod = stream.Type === 'vod';
  return (
    <div className="panel" style={{ background: 'var(--bg-raise)', marginBottom: 6 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b className="mono">{isDefault ? t('pl.defaultStream') : t('pl.stream')}: {stream.Source || '—'}</b>
        {!isDefault && (
          <div className="row">
            <button onClick={onDup}>{t('pl.dup')}</button>
            <button className="danger" onClick={onRemove}>{t('action.delete')}</button>
          </div>
        )}
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', marginTop: 8 }}>
        <Field label={t('pl.type')}>
          <Select value={stream.Type} onChange={v => set('Type', v)}
                  options={[{ value: 'vod', label: 'vod (file)' }, { value: 'live', label: 'live (stream)' }]} />
        </Field>
        <Field label={t('pl.source')}>
          <input value={stream.Source} onChange={e => set('Source', e.target.value)} placeholder={isVod ? '/media/file.mp4' : 'rtmp://src/app/stream'} />
        </Field>
        <Field label={t('pl.durationSec')}>
          <input value={E.msToSec(stream.Duration)} placeholder="sec / hh:mm:ss"
                 onChange={e => { try { set('Duration', E.secToMs(e.target.value)); } catch { /* keep typing */ } }} />
        </Field>
        <Field label={t('pl.totalDurationSec')}>
          <input value={E.msToSec(stream.TotalDuration)} placeholder="sec / hh:mm:ss"
                 onChange={e => { try { set('TotalDuration', E.secToMs(e.target.value)); } catch { /* */ } }} />
        </Field>
        {isVod && <Field label={t('pl.startSec')}>
          <input value={E.msToSec(stream.Start)} placeholder="sec"
                 onChange={e => { try { set('Start', E.secToMs(e.target.value)); } catch { /* */ } }} />
        </Field>}
        {isVod && <Field label={t('pl.maxIter')}><NumOrEmpty value={stream.MaxIterations} onChange={v => set('MaxIterations', v)} /></Field>}
        <Field label={t('pl.streamTitle')}><input value={stream.StreamTitle || ''} onChange={e => set('StreamTitle', e.target.value || null)} /></Field>
        <Field label={t('pl.streamUrl')}><input value={stream.StreamUrl || ''} onChange={e => set('StreamUrl', e.target.value || null)} /></Field>
      </div>
    </div>
  );
}

// ---- Block editor ----
function BlockEditor({ block, onChange, onRemove, onDup }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const set = (k, v) => onChange({ ...block, [k]: v });
  const setStream = (i, s) => set('Streams', block.Streams.map((x, j) => j === i ? s : x));
  return (
    <div className="panel" style={{ marginBottom: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <b>{t('pl.block')}: {block.Name || block.Id} <span className="hint mono">({(block.Streams || []).length} {t('pl.sources')})</span></b>
        <div className="row" onClick={e => e.stopPropagation()}>
          <button onClick={onDup}>{t('pl.dup')}</button>
          <button className="danger" onClick={onRemove}>{t('action.delete')}</button>
          <span className="caret">{open ? '▲' : '▼'}</span>
        </div>
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))' }}>
            <Field label={t('pl.blockId')}>
              <div className="row">
                <input className="mono" value={block.Id} onChange={e => set('Id', e.target.value)} />
                <button title={t('pl.newId')} onClick={() => set('Id', E.newBlockId())}>↻</button>
              </div>
            </Field>
            <Field label={t('pl.name')}><input value={block.Name || ''} onChange={e => set('Name', e.target.value)} /></Field>
            <Field label={t('pl.startGmt')}>
              <div className="row">
                <input className="mono" value={block.Start || ''} placeholder="YYYY-MM-DD HH:MM:SS"
                       onChange={e => set('Start', e.target.value || null)} />
                <button title="now (GMT)" onClick={() => set('Start', new Date().toISOString().slice(0, 19).replace('T', ' '))}>GMT</button>
              </div>
            </Field>
            <Field label={t('pl.durationSec')}>
              <input value={E.msToSec(block.Duration)} placeholder="sec / hh:mm:ss"
                     onChange={e => { try { set('Duration', E.secToMs(e.target.value)); } catch { /* */ } }} />
            </Field>
            <Field label={t('pl.maxIter')}><NumOrEmpty value={block.MaxIterations} onChange={v => set('MaxIterations', v)} /></Field>
          </div>

          <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
            <b>{t('pl.sources')}</b>
            <button onClick={() => set('Streams', [...block.Streams, E.makeStream()])}>+ {t('pl.addSource')}</button>
          </div>
          {block.Streams.map((s, i) => (
            <StreamEditor key={s._id || i} stream={s}
                          onChange={ns => setStream(i, ns)}
                          onRemove={() => set('Streams', block.Streams.filter((_, j) => j !== i))}
                          onDup={() => set('Streams', [...block.Streams.slice(0, i + 1), { ...s, _id: E.newUid() }, ...block.Streams.slice(i + 1)])} />
          ))}
          {block.Streams.length === 0 && <div className="hint">{t('pl.noSources')}</div>}
        </div>
      )}
    </div>
  );
}

// ---- Task editor ----
function TaskEditor({ task, onChange, onRemove }) {
  const { t } = useI18n();
  const set = (k, v) => onChange({ ...task, [k]: v });
  const setBlock = (i, b) => set('Blocks', task.Blocks.map((x, j) => j === i ? b : x));
  return (
    <div className="panel" style={{ marginBottom: 10, borderColor: 'var(--accent-dim)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>{t('pl.task')}</b>
        <button className="danger" onClick={onRemove}>{t('action.delete')}</button>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', marginTop: 8 }}>
        <Field label={t('pl.outputStream')}><input className="mono" value={task.Stream} onChange={e => set('Stream', e.target.value)} placeholder="application/stream" /></Field>
        <Field label={t('pl.inactivityTimeout')}><NumOrEmpty value={task.InactivityTimeout} onChange={v => set('InactivityTimeout', v)} /></Field>
      </div>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
        <b>{t('pl.blocks')}</b>
        <button onClick={() => set('Blocks', [...task.Blocks, E.makeBlock()])}>+ {t('pl.addBlock')}</button>
      </div>
      {task.Blocks.map((b, i) => (
        <BlockEditor key={b._id || i} block={b}
                     onChange={nb => setBlock(i, nb)}
                     onRemove={() => set('Blocks', task.Blocks.filter((_, j) => j !== i))}
                     onDup={() => set('Blocks', [...task.Blocks.slice(0, i + 1), { ...b, _id: E.newUid(), Id: E.newBlockId() }, ...task.Blocks.slice(i + 1)])} />
      ))}
      {task.Blocks.length === 0 && <div className="hint">{t('pl.noBlocks')}</div>}
    </div>
  );
}

// ---- Builder (full editor for one playlist) ----
function Builder({ initial, onClose, onSaved }) {
  const { t } = useI18n();
  const { push } = useToast();
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [model, setModel] = useState(() => initial?.model && initial.model.Tasks ? initial.model : E.makeModel());
  const [showJson, setShowJson] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const built = useMemo(() => { try { return E.buildJson(model, 2); } catch { return '{}'; } }, [model]);
  const notes = useMemo(() => E.validate(model), [model]);
  const setTask = (i, tk) => setModel(m => ({ ...m, Tasks: m.Tasks.map((x, j) => j === i ? tk : x) }));

  const save = async () => {
    if (!name.trim()) { setErr(t('pl.nameRequired')); return; }
    setBusy(true); setErr('');
    try {
      const body = { name: name.trim(), description, model };
      if (initial?.id) await api(`/playlists/${initial.id}`, { method: 'PUT', body });
      else await api('/playlists', { method: 'POST', body });
      push({ type: 'ok', message: t('pl.saved') });
      onSaved();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const doImport = () => {
    try {
      const m = E.parseJson(importText);
      setModel(m); setImportOpen(false); setImportText('');
      push({ type: 'ok', message: t('pl.imported') });
    } catch (e) { setErr(t('pl.importError') + ': ' + e.message); }
  };
  const download = () => {
    const blob = new Blob([built], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = (name || 'playlist') + '.json'; a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="modal-back" {...backdropClose(onClose)}>
      <div className="modal w-xwide" onMouseDown={e => e.stopPropagation()} style={{ maxHeight: '92vh', overflow: 'auto' }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3>{initial?.id ? t('pl.editTitle') : t('pl.newTitle')}</h3>
          <div className="row">
            <button onClick={() => setImportOpen(true)}>{t('pl.import')}</button>
            <button onClick={() => setShowJson(s => !s)}>{showJson ? t('pl.hideJson') : t('pl.showJson')}</button>
          </div>
        </div>

        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label={t('pl.plName')}><input value={name} onChange={e => setName(e.target.value)} /></Field>
          <Field label={t('pl.plDesc')}><input value={description} onChange={e => setDescription(e.target.value)} /></Field>
        </div>
        <Field label={t('pl.syncInterval')}><NumOrEmpty value={model.SyncInterval} onChange={v => setModel(m => ({ ...m, SyncInterval: v }))} /></Field>

        {err && <div className="error-box">{err}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: showJson ? '1fr 1fr' : '1fr', gap: 12 }}>
          <div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b>{t('pl.tasks')}</b>
              <button onClick={() => setModel(m => ({ ...m, Tasks: [...m.Tasks, E.makeTask()] }))}>+ {t('pl.addTask')}</button>
            </div>
            {model.Tasks.map((tk, i) => (
              <TaskEditor key={tk._id || i} task={tk} onChange={ntk => setTask(i, ntk)}
                          onRemove={() => setModel(m => ({ ...m, Tasks: m.Tasks.filter((_, j) => j !== i) }))} />
            ))}
            {model.Tasks.length === 0 && <div className="hint">{t('pl.noTasks')}</div>}
          </div>
          {showJson && (
            <div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b>{t('pl.jsonPreview')}</b>
                <div className="row">
                  <button onClick={() => { navigator.clipboard?.writeText(built); push({ type: 'ok', message: t('pl.copied') }); }}>{t('srt.copy')}</button>
                  <button onClick={download}>{t('pl.download')}</button>
                </div>
              </div>
              <pre className="mono panel" style={{ whiteSpace: 'pre-wrap', maxHeight: 480, overflow: 'auto' }}>{built}</pre>
            </div>
          )}
        </div>

        <div className="panel" style={{ borderColor: notes.length ? 'var(--warn)' : 'var(--ok)' }}>
          <b>{notes.length ? t('pl.validationIssues', { n: notes.length }) : t('pl.validationOk')}</b>
          {notes.length > 0 && (
            <ul className="hint" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {notes.map((n, i) => <li key={i}>{t(n.k, n.v)}</li>)}
            </ul>
          )}
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={onClose}>{t('action.cancel')}</button>
          <button className="primary" disabled={busy} onClick={save}>{t('action.save')}</button>
        </div>

        {importOpen && (
          <Modal onClose={() => setImportOpen(false)}>
            <h3>{t('pl.importTitle')}</h3>
            <div className="hint" style={{ marginBottom: 6 }}>{t('pl.importHint')}</div>
            <textarea className="mono" rows={12} value={importText} onChange={e => setImportText(e.target.value)} placeholder='{ "Tasks": [ ... ] }' />
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
              <button onClick={() => setImportOpen(false)}>{t('action.cancel')}</button>
              <button className="primary" disabled={!importText.trim()} onClick={doImport}>{t('pl.import')}</button>
            </div>
          </Modal>
        )}
      </div>
    </div>
  );
}

// ---- Page ----
export default function PlaylistsPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const confirm = useConfirm();
  const { push } = useToast();
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // playlist object or {} for new

  const load = () => api('/playlists').then(setItems).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);

  const remove = async (p) => {
    if (!(await confirm({ danger: true, message: t('pl.deleteConfirm', { name: p.name }) }))) return;
    try { await api(`/playlists/${p.id}`, { method: 'DELETE' }); push({ type: 'ok', message: t('pl.deleted') }); load(); }
    catch (e) { setError(e.message); }
  };
  const openEdit = async (p) => {
    try { setEditing(await api(`/playlists/${p.id}`)); } catch (e) { setError(e.message); }
  };

  return (
    <div>
      <h1>{t('page.playlists.title')}</h1>
      <div className="sub">{t('page.playlists.sub')}</div>
      {error && <div className="error-box">{error}</div>}

      {can('playlist.manage') && (
        <button className="primary" style={{ marginBottom: 12 }} onClick={() => setEditing({})}>+ {t('pl.newTitle')}</button>
      )}

      {!items ? <div className="hint">Loading…</div> : (
        <div className="panel">
          <table>
            <thead><tr><th>{t('pl.plName')}</th><th>{t('pl.tasks')}</th><th>{t('pl.updated')}</th><th></th></tr></thead>
            <tbody>
              {items.map(p => (
                <tr key={p.id}>
                  <td><b>{p.name}</b>{p.description ? <div className="hint">{p.description}</div> : null}</td>
                  <td className="mono">{(p.model?.Tasks || []).length}</td>
                  <td className="hint mono">{p.updatedAt ? new Date(p.updatedAt).toLocaleString() : '—'}{p.updatedBy ? ` · ${p.updatedBy}` : ''}</td>
                  <td style={{ textAlign: 'right' }}>
                    {can('playlist.manage')
                      ? <><button onClick={() => openEdit(p)}>{t('action.edit')}</button>{' '}
                          <button className="danger" onClick={() => remove(p)}>{t('action.delete')}</button></>
                      : <button onClick={() => openEdit(p)}>{t('action.details')}</button>}
                  </td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={4} className="hint">{t('pl.empty')}</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <Builder initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
    </div>
  );
}
