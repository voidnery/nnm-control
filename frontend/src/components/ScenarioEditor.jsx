import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import { useConfirm } from '../confirm.jsx';
import { filterLabel, codecLabel, ioLabel } from '../lib/pipelineLayout.js';
import PipelineBoard, { GNode, GField } from './PipelineBoard.jsx';

// Editing inside the boundary the vendor documents: app/stream on decoders and
// encoders, and parameters of existing filters. Anything else in an element is
// shown but not editable by default — the PUT might accept it, yet presenting
// undocumented fields as supported is how operators end up trusting a change
// that silently does nothing.
const DOCUMENTED = { input: ['app', 'stream'], output: ['app', 'stream'], filter: ['name', 'params'] };

// Forwarding flags sit on inputs and outputs, and the set differs by kind and
// direction — checked against a real pipeline rather than remembered, since a
// video output on this fleet carries forward_sei_timecodes. They are NOT in the
// documented set: the API may store them, but Softvelum does not guarantee it,
// so they are editable only behind an explicit opt-in (see hasUndoc below).
const FWD = {
  input: {
    video: ['forward_scte35', 'forward_dvb_subtitles', 'forward_webvtt_subtitles', 'forward_klv_metadata', 'forward_sei_timecodes', 'forward_dvb_teletext'],
    audio: ['forward_scte35', 'forward_dvb_subtitles', 'forward_webvtt_subtitles', 'forward_klv_metadata', 'forward_metadata'],
  },
  output: {
    video: ['forward_scte35', 'forward_dvb_subtitles', 'forward_webvtt_subtitles', 'forward_klv_metadata', 'forward_cea708', 'forward_sei_timecodes', 'forward_dvb_teletext'],
    audio: ['forward_scte35', 'forward_dvb_subtitles', 'forward_webvtt_subtitles', 'forward_klv_metadata', 'forward_metadata'],
  },
};
const fwdKeys = (io, kind) => (FWD[io] && FWD[io][kind]) || [];

const elementKey = (kind, pipelineId, io, ioId) => `${kind}|${pipelineId}|${io}|${ioId}`;

