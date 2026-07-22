import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import { useConfirm } from '../confirm.jsx';
import Select from './Select.jsx';

// Transcoder pipeline editor, built from the real WMSPanel schema
// (GET /transcoder/{id}?details=true → video_pipelines[] / audio_pipelines[]).
// Edits input/filter/output via PUT; deletes sub-objects and pipelines.
// Field sets differ between video and audio (see FORWARD_* below).

const FWD_VIDEO_IN = ['forward_scte35', 'forward_dvb_subtitles', 'forward_webvtt_subtitles', 'forward_klv_metadata', 'forward_sei_timecodes', 'forward_dvb_teletext'];
const FWD_AUDIO_IN = ['forward_scte35', 'forward_dvb_subtitles', 'forward_webvtt_subtitles', 'forward_klv_metadata', 'forward_metadata'];
const FWD_VIDEO_OUT = ['forward_scte35', 'forward_dvb_subtitles', 'forward_webvtt_subtitles', 'forward_klv_metadata', 'forward_cea708', 'forward_dvb_teletext'];
const FWD_AUDIO_OUT = ['forward_scte35', 'forward_dvb_subtitles', 'forward_webvtt_subtitles', 'forward_klv_metadata', 'forward_metadata'];

const VIDEO_CODECS = ['h264', 'hevc', 'hevc_nvenc', 'h264_nvenc', 'av1', 'passthrough'];
const AUDIO_CODECS = ['AAC', 'MP3', 'AC3', 'Opus', 'passthrough'];
const ENCODERS = ['FFmpeg', 'libx264', 'libx265', 'NVENC'];

function Toggles({ obj, keys, onChange }) {
  const { t } = useI18n();
  return (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 4 }}>
      {keys.map(k => (
        <label key={k} style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0, fontSize: 12 }}>
          <input type="checkbox" checked={Boolean(obj[k])} onChange={e => onChange(k, e.target.checked)} />
          {t('tc.' + k, {}) !== 'tc.' + k ? t('tc.' + k) : k}
        </label>
      ))}
    </div>
  );
}

