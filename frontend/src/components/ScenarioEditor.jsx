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

export default function ScenarioEditor({ transcoderId }) {
  const { t } = useI18n();
  const { push } = useToast();
  const confirm = useConfirm();
  const [graph, setGraph] = useState(null);
  const [edits, setEdits] = useState({});     // key -> { field: value }
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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

  const apply = async () => {
    if (!(await confirm({ message: t('se.confirm', { n: diff.length }) }))) return;
    setBusy(true); setError(''); setReport(null);
    try {
      const r = await api(`/wmspanel/transcoders/${transcoderId}/apply-edits`, {
        method: 'POST', body: { edits: diff.map(({ before, ...d }) => d) },
      });
      setReport(r);
      if (r.ok) { push({ type: 'ok', message: t('se.applied', { n: r.applied }) }); setEdits({}); }
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
        <button onClick={() => { setEdits({}); setReport(null); }} disabled={!diff.length}>{t('se.reset')}</button>
        <button className="primary" disabled={busy || !diff.length} onClick={apply}>
          {busy ? '…' : t('se.apply', { n: diff.length })}
        </button>
      </div>
    </div>
  );
}