export default function ScenarioEditor({ transcoderId }) {
  const { t } = useI18n();
  const { push } = useToast();
  const confirm = useConfirm();
  const [graph, setGraph] = useState(null);
  const [edits, setEdits] = useState({});     // key -> { field: value }
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fwdOpen, setFwdOpen] = useState({});  // key -> bool (forwarding block expanded)
  const [allowUndoc, setAllowUndoc] = useState(false);
  const [query, setQuery] = useState('');

  const load = async () => {
    try { setGraph(await api(`/wmspanel/transcoders/${transcoderId}/graph`)); setError(''); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, [transcoderId]);

  // Flat list of every editable element, kept for the diff. The screen itself
  // is drawn per pipeline; this is only the index the diff walks.
  const elements = useMemo(() => {
    if (!graph) return [];
    const out = [];
    for (const [kind, list] of [['video', graph.video || []], ['audio', graph.audio || []]]) {
      for (const p of list) {
        for (const io of ['input', 'filter', 'output']) {
          for (const e of p[`${io}s`] || []) {
            out.push({ key: elementKey(kind, p.id, io, e.id), kind, pipelineId: p.id, io, ioId: e.id, elem: e });
          }
        }
      }
    }
    return out;
  }, [graph]);

  const setField = (key, field, value) => setEdits(v => ({ ...v, [key]: { ...v[key], [field]: value } }));

  // Only fields whose value actually differs make it into the diff.
  const diff = useMemo(() => elements.flatMap(el => {
    const e = edits[el.key];
    if (!e) return [];
    const set = {};
    for (const [f, v] of Object.entries(e)) {
      if (JSON.stringify(v) !== JSON.stringify(el.elem[f] ?? '')) set[f] = v;
    }
    if (!Object.keys(set).length) return [];
    return [{ key: el.key, label: `${el.kind}/${t('se.io.' + el.io)} ${ioLabel(el.elem)}`,
              kind: el.kind, pipelineId: el.pipelineId, io: el.io, ioId: el.ioId, set,
              before: Object.fromEntries(Object.keys(set).map(f => [f, el.elem[f] ?? ''])) }];
  }), [elements, edits, t]);

  const changedKeys = useMemo(() => new Set(diff.map(d => d.key)), [diff]);

  // A change is undocumented when its field is not in the documented set for
  // that element type — today that means the forwarding flags. The backend
  // refuses these unless the request opts in, so surface the opt-in here rather
  // than letting apply fail with a wall of field names.
  const hasUndoc = useMemo(
    () => diff.some(d => Object.keys(d.set).some(f => !(DOCUMENTED[d.io] || []).includes(f))),
    [diff]);

  const apply = async () => {
    if (!(await confirm({ message: t('se.confirm', { n: diff.length }) }))) return;
    setBusy(true); setError(''); setReport(null);
    try {
      const r = await api(`/wmspanel/transcoders/${transcoderId}/apply-edits`, {
        method: 'POST',
        body: { edits: diff.map(({ before, key, label, ...d }) => d), allowUndocumented: hasUndoc && allowUndoc },
      });
      setReport(r);
      if (r.ok) { push({ type: 'ok', message: t('se.applied', { n: r.applied }) }); setEdits({}); setAllowUndoc(false); }
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (error && !graph) return <div className="error-box">{error}</div>;
  if (!graph) return <div className="hint">{t('sd.loading')}</div>;

  // An endpoint node: the two documented fields as real fields, the fixed
  // facts as a caption, and the forwarding flags folded behind a count.
  const endpoint = (kind, pipelineId, io, el) => {
    const key = elementKey(kind, pipelineId, io, el.id);
    const e = edits[key] || {};
    const cur = f => (e[f] ?? el[f] ?? '');
    const keys = fwdKeys(io, kind);
    const curFlag = f => (e[f] ?? el[f]);
    const on = keys.filter(k => curFlag(k)).length;
    const nodeKind = io === 'input' ? 'in' : (kind === 'audio' ? 'out audio' : 'out');
    return (
      <GNode key={key} kind={nodeKind + ' edit'} changed={changedKeys.has(key)}
             role={t('se.io.' + io)}
             aside={io === 'output' ? codecLabel(el) : String(el.type || '')}>
        {DOCUMENTED[io].map(f => (
          <GField key={f} label={f} value={cur(f)} onChange={v => setField(key, f, v)} />
        ))}
        {keys.length > 0 && (
          <div className="gnode-fold">
            <button onClick={() => setFwdOpen(v => ({ ...v, [key]: !v[key] }))}>
              {fwdOpen[key] ? '▾' : '▸'} {t('tc.forwarding')}{on > 0 ? ` · ${on}` : ''}
            </button>
            {fwdOpen[key] && (
              <div className="gnode-flags">
                {keys.map(k => (
                  <label key={k}>
                    <input type="checkbox" checked={Boolean(curFlag(k))}
                           onChange={ev => setField(key, k, ev.target.checked)} />
                    {t('tc.' + k) !== 'tc.' + k ? t('tc.' + k) : k.replace(/^forward_/, '')}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
      </GNode>
    );
  };

  const filterNode = (kind, pipelineId, section, f) => {
    const key = elementKey(kind, pipelineId, 'filter', f.id);
    const e = edits[key] || {};
    const cur = fl => (e[fl] ?? f[fl] ?? '');
    return (
      <GNode key={key} kind={(section === 'split' ? 'split' : 'flt') + ' edit'}
             changed={changedKeys.has(key)}
             role={t('se.io.filter')} aside={String(f.type || '')}>
        <div className="gnode-title mono">{filterLabel(f)}</div>
        {section === 'split'
          ? <div className="hint" style={{ fontSize: 11 }}>{t('se.splitFixed')}</div>
          : DOCUMENTED.filter.map(fl => (
              <GField key={fl} label={fl} value={cur(fl)} onChange={v => setField(key, fl, v)} />
            ))}
      </GNode>
    );
  };

  const match = pl => !query ||
    JSON.stringify([...(pl.inputs || []), ...(pl.outputs || [])]).toLowerCase().includes(query.toLowerCase());
  const video = (graph.video || []).filter(match);
  const audio = (graph.audio || []).filter(match);

  const board = (pl, kind, n) => (
    <PipelineBoard
      key={`${kind}${n}:${pl.id || ''}`} pipeline={pl} kind={kind} index={n} edit
      renderInput={i => endpoint(kind, pl.id, 'input', i)}
      renderFilter={(f, { section }) => filterNode(kind, pl.id, section, f)}
      renderOutput={o => endpoint(kind, pl.id, 'output', o)}
    />
  );

  return (
    <div>
      <p className="hint">{t('se.intro')}</p>
      {error && <div className="error-box">{error}</div>}

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span className="hint">{t('tg.counts', { v: (graph.video || []).length, a: (graph.audio || []).length })}</span>
        <div className="row" style={{ gap: 8 }}>
          <input style={{ maxWidth: 220 }} placeholder={t('tg.filter')}
                 value={query} onChange={e => setQuery(e.target.value)} />
          <button onClick={load} disabled={busy}>{t('action.refresh')}</button>
        </div>
      </div>

      <div style={{ maxHeight: '52vh', overflow: 'auto' }}>
        {video.length > 0 && <div className="gsection">{t('tg.video')}</div>}
        {video.map((pl, n) => board(pl, 'video', n))}
        {audio.length > 0 && <div className="gsection">{t('tg.audio')}</div>}
        {audio.map((pl, n) => board(pl, 'audio', n))}
        {!video.length && !audio.length && (
          <div className="panel hint">{query ? t('tg.noMatch') : t('tc.noPipelines')}</div>
        )}
      </div>

      {diff.length > 0 && (
        <div className="picked-row" style={{ display: 'block', marginTop: 10 }}>
          <span className="picked-tag">{t('se.diff')}</span>
          {diff.map((d, i) => (
            <div key={i} className="mono" style={{ fontSize: 12 }}>
              {d.label}: {Object.keys(d.set).map(f => `${f}: ${d.before[f] || '∅'} → ${d.set[f]}`).join(', ')}
            </div>
          ))}
        </div>
      )}

      {hasUndoc && (
        <div className="panel" style={{ marginTop: 8, borderColor: 'var(--warn, #5c4a2a)' }}>
          <div className="hint">{t('se.undocWarn')}</div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, margin: 0 }}>
            <input type="checkbox" checked={allowUndoc} onChange={e => setAllowUndoc(e.target.checked)} />
            {t('se.undocAck')}
          </label>
        </div>
      )}

      {report && (
        <div className="panel" style={{ marginTop: 10 }}>
          <b>{report.ok ? t('se.done', { n: report.applied }) : t('se.stopped', { n: report.applied })}</b>
          {report.steps?.map((s, i) => (
            <div key={i} className="hint" style={{ fontSize: 12 }}>
              {s.ok ? '✓' : '✗'} {s.step}
              {s.preflight?.status ? ` — ${s.preflight.status}` : ''}
              {s.error ? ` — ${s.error}` : ''}
              {s.rolledBack ? ` · ${t('se.rolledBack')}` : ''}
            </div>
          ))}
        </div>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
        <button onClick={() => { setEdits({}); setReport(null); setAllowUndoc(false); }} disabled={!diff.length}>{t('se.reset')}</button>
        <button className="primary" disabled={busy || !diff.length || (hasUndoc && !allowUndoc)} onClick={apply}>
          {busy ? '…' : t('se.apply', { n: diff.length })}
        </button>
      </div>
    </div>
  );
}
