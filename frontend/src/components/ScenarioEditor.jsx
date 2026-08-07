import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import { useConfirm } from '../confirm.jsx';
import { filterLabel, codecLabel } from '../lib/pipelineLayout.js';

// Editing inside the boundary the vendor documents: app/stream on decoders and
// encoders, and parameters of existing filters. Anything else in an element is
// shown but not editable by default — the PUT might accept it, yet presenting
// undocumented fields as supported is how operators end up trusting a change
// that silently does nothing.
const DOCUMENTED = { input: ['app', 'stream'], output: ['app', 'stream'], filter: ['params', 'name'] };

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

  const load = async () => {
    try { setGraph(await api(`/wmspanel/transcoders/${transcoderId}/graph`)); setError(''); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, [transcoderId]);

  const elements = useMemo(() => {
    if (!graph) return [];
    const out = [];
    for (const [kind, list] of [['video', graph.video || []], ['audio', graph.audio || []]]) {
      for (const p of list) {
        for (const io of ['input', 'filter', 'output']) {
          for (const e of p[`${io}s`] || []) {
            out.push({ key: `${kind}|${p.id}|${io}|${e.id}`, kind, pipelineId: p.id, io, ioId: e.id, elem: e });
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
    return [{ kind: el.kind, pipelineId: el.pipelineId, io: el.io, ioId: el.ioId, set,
              before: Object.fromEntries(Object.keys(set).map(f => [f, el.elem[f] ?? ''])) }];
  }), [elements, edits]);

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
        method: 'POST', body: { edits: diff.map(({ before, ...d }) => d), allowUndocumented: hasUndoc && allowUndoc },
      });
      setReport(r);
      if (r.ok) { push({ type: 'ok', message: t('se.applied', { n: r.applied }) }); setEdits({}); setAllowUndoc(false); }
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (error && !graph) return <div className="error-box">{error}</div>;
  if (!graph) return <div className="hint">{t('sd.loading')}</div>;

  return (
    <div>
      <p className="hint">{t('se.intro')}</p>
      {error && <div className="error-box">{error}</div>}

      <div className="panel" style={{ maxHeight: '48vh', overflow: 'auto' }}>
        <table>
          <thead><tr>
            <th>{t('tw.element')}</th><th>{t('se.editable')}</th><th>{t('se.fixed')}</th>
          </tr></thead>
          <tbody>
            {elements.map(el => {
              const fields = DOCUMENTED[el.io] || [];
              const e = edits[el.key] || {};
              const fixed = el.io === 'output' ? codecLabel(el.elem)
                : el.io === 'filter' ? String(el.elem.type || '')
                : String(el.elem.type || '');
              const keys = fwdKeys(el.io, el.kind);
              const cur = f => (edits[el.key]?.[f] ?? el.elem[f]);
              const on = keys.filter(k => cur(k)).length;
              return (
                <tr key={el.key}>
                  <td>
                    <span className="badge">{el.kind}</span>{' '}
                    <span className="hint">{t('se.io.' + el.io)}</span>
                    {el.io === 'filter' && <div className="hint mono" style={{ fontSize: 11 }}>{filterLabel(el.elem)}</div>}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {fields.map(f => (
                        <label key={f} style={{ margin: 0, fontSize: 11 }}>
                          {f}
                          <input className="mono" style={{ width: 150, fontSize: 12 }}
                                 value={e[f] ?? el.elem[f] ?? ''}
                                 onChange={ev => setField(el.key, f, ev.target.value)} />
                        </label>
                      ))}
                      {!fields.length && <span className="hint">—</span>}
                    </div>
                    {keys.length > 0 && (
                      <div style={{ marginTop: 6 }}>
                        <button style={{ fontSize: 11 }}
                                onClick={() => setFwdOpen(v => ({ ...v, [el.key]: !v[el.key] }))}>
                          {t('tc.forwarding')}{on > 0 ? ` · ${on}` : ''} {fwdOpen[el.key] ? '▾' : '▸'}
                        </button>
                        {fwdOpen[el.key] && (
                          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 4, marginTop: 4 }}>
                            {keys.map(k => (
                              <label key={k} style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0, fontSize: 11 }}>
                                <input type="checkbox" checked={Boolean(cur(k))}
                                       onChange={ev => setField(el.key, k, ev.target.checked)} />
                                {t('tc.' + k) !== 'tc.' + k ? t('tc.' + k) : k.replace(/^forward_/, '')}
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="hint" style={{ fontSize: 12 }}>{fixed || '—'}</td>
                </tr>
              );
            })}
            {!elements.length && <tr><td colSpan={3} className="hint">{t('tc.noPipelines')}</td></tr>}
          </tbody>
        </table>
      </div>

      {diff.length > 0 && (
        <div className="picked-row" style={{ display: 'block', marginTop: 10 }}>
          <span className="picked-tag">{t('se.diff')}</span>
          {diff.map((d, i) => (
            <div key={i} className="mono" style={{ fontSize: 12 }}>
              {d.kind}/{d.io}: {Object.keys(d.set).map(f => `${f}: ${d.before[f] || '∅'} → ${d.set[f]}`).join(', ')}
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