function ParamsEditor({ params, onChange }) {
  const { t } = useI18n();
  const list = params || [];
  return (
    <div>
      <label>{t('tc.params')}</label>
      {list.map((p, i) => (
        <div className="row" key={i} style={{ marginBottom: 4 }}>
          <input className="mono" style={{ flex: 1 }} placeholder="name" value={p.name}
                 onChange={e => onChange(list.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
          <input className="mono" style={{ flex: 1 }} placeholder="value" value={p.value}
                 onChange={e => onChange(list.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
          <button className="danger" onClick={() => onChange(list.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button onClick={() => onChange([...list, { name: '', value: '' }])}>+ {t('tc.addParam')}</button>
    </div>
  );
}

function IoCard({ tid, kind, pid, io, obj, onSaved, onDeleted }) {
  const { t } = useI18n();
  const { push } = useToast();
  const confirm = useConfirm();
  const [d, setD] = useState(obj);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setD(x => ({ ...x, [k]: v }));
  const isVideo = kind === 'video';

  const save = async () => {
    setBusy(true);
    try {
      const { id, ...body } = d;
      await api(`/wmspanel/transcoders/${tid}/pipeline/${kind}/${pid}/${io}/${id}`, { method: 'PUT', body });
      push({ type: 'ok', message: t('tc.saved') });
      onSaved?.();
    } catch (e) { push({ type: 'error', message: e.message }); }
    finally { setBusy(false); }
  };
  const del = async () => {
    if (!(await confirm({ danger: true, message: t('tc.deleteIo', { io }) }))) return;
    try { await api(`/wmspanel/transcoders/${tid}/pipeline/${kind}/${pid}/${io}/${d.id}`, { method: 'DELETE' }); onDeleted?.(); }
    catch (e) { push({ type: 'error', message: e.message }); }
  };

  return (
    <div className="panel" style={{ background: 'var(--bg-raise)', marginBottom: 6 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>{t('tc.' + io)}{d.main ? ` · ${t('tc.main')}` : ''} <span className="hint mono">{d.app}/{d.stream}</span></b>
        <div className="row"><button disabled={busy} onClick={save}>{t('action.save')}</button><button className="danger" onClick={del}>{t('action.delete')}</button></div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', marginTop: 8 }}>
        <div><label>app</label><input value={d.app || ''} onChange={e => set('app', e.target.value)} /></div>
        <div><label>stream</label><input value={d.stream || ''} onChange={e => set('stream', e.target.value)} /></div>

        {io === 'input' && (
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
              <input type="checkbox" checked={Boolean(d.main)} onChange={e => set('main', e.target.checked)} /> {t('tc.main')}
            </label>
          </div>
        )}

        {io === 'output' && <>
          <div><label>{t('tc.codec')}</label>
            <Select value={d.codec} onChange={v => set('codec', v)}
                    options={(isVideo ? VIDEO_CODECS : AUDIO_CODECS).map(c => ({ value: c, label: c }))} /></div>
          <div><label>{t('tc.encoder')}</label>
            <Select value={d.encoder} onChange={v => set('encoder', v)}
                    options={ENCODERS.map(c => ({ value: c, label: c }))} /></div>
          {isVideo && <div><label>key_frame_alignment</label>
            <Select value={d.key_frame_alignment || 'fps'} onChange={v => set('key_frame_alignment', v)}
                    options={['fps', 'gop', 'time'].map(c => ({ value: c, label: c }))} /></div>}
          {isVideo && <div><label>key_frame_alignment_value</label>
            <input type="number" value={d.key_frame_alignment_value ?? ''} onChange={e => set('key_frame_alignment_value', e.target.value === '' ? null : Number(e.target.value))} /></div>}
        </>}

        {io === 'filter' && <>
          <div><label>type</label><input value={d.type || ''} onChange={e => set('type', e.target.value)} /></div>
          {isVideo && <div><label>name</label><input value={d.name || ''} onChange={e => set('name', e.target.value)} /></div>}
          {isVideo && <div><label>params</label><input className="mono" value={d.params || ''} onChange={e => set('params', e.target.value)} /></div>}
          {!isVideo && <div><label>outputs_number</label><input type="number" value={d.outputs_number ?? ''} onChange={e => set('outputs_number', e.target.value === '' ? null : Number(e.target.value))} /></div>}
          {isVideo && d.type === 'picture' && <>
            <div><label>filename</label><input value={d.filename || ''} onChange={e => set('filename', e.target.value)} /></div>
            <div><label>width</label><input type="number" value={d.width ?? ''} onChange={e => set('width', Number(e.target.value))} /></div>
            <div><label>x</label><input type="number" value={d.x ?? ''} onChange={e => set('x', Number(e.target.value))} /></div>
            <div><label>y</label><input type="number" value={d.y ?? ''} onChange={e => set('y', Number(e.target.value))} /></div>
          </>}
        </>}
      </div>

      {io === 'output' && d.params !== undefined && Array.isArray(d.params) && (
        <div style={{ marginTop: 8 }}><ParamsEditor params={d.params} onChange={v => set('params', v)} /></div>
      )}

      {io !== 'filter' && (
        <div style={{ marginTop: 8 }}>
          <Toggles obj={d} keys={io === 'input' ? (isVideo ? FWD_VIDEO_IN : FWD_AUDIO_IN) : (isVideo ? FWD_VIDEO_OUT : FWD_AUDIO_OUT)} onChange={set} />
        </div>
      )}
    </div>
  );
}

function Pipeline({ tid, kind, pl, reload }) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const { push } = useToast();
  const [open, setOpen] = useState(false);
  const delPipeline = async () => {
    if (!(await confirm({ danger: true, message: t('tc.deletePipeline') }))) return;
    try { await api(`/wmspanel/transcoders/${tid}/pipeline/${kind}/${pl.id}`, { method: 'DELETE' }); reload(); }
    catch (e) { push({ type: 'error', message: e.message }); }
  };
  return (
    <div className="panel" style={{ marginBottom: 8, borderColor: kind === 'video' ? 'var(--accent-dim)' : 'var(--line)' }}>
      <div className="row" style={{ justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <b>{kind === 'video' ? '🎬' : '🔊'} {t('tc.pipeline.' + kind)} <span className="hint mono">
          {(pl.inputs || []).length}in · {(pl.filters || []).length}flt · {(pl.outputs || []).length}out</span></b>
        <div className="row" onClick={e => e.stopPropagation()}>
          <button className="danger" onClick={delPipeline}>{t('tc.deletePipeline.btn')}</button>
          <span className="caret">{open ? '▲' : '▼'}</span>
        </div>
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          <b className="hint">{t('tc.inputs')}</b>
          {(pl.inputs || []).map(io => <IoCard key={io.id} tid={tid} kind={kind} pid={pl.id} io="input" obj={io} onSaved={reload} onDeleted={reload} />)}
          <b className="hint">{t('tc.filters')}</b>
          {(pl.filters || []).map(io => <IoCard key={io.id} tid={tid} kind={kind} pid={pl.id} io="filter" obj={io} onSaved={reload} onDeleted={reload} />)}
          {(pl.filters || []).length === 0 && <div className="hint" style={{ fontSize: 12 }}>—</div>}
          <b className="hint">{t('tc.outputs')}</b>
          {(pl.outputs || []).map(io => <IoCard key={io.id} tid={tid} kind={kind} pid={pl.id} io="output" obj={io} onSaved={reload} onDeleted={reload} />)}
        </div>
      )}
    </div>
  );
}

export default function PipelineEditor({ transcoderId, onClose }) {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = () => api(`/wmspanel/transcoders/${transcoderId}`).then(d => setData(d.transcoder || d)).catch(e => setError(e.message));
  useEffect(() => { load(); }, [transcoderId]);

  const vpls = data?.video_pipelines || [];
  const apls = data?.audio_pipelines || [];

  return (
    <div>
      {error && <div className="error-box">{error}</div>}
      {!data ? <div className="hint">Loading…</div> : (
        <div>
          <div className="hint" style={{ marginBottom: 8 }}>
            {t('tc.pipelineIntro')} · {vpls.length} video · {apls.length} audio
          </div>
          {vpls.length === 0 && apls.length === 0 && <div className="hint">{t('tc.noPipelines')}</div>}
          {vpls.map(pl => <Pipeline key={pl.id} tid={transcoderId} kind="video" pl={pl} reload={load} />)}
          {apls.map(pl => <Pipeline key={pl.id} tid={transcoderId} kind="audio" pl={pl} reload={load} />)}
        </div>
      )}
    </div>
  );
}
