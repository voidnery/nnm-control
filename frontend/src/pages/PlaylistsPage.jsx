import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import { useConfirm } from '../confirm.jsx';
import Modal, { backdropClose } from '../components/Modal.jsx';
import PlaylistServerPanel from '../components/PlaylistServerPanel.jsx';
import Select from '../components/Select.jsx';
import * as E from '../lib/playlistEngine.js';
import { DeployPlaylistModal } from '../components/AgentPanel.jsx';
import { copyText } from '../lib/clipboard.js';

// ---- small field helpers ----
function Field({ label, children }) {
  return <div style={{ marginBottom: 8 }}><label>{label}</label>{children}</div>;
}
function NumOrEmpty({ value, onChange, placeholder }) {
  return <input value={value ?? ''} placeholder={placeholder}
                onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
}

// ---- Stream editor ----
function StreamEditor({ stream, onChange, onRemove, onDup, isDefault, media }) {
  const { t } = useI18n();
  const set = (k, v) => onChange({ ...stream, [k]: v });
  const isVod = stream.Type === 'vod';
  // Whether this entry points at a file the server actually has.
  //
  // A source has always been free text, which is how a path to a missing file
  // gets into a playlist — and the only way to find out has been silence on
  // air. Checked here, while it is being typed, against what the server
  // reports it holds.
  const known = media?.paths;
  const missing = isVod && known && stream.Source && !known.has(stream.Source);
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
          <input value={stream.Source} onChange={e => set('Source', e.target.value)}
                 style={missing ? { borderColor: 'var(--warn)' } : undefined}
                 placeholder={isVod ? '/media/file.mp4' : 'rtmp://src/app/stream'} />
          {missing && <div className="hint" style={{ color: 'var(--warn)' }}>{t('pl.sourceMissing')}</div>}
          {/* Picking beats typing: a list of what is there cannot produce a
              path that is not. Typing stays for live sources and for files
              placed outside the media library. */}
          {isVod && known && known.size > 0 && (
            <Select value="" onChange={v => v && set('Source', v)} style={{ marginTop: 4 }}
                    options={[{ value: '', label: t('pl.pickFromServer') },
                              ...[...known].sort().map(p => ({ value: p, label: p.replace(media.dir + '/', '') }))]} />
          )}
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
function BlockEditor({ block, onChange, onRemove, onDup, media }) {
  const { t } = useI18n();
  const [ads, setAds] = useState(false);
  const [every, setEvery] = useState(1);
  const [chosen, setChosen] = useState([]);
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
            {/* Grouped: a third child under space-between spreads into the
                middle instead of sitting with its neighbour. */}
            <div className="row" style={{ gap: 6 }}>
              <button onClick={() => set('Streams', [...block.Streams, E.makeStream()])}>+ {t('pl.addSource')}</button>
              {/* The pattern the live playlist was built with by hand: three
                  adverts before every match, 24 entries for 8 matches. Doing
                  it a row at a time is where an advert goes missing or a match
                  repeats, and neither shows until it airs. */}
              <button onClick={() => setAds(true)} disabled={!block.Streams.length}>{t('pl.interleave')}</button>
            </div>
          </div>
          {block.Streams.map((s, i) => (
            <StreamEditor key={s._id || i} stream={s} media={media}
                          onChange={ns => setStream(i, ns)}
                          onRemove={() => set('Streams', block.Streams.filter((_, j) => j !== i))}
                          onDup={() => set('Streams', [...block.Streams.slice(0, i + 1), { ...s, _id: E.newUid() }, ...block.Streams.slice(i + 1)])} />
          ))}
          {block.Streams.length === 0 && <div className="hint">{t('pl.noSources')}</div>}
        </div>
      )}

      {ads && (
        <Modal onClose={() => setAds(false)} size="wide">
          <h3 style={{ marginTop: 0 }}>{t('pl.interleave')}</h3>
          <p className="hint">{t('pl.interleaveHint')}</p>
          <label>{t('pl.interleaveWhich')}</label>
          <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 6, padding: 6 }}>
            {(media?.files || []).map(f => {
              const full = `${media.dir}/${f.name}`;
              return (
                <label key={full} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 0' }}>
                  <input type="checkbox" checked={chosen.includes(full)}
                         onChange={e => setChosen(c => (e.target.checked ? [...c, full] : c.filter(x => x !== full)))} />
                  <span className="mono" style={{ fontSize: 12 }}>{f.name}</span>
                </label>
              );
            })}
            {!media?.files?.length && <div className="hint">{t('pl.interleaveNoMedia')}</div>}
          </div>
          <label style={{ marginTop: 8 }}>{t('pl.interleaveEvery')}</label>
          <input type="number" min={1} value={every} onChange={e => setEvery(Math.max(1, Number(e.target.value) || 1))} />
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button onClick={() => setAds(false)}>{t('action.cancel')}</button>
            <button className="primary" disabled={!chosen.length}
                    onClick={() => {
                      // Applied here rather than through the parent: the block
                      // is what is being changed, and routing it upward would
                      // need the block's own index, which is exactly the sort
                      // of bookkeeping that goes wrong quietly.
                      const content = block.Streams.filter(x => !chosen.includes(x.Source));
                      const out = [];
                      content.forEach((item, i) => {
                        if (i % every === 0) for (const src of chosen) out.push(E.makeStream({ Type: 'vod', Source: src }));
                        out.push(item);
                      });
                      onChange({ ...block, Streams: out });
                      setAds(false);
                    }}>{t('pl.interleaveApply')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---- Task editor ----
function TaskEditor({ task, onChange, onRemove, media }) {
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
        <BlockEditor key={b._id || i} block={b} media={media}
                     onChange={nb => setBlock(i, nb)}
                     onRemove={() => set('Blocks', task.Blocks.filter((_, j) => j !== i))}
                     onDup={() => set('Blocks', [...task.Blocks.slice(0, i + 1), { ...b, _id: E.newUid(), Id: E.newBlockId() }, ...task.Blocks.slice(i + 1)])} />
      ))}
      {task.Blocks.length === 0 && <div className="hint">{t('pl.noBlocks')}</div>}
    </div>
  );
}

