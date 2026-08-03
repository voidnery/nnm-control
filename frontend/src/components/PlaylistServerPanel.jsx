import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import { useConfirm } from '../confirm.jsx';
import Select from './Select.jsx';
import Modal from './Modal.jsx';

// What is on a server, and what can be done about it.
//
// Everything behind this panel already existed as routes and none of it was
// reachable: the state, the media, the history, start and stop, and the four
// checks. A capability with no way in is a capability nobody has — which is
// what "I don't see our changes" meant when this epic started.
//
// Ordered by the question an operator arrives with: what is running, is
// anything wrong with it, what is available to put in it, and what was there
// before.

const fmtMs = (ms) => {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${ms < 0 ? '−' : ''}${h ? `${h} h ` : ''}${m} min`;
};
const fmtBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${(b / 1e3).toFixed(0)} KB`);

export default function PlaylistServerPanel({ servers }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const { push } = useToast();
  const confirm = useConfirm();
  const manage = can('playlist.manage');

  const [srvId, setSrvId] = useState('');
  const [state, setState] = useState(null);
  const [advice, setAdvice] = useState(null);
  const [media, setMedia] = useState(null);
  const [versions, setVersions] = useState([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [folder, setFolder] = useState('');
  const [viewing, setViewing] = useState(null);
  // Which file on the server is the playlist. Not assumed: the default was one
  // character away from the name this fleet uses, and the panel then reported
  // "no playlist" about a server that had one.
  const [file, setFile] = useState('server-playlist.json');

  const load = useCallback(async () => {
    if (!srvId) { setState(null); setAdvice(null); setMedia(null); setVersions([]); return; }
    setError('');
    // Independently: a server whose media cannot be listed can still have its
    // playlist read, and saying "nothing works" when one thing does is how an
    // operator ends up looking in the wrong place.
    api(`/servers/${srvId}/agent/playlist-state?name=${encodeURIComponent(file)}`)
      .then(setState).catch(e => setState({ exists: null, error: e.message }));
    api(`/servers/${srvId}/agent/playlist-advice`).then(setAdvice).catch(() => setAdvice(null));
    api(`/servers/${srvId}/agent/media`).then(d => setMedia(d)).catch(() => setMedia(null));
    api(`/servers/${srvId}/agent/playlist-history`).then(d => setVersions(d.versions || [])).catch(() => setVersions([]));
  }, [srvId, file]);

  useEffect(() => { load(); }, [load]);

  const act = async (label, fn) => {
    setBusy(label);
    try { const r = await fn(); push({ type: 'ok', message: t('pls.done') }); await load(); return r; }
    catch (e) { setError(e.message); push({ type: 'err', message: e.message }); return null; }
    finally { setBusy(''); }
  };

  const upload = async (file) => {
    if (!file) return;
    // The folder is part of the name: one level, which is how this work is
    // organised — adverts apart from matches.
    const name = folder ? `${folder}/${file.name}` : file.name;
    await act('upload', () => api(`/servers/${srvId}/agent/media?name=${encodeURIComponent(name)}`, {
      method: 'PUT', body: file, raw: true,
    }));
  };

  const tasks = state?.parsed?.tasks || [];
  const timingOf = (stream) => (advice?.timings || []).find(x => x.stream === stream);
  const joinsOf = (stream) => (advice?.joins || []).find(x => x.stream === stream);

  return (
    <div className="panel">
      <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>{t('pls.title')}</b>
        <Select value={srvId} onChange={setSrvId} style={{ minWidth: 240 }}
                options={[{ value: '', label: t('pls.pickServer') },
                          ...servers.map(s => ({ value: s.id || s._id, label: s.name }))]} />
        {srvId && <button onClick={load} disabled={!!busy}>{t('action.refresh')}</button>}
        {srvId && <span className="hint mono" style={{ fontSize: 12 }}>{file}</span>}
      </div>

      {error && <div className="error-box" style={{ marginTop: 8 }}>{error}</div>}
      {!srvId && <div className="hint" style={{ marginTop: 8 }}>{t('pls.pickServerHint')}</div>}

      {srvId && state && (
        <>
          {/* ---- What is running ---- */}
          <div style={{ marginTop: 12 }}>
            {/* Four causes that look alike from a screen: the agent is not
                answering, it is looking in the wrong directory, the file is
                not there, or it is there and will not parse. They need
                different things done about them, so they are said
                differently. */}
            {state.exists === null && (
              <div className="hint" style={{ color: 'var(--warn)' }}>
                {t('pls.unreachable', { why: state.error || '' })}
              </div>
            )}
            {state.exists === false && (
              <div className="hint">
                {t('pls.noFile')}
                {state.confDir && ` ${t('pls.lookedIn', { dir: state.confDir })}`}
                {/* Offered rather than described: the operator should not have
                    to guess the spelling either. */}
                {state.alternatives?.length > 0 && (
                  <div className="row" style={{ gap: 6, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span>{t('pls.butThereIs')}</span>
                    {state.alternatives.map(n => (
                      <button key={n} onClick={() => setFile(n)}>{n}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {state.exists === true && state.parsed && !state.parsed.ok && (
              <div className="hint" style={{ color: 'var(--warn)' }}>
                {t('pls.unreadable', { why: state.parsed.reason })}
              </div>
            )}

            {/* Changed behind the panel: the next deploy overwrites it, and
                editing by hand is how this has always been done here. */}
            {advice?.drift?.state === 'drifted' && (
              <div className="hint" style={{ color: 'var(--warn)', marginBottom: 8 }}>
                {t('pls.drifted', { when: new Date(advice.drift.since).toLocaleString() })}
              </div>
            )}

            {tasks.map((task) => {
              const tm = timingOf(task.stream);
              const jn = joinsOf(task.stream);
              return (
                <div key={task.stream} className="panel" style={{ background: 'var(--bg-raise)', marginBottom: 8 }}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <div>
                      <b className="mono">{task.stream}</b>
                      <div className="hint">
                        {t('pls.taskCounts', { entries: task.count, files: task.distinct })}
                        {tm && (tm.loopsForever
                          ? ` · ${t('pls.loops', { len: fmtMs(tm.totalMs) })}`
                          : ` · ${t('pls.runs', { len: fmtMs(tm.totalMs) })}`)}
                        {tm?.blocks?.some(b => !b.complete) && ` · ${t('pls.partialLength')}`}
                      </div>
                    </div>
                    {manage && (
                      <div className="row" style={{ gap: 6 }}>
                        <button disabled={!!busy}
                                onClick={() => confirm({ title: t('pls.stop'), body: t('pls.stopConfirm', { stream: task.stream }) })
                                  .then(ok => ok && act('stop', () => api(`/servers/${srvId}/agent/playlist-stop`, {
                                    method: 'POST', body: { stream: task.stream },
                                  })))}>{t('pls.stop')}</button>
                      </div>
                    )}
                  </div>

                  {/* Ending soon, with the clock time rather than a duration
                      the operator has to add to now. */}
                  {tm?.endsAt && (
                    <div className="hint" style={{ marginTop: 4, color: tm.endsInMs < 3600_000 ? 'var(--warn)' : undefined }}>
                      {t('pls.endsAt', { when: new Date(tm.endsAt.contentEndsAt).toLocaleTimeString(), left: fmtMs(tm.endsInMs) })}
                      {tm.endsAt.streamDropsAt === null && ` · ${t('pls.neverDrops')}`}
                    </div>
                  )}

                  {/* Joins that will stutter. It is the change that shows, so
                      they are counted as boundaries, not as files. */}
                  {jn?.issues?.length > 0 && (
                    <details className="hint" style={{ marginTop: 4, color: 'var(--warn)' }}>
                      <summary style={{ cursor: 'pointer' }}>{t('pls.joins', { n: jn.issues.length })}</summary>
                      {jn.issues.slice(0, 8).map((is, i) => (
                        <div key={i} className="mono" style={{ fontSize: 11 }}>
                          #{is.at}: {is.diffs.map(d => `${d.what} ${d.from} → ${d.to}`).join(', ')}
                        </div>
                      ))}
                    </details>
                  )}
                </div>
              );
            })}

            {state.media?.missing?.length > 0 && (
              <div className="hint" style={{ color: 'var(--warn)' }}>
                {t('pls.missing', { n: state.media.missing.length })}
                <div className="mono" style={{ fontSize: 11 }}>
                  {state.media.missing.slice(0, 5).map(m => m.path).join('\n')}
                </div>
              </div>
            )}
          </div>

          {/* ---- Stopped streams that can be put back ---- */}
          {manage && versions.length > 0 && (
            <StoppedStreams srvId={srvId} running={tasks.map(x => x.stream)} versions={versions}
                            busy={busy} act={act} />
          )}

          {/* ---- Media ---- */}
          <div style={{ marginTop: 14 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <b>{t('pls.media')}</b>
              {manage && (
                <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                  <input placeholder={t('pls.folder')} value={folder} onChange={e => setFolder(e.target.value)}
                         style={{ width: 130 }} />
                  <label className="btn" style={{ cursor: 'pointer' }}>
                    {busy === 'upload' ? t('pls.uploading') : t('pls.upload')}
                    <input type="file" style={{ display: 'none' }} disabled={!!busy}
                           onChange={e => { upload(e.target.files?.[0]); e.target.value = ''; }} />
                  </label>
                </div>
              )}
            </div>
            <div className="hint">{media ? t('pls.mediaIn', { dir: media.dir }) : t('pls.mediaNone')}</div>
            {media?.files?.length > 0 && (
              <div style={{ maxHeight: 220, overflow: 'auto', marginTop: 6 }}>
                <table>
                  <tbody>
                    {media.files.map(f => (
                      <tr key={f.name}>
                        <td className="mono" style={{ fontSize: 12 }}>{f.name}</td>
                        <td className="hint" style={{ whiteSpace: 'nowrap' }}>{fmtBytes(f.size)}</td>
                        <td style={{ textAlign: 'right' }}>
                          {manage && (
                            <button className="danger" disabled={!!busy}
                                    onClick={() => confirm({ title: t('action.delete'), body: t('pls.deleteConfirm', { name: f.name }) })
                                      .then(ok => ok && act('del', () => api(
                                        `/servers/${srvId}/agent/media?name=${encodeURIComponent(f.name)}`, { method: 'DELETE' })))}>
                              {t('action.delete')}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ---- History ---- */}
          <div style={{ marginTop: 14 }}>
            <b>{t('pls.history')}</b>
            {versions.length === 0 && <div className="hint">{t('pls.historyNone')}</div>}
            {versions.length > 0 && (
              <table style={{ marginTop: 6 }}>
                <tbody>
                  {versions.map(v => (
                    <tr key={v._id}>
                      <td className="hint" style={{ whiteSpace: 'nowrap' }}>{new Date(v.createdAt).toLocaleString()}</td>
                      <td className="hint">
                        {v.origin === 'captured' ? t('pls.captured') : (v.by || '—')}
                        {v.forced && <span style={{ color: 'var(--warn)' }}> · {t('pls.wasForced')}</span>}
                        {v.missingAtDeploy?.length > 0 && (
                          <span style={{ color: 'var(--warn)' }}> · {t('pls.hadMissing', { n: v.missingAtDeploy.length })}</span>
                        )}
                      </td>
                      <td className="hint" style={{ whiteSpace: 'nowrap' }}>{fmtBytes(v.bytes)}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button onClick={() => api(`/servers/${srvId}/agent/playlist-history/${v._id}`).then(setViewing)}>
                          {t('pls.view')}
                        </button>
                        {manage && (
                          <button disabled={!!busy}
                                  onClick={() => confirm({ title: t('pls.rollback'), body: t('pls.rollbackConfirm', { when: new Date(v.createdAt).toLocaleString() }) })
                                    .then(ok => ok && act('rollback', () => api(`/servers/${srvId}/agent/rollback-playlist`, {
                                      method: 'POST', body: { versionId: v._id },
                                    })))}>{t('pls.rollback')}</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {viewing && (
        <Modal onClose={() => setViewing(null)} size="chart">
          <h3 style={{ marginTop: 0 }}>{new Date(viewing.createdAt).toLocaleString()}</h3>
          <pre className="mono" style={{ fontSize: 11, maxHeight: '60vh', overflow: 'auto' }}>{viewing.content}</pre>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button onClick={() => setViewing(null)}>{t('action.close')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Streams this panel has seen but that are not in the file now.
//
// Without this, stopping a stream is a one-way door: the definition is in the
// history, but finding it there and putting it back by hand is not something
// anyone would do mid-event.
function StoppedStreams({ srvId, running, versions, busy, act }) {
  const { t } = useI18n();
  const [known, setKnown] = useState([]);

  useEffect(() => {
    // The newest few versions are enough: a stream stopped ten deploys ago is
    // not something being restored in a hurry, and reading every version to
    // find it would cost a request each.
    Promise.all(versions.slice(0, 5).map(v => api(`/servers/${srvId}/agent/playlist-history/${v._id}`).catch(() => null)))
      .then(list => {
        const names = new Set();
        for (const v of list) {
          if (!v?.content) continue;
          try { for (const tk of JSON.parse(v.content).Tasks || []) if (tk?.Stream) names.add(tk.Stream); }
          catch { /* a version that will not parse is not a source to restore from */ }
        }
        setKnown([...names]);
      });
  }, [srvId, versions]);

  const stopped = known.filter(s => !running.includes(s));
  if (!stopped.length) return null;

  return (
    <div style={{ marginTop: 12 }}>
      <b>{t('pls.stopped')}</b>
      <div className="hint">{t('pls.stoppedHint')}</div>
      {stopped.map(stream => (
        <div key={stream} className="row" style={{ justifyContent: 'space-between', marginTop: 6, gap: 8 }}>
          <span className="mono">{stream}</span>
          <div className="row" style={{ gap: 6 }}>
            {/* Two buttons, not one with a checkbox: they do different things
                and the difference is an hour of broadcast. */}
            <button disabled={!!busy}
                    onClick={() => act('start', () => api(`/servers/${srvId}/agent/playlist-start`, {
                      method: 'POST', body: { stream },
                    }))}>{t('pls.startTop')}</button>
            <button disabled={!!busy}
                    onClick={() => act('resume', () => api(`/servers/${srvId}/agent/playlist-start`, {
                      method: 'POST', body: { stream, resume: true },
                    }))}>{t('pls.startResume')}</button>
          </div>
        </div>
      ))}
    </div>
  );
}
