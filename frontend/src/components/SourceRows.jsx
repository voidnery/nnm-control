import { useRef, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import Select from './Select.jsx';
import IconButton from './IconButton.jsx';

// The list of things a block plays.
//
// This was a grid of eight labelled inputs per item — type, path, duration,
// total duration, offset, iterations, and two Icecast fields — repeated
// twenty-four times down a modal. Every field was equally prominent, which
// meant the two that are used constantly were as hard to find as the two that
// are used once a year, and there was no way to reorder anything.
//
// So: one line per item, carrying the type, the file, and the length. Ordering
// by drag or by arrows. Everything else behind a disclosure, because it is
// real and occasionally needed and does not belong in the way.

const isVod = (s) => (s.Type || 'vod') === 'vod';
const basename = (p) => String(p || '').split('/').pop();

export default function SourceRows({ block, onChange, media, srvId, onMediaChanged, move, t: _t }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(null);        // index whose advanced fields are shown
  const [dragging, setDragging] = useState(null);
  const [uploadingAt, setUploadingAt] = useState(null);
  const [error, setError] = useState('');
  const fileInput = useRef(null);
  const uploadTarget = useRef(null);

  const streams = block.Streams || [];
  const set = (list) => onChange({ ...block, Streams: list });
  const setAt = (i, s) => set(streams.map((x, j) => (j === i ? s : x)));

  const swap = (i, j) => {
    if (j < 0 || j >= streams.length) return;
    const list = [...streams];
    [list[i], list[j]] = [list[j], list[i]];
    set(list);
  };

  // Dropping onto another row inserts before it, which is what dragging
  // something above something else looks like it should do.
  const drop = (to) => {
    if (dragging == null || dragging === to) return;
    const list = [...streams];
    const [item] = list.splice(dragging, 1);
    list.splice(dragging < to ? to - 1 : to, 0, item);
    set(list);
    setDragging(null);
  };

  const pickFile = (i) => {
    uploadTarget.current = i;
    fileInput.current?.click();
  };

  const upload = async (f) => {
    const i = uploadTarget.current;
    if (!f || i == null) return;
    setUploadingAt(i);
    setError('');
    try {
      await api(`/servers/${srvId}/agent/media?name=${encodeURIComponent(f.name)}`, {
        method: 'PUT', body: f, raw: true,
      });
      // The point of uploading from here: the path is filled in, so the entry
      // cannot end up naming a file that was uploaded under a different name.
      const dir = String(media?.dir || '').replace(/\/+$/, '');
      setAt(i, { ...streams[i], Source: `${dir}/${f.name}` });
      onMediaChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setUploadingAt(null);
      uploadTarget.current = null;
    }
  };

  const known = media?.paths;

  return (
    <div>
      {error && <div className="error-box" style={{ marginBottom: 6 }}>{error}</div>}
      <input ref={fileInput} type="file" style={{ display: 'none' }}
             onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />

      {streams.map((s, i) => {
        const missing = isVod(s) && known && s.Source && !known.has(s.Source);
        const advanced = open === i;
        return (
          <div key={s._id || i}
               className="src-row"
               style={{ borderColor: missing ? 'var(--warn)' : undefined }}
               onDragOver={(e) => { e.preventDefault(); }}
               onDrop={() => drop(i)}>
            <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'nowrap' }}>
              {/* Only the handle is draggable: making the whole row draggable
                  means every attempt to select text in the path starts a drag. */}
              <span draggable
                    onDragStart={() => setDragging(i)}
                    onDragEnd={() => setDragging(null)}
                    title={t('src.drag')}
                    style={{ cursor: 'grab', opacity: dragging === i ? .4 : .55, padding: '0 2px' }}>≡</span>
              <span className="hint mono" style={{ width: 22, textAlign: 'right', flexShrink: 0 }}>{i + 1}</span>

              <Select value={s.Type || 'vod'} onChange={(v) => setAt(i, { ...s, Type: v })}
                      style={{ width: 104, flexShrink: 0 }}
                      options={[{ value: 'vod', label: t('src.vod') }, { value: 'live', label: t('src.live') }]} />

              <input value={s.Source || ''} onChange={(e) => setAt(i, { ...s, Source: e.target.value })}
                     placeholder={isVod(s) ? t('src.pathPlaceholder') : 'rtmp://host/app/stream'}
                     style={{ flex: 1, minWidth: 0 }} />

              {isVod(s) && (
                <>
                  {/* Choosing beats typing, and uploading fills the path in —
                      an entry cannot then name a file that arrived under a
                      different name. */}
                  {known?.size > 0 && (
                    <Select value="" onChange={(v) => v && setAt(i, { ...s, Source: v })}
                            style={{ width: 130, flexShrink: 0 }}
                            options={[{ value: '', label: t('src.pick') },
                                      ...[...known].sort().map(p => ({ value: p, label: basename(p) }))]} />
                  )}
                  <button disabled={!srvId || uploadingAt != null} onClick={() => pickFile(i)}
                          title={srvId ? t('src.uploadHere') : t('src.uploadNeedsServer')}
                          style={{ flexShrink: 0 }}>
                    {uploadingAt === i ? '…' : t('src.upload')}
                  </button>
                </>
              )}

              <div className="row" style={{ gap: 2, flexShrink: 0 }}>
                <IconButton action="up" disabled={i === 0} label={t('src.up')} onClick={() => swap(i, i - 1)} />
                <IconButton action="down" disabled={i === streams.length - 1} label={t('src.down')}
                            onClick={() => swap(i, i + 1)} />
                {/* Moving between blocks is the thing that was impossible
                    before: an item in the wrong block had to be deleted and
                    retyped. */}
                {move && (
                  <>
                    <button onClick={() => move(i, -1)} disabled={!move(i, -1, true)} title={t('src.toPrevBlock')}>⇧</button>
                    <button onClick={() => move(i, +1)} disabled={!move(i, +1, true)} title={t('src.toNextBlock')}>⇩</button>
                  </>
                )}
                <button onClick={() => setOpen(advanced ? null : i)} title={t('src.more')}>⋯</button>
                <IconButton action="remove" danger onClick={() => set(streams.filter((_, j) => j !== i))} />
              </div>
            </div>

            {missing && <div className="hint" style={{ color: 'var(--warn)', marginTop: 2 }}>{t('src.missing')}</div>}

            {advanced && (
              <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                {/* Real fields, rarely touched. Kept out of the way rather than
                    removed: someone needs each of them once a year. */}
                <label className="src-adv">{t('src.duration')}
                  <input value={s.Duration ?? ''} placeholder="sec"
                         onChange={(e) => setAt(i, { ...s, Duration: e.target.value || undefined })} />
                </label>
                <label className="src-adv">{t('src.offset')}
                  <input value={s.Offset ?? ''} placeholder="sec"
                         onChange={(e) => setAt(i, { ...s, Offset: e.target.value || undefined })} />
                </label>
                <label className="src-adv">{t('src.totalDuration')}
                  <input value={s.TotalDuration ?? ''} placeholder="sec"
                         onChange={(e) => setAt(i, { ...s, TotalDuration: e.target.value || undefined })} />
                </label>
                <label className="src-adv">{t('src.maxIterations')}
                  <input value={s.MaxIterations ?? ''}
                         onChange={(e) => setAt(i, { ...s, MaxIterations: e.target.value || undefined })} />
                </label>
                <label className="src-adv">{t('src.streamTitle')}
                  <input value={s.StreamTitle ?? ''}
                         onChange={(e) => setAt(i, { ...s, StreamTitle: e.target.value || undefined })} />
                </label>
                <label className="src-adv">{t('src.streamUrl')}
                  <input value={s.StreamUrl ?? ''}
                         onChange={(e) => setAt(i, { ...s, StreamUrl: e.target.value || undefined })} />
                </label>
              </div>
            )}
          </div>
        );
      })}

      {/* Dropping past the last row appends, which is otherwise impossible:
          every other target inserts before something. */}
      {streams.length > 0 && (
        <div onDragOver={(e) => e.preventDefault()} onDrop={() => drop(streams.length)}
             style={{ height: 10 }} />
      )}

      {streams.length === 0 && <div className="hint">{t('src.none')}</div>}
    </div>
  );
}