// ---- Builder (full editor for one playlist) ----
function Builder({ initial, onClose, onSaved, servers = [] }) {
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

  // A server to check against. Editing stays local — nothing here writes to a
  // server — but an editor with no idea what the server holds is how a path to
  // a missing file gets saved and only surfaces as silence on air.
  const [srvId, setSrvId] = useState('');
  const [media, setMedia] = useState(null);
  const [state, setState] = useState(null);

  useEffect(() => {
    if (!srvId) { setMedia(null); setState(null); return undefined; }
    let dead = false;
    api(`/servers/${srvId}/agent/media`)
      .then(d => { if (dead) return;
        const dir = String(d?.dir || '').replace(/\/+$/, '');
        setMedia({ dir, files: d?.files || [],
          paths: new Set((d?.files || []).map(f => `${dir}/${f.name}`)) });
      })
      .catch(() => { if (!dead) setMedia(null); });
    api(`/servers/${srvId}/agent/playlist-state`)
      .then(d => { if (!dead) setState(d); })
      .catch(e => { if (!dead) setState({ error: e.message }); });
    return () => { dead = true; };
  }, [srvId]);

  // Interleave a repeating set between the items already in a block.
  //
  // The live playlist does this by hand: three adverts between every match,
  // 24 entries for 8 matches. Building that a row at a time is where an
  // operator loses an advert or repeats a match, and neither is visible until
  // it airs.
  const interleave = (taskIndex, blockIndex, sources, every) => {
    setModel(m => {
      const tasks = m.Tasks.map((tk, ti) => {
        if (ti !== taskIndex) return tk;
        const blocks = tk.Blocks.map((b, bi) => {
          if (bi !== blockIndex) return b;
          // Only the content already there is treated as content; a previous
          // interleave is not multiplied by the next one.
          const content = b.Streams.filter(x => !sources.includes(x.Source));
          const out = [];
          content.forEach((item, i) => {
            if (i % every === 0) for (const src of sources) out.push(E.makeStream({ Type: 'vod', Source: src }));
            out.push(item);
          });
          return { ...b, Streams: out };
        });
        return { ...tk, Blocks: blocks };
      });
      return { ...m, Tasks: tasks };
    });
  };
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
            {/* Which server this is being written for. Nothing is sent to it
                from here — but without one the editor cannot say whether a
                path exists, which is the failure it is meant to prevent. */}
            <div className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
              <span className="hint">{t('pl.checkAgainst')}</span>
              <Select value={srvId} onChange={setSrvId} style={{ minWidth: 220 }}
                      options={[{ value: '', label: t('pl.noServer') },
                                ...servers.map(sv => ({ value: sv.id || sv._id, label: sv.name }))]} />
              {media && <span className="hint">{t('pl.mediaCount', { n: media.files.length, dir: media.dir })}</span>}
              {srvId && !media && <span className="hint" style={{ color: 'var(--warn)' }}>{t('pl.mediaUnavailable')}</span>}
            </div>

            {/* What is on that server now, so an edit is made knowing what it
                would replace. */}
            {state && !state.error && (
              <div className="hint" style={{ marginBottom: 8 }}>
                {state.exists === false
                  ? t('pl.stateNone')
                  : t('pl.stateHas', {
                    tasks: state.parsed?.tasks?.length ?? 0,
                    entries: (state.parsed?.tasks || []).reduce((a, x) => a + x.count, 0),
                  })}
                {state.media?.missing?.length > 0 && (
                  <span style={{ color: 'var(--warn)' }}> · {t('pl.stateMissing', { n: state.media.missing.length })}</span>
                )}
              </div>
            )}

            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b>{t('pl.tasks')}</b>
              <button onClick={() => setModel(m => ({ ...m, Tasks: [...m.Tasks, E.makeTask()] }))}>+ {t('pl.addTask')}</button>
            </div>
            {model.Tasks.map((tk, i) => (
              <TaskEditor key={tk._id || i} task={tk} media={media} onChange={ntk => setTask(i, ntk)}
                          onRemove={() => setModel(m => ({ ...m, Tasks: m.Tasks.filter((_, j) => j !== i) }))} />
            ))}
            {model.Tasks.length === 0 && <div className="hint">{t('pl.noTasks')}</div>}
          </div>
          {showJson && (
            <div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b>{t('pl.jsonPreview')}</b>
                <div className="row">
                  <button onClick={async () => push(await copyText(built)
                    ? { type: 'ok', message: t('pl.copied') }
                    : { type: 'error', message: t('copy.failed') })}>{t('srt.copy')}</button>
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
  const [servers, setServers] = useState([]);
  const [deploying, setDeploying] = useState(null);

  const load = () => api('/playlists').then(setItems).catch(e => setError(e.message));
  useEffect(() => { load(); api('/servers').then(setServers).catch(() => {}); }, []);

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

      <div className="row" style={{ marginBottom: 12 }}>
        {can('playlist.manage') && (
          <button className="primary" onClick={() => setEditing({})}>+ {t('pl.newTitle')}</button>
        )}
      </div>

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
                      ? <><button onClick={() => setDeploying(p)}>{t('agent.deploy')}</button>{' '}
                          <button onClick={() => openEdit(p)}>{t('action.edit')}</button>{' '}
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
        <Builder initial={editing} servers={servers} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
      {/* The server side of playlists: what is running, what is wrong with it,
          what media is there, and what was there before. All of it existed as
          routes and none of it was reachable. */}
      <PlaylistServerPanel servers={servers} />
      {deploying && <DeployPlaylistModal playlist={deploying} servers={servers} onClose={() => setDeploying(null)} />}
    </div>
  );
}
