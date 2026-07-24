import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import Modal from './Modal.jsx';
import { ioLabel, codecLabel } from '../lib/pipelineLayout.js';

// Build a new scenario from an existing one, staying inside what the API can
// actually persist: clone, retarget decoder/encoder app+stream, name it, and
// optionally push it to more servers. Authoring new pipelines is not possible
// through the API at all, and the wizard says so rather than pretending.
export default function TemplateWizard({ template, servers, onClose, onCreated }) {
  const { t } = useI18n();
  const { push } = useToast();
  const [graph, setGraph] = useState(null);
  const [name, setName] = useState(`${template.name} copy`);
  const [rewrites, setRewrites] = useState({});     // "kind|pipelineId|io|ioId" -> {app, stream}
  const [targets, setTargets] = useState([]);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api(`/wmspanel/transcoders/${template.id}/graph`).then(setGraph).catch(e => setError(e.message));
  }, [template.id]);

  const elements = useMemo(() => {
    if (!graph) return [];
    const out = [];
    for (const [kind, list] of [['video', graph.video || []], ['audio', graph.audio || []]]) {
      for (const p of list) {
        for (const io of ['input', 'output']) {
          for (const e of p[`${io}s`] || []) {
            out.push({ key: `${kind}|${p.id}|${io}|${e.id}`, kind, pipelineId: p.id, io, ioId: e.id, elem: e });
          }
        }
      }
    }
    return out;
  }, [graph]);

  const setField = (key, field, value) =>
    setRewrites(r => ({ ...r, [key]: { ...r[key], [field]: value } }));

  // Only elements the operator actually changed are sent.
  const changes = useMemo(() => elements.flatMap(el => {
    const r = rewrites[el.key];
    if (!r) return [];
    const app = r.app ?? el.elem.app;
    const stream = r.stream ?? el.elem.stream;
    if (app === el.elem.app && stream === el.elem.stream) return [];
    return [{ kind: el.kind, pipelineId: el.pipelineId, io: el.io, ioId: el.ioId, app, stream,
              from: `${el.elem.app}/${el.elem.stream}`, to: `${app}/${stream}` }];
  }), [elements, rewrites]);

  const run = async () => {
    setBusy(true); setError(''); setReport(null);
    try {
      const body = {
        name, rewrites: changes.map(({ from, to, ...c }) => c),
        serversToApply: targets,
      };
      const r = await api(`/wmspanel/transcoders/${template.id}/from-template`, { method: 'POST', body });
      setReport(r);
      push({ type: 'ok', message: t('tw.created') });
      onCreated?.();
    } catch (e) {
      // The orchestrator returns its step list even on failure; keep it visible.
      setError(e.message);
      if (e.body) setReport(e.body);
    } finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} size="xwide">
      <h3>{t('tw.title', { name: template.name })}</h3>
      <p className="hint">{t('tw.intro')}</p>
      {error && <div className="error-box">{error}</div>}

      {!graph ? <div className="hint">{t('sd.loading')}</div> : (
        <div style={{ maxHeight: '62vh', overflow: 'auto' }}>
          <label>{t('tw.name')}</label>
          <input value={name} onChange={e => setName(e.target.value)} />

          <div className="gsection">{t('tw.retarget')}</div>
          <div className="hint" style={{ marginBottom: 6 }}>{t('tw.retargetHint')}</div>
          <div className="panel">
            <table>
              <thead><tr>
                <th>{t('tw.element')}</th><th>{t('tw.current')}</th><th>app</th><th>stream</th>
              </tr></thead>
              <tbody>
                {elements.map(el => {
                  const r = rewrites[el.key] || {};
                  return (
                    <tr key={el.key}>
                      <td>
                        <span className="badge">{el.kind}</span>{' '}
                        <span className="hint">{el.io === 'input' ? t('tg.source') : t('tg.encoders')}</span>
                        {el.io === 'output' && <div className="hint">{codecLabel(el.elem)}</div>}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>{ioLabel(el.elem)}</td>
                      <td><input className="mono" value={r.app ?? el.elem.app ?? ''}
                                 onChange={e => setField(el.key, 'app', e.target.value)} /></td>
                      <td><input className="mono" value={r.stream ?? el.elem.stream ?? ''}
                                 onChange={e => setField(el.key, 'stream', e.target.value)} /></td>
                    </tr>
                  );
                })}
                {elements.length === 0 && <tr><td colSpan={4} className="hint">{t('tc.noPipelines')}</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="gsection">{t('tw.apply')}</div>
          <div className="hint" style={{ marginBottom: 6 }}>{t('tw.applyHint')}</div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {servers.filter(s => s.wmspanelServerId).map(s => (
              <button key={s.id}
                      className={'tagchip' + (targets.includes(s.wmspanelServerId) ? ' on' : '')}
                      onClick={() => setTargets(ts => ts.includes(s.wmspanelServerId)
                        ? ts.filter(x => x !== s.wmspanelServerId) : [...ts, s.wmspanelServerId])}>
                {s.name}
              </button>
            ))}
          </div>

          {(changes.length > 0 || targets.length > 0) && (
            <div className="picked-row" style={{ display: 'block', marginTop: 12 }}>
              <span className="picked-tag">{t('tw.preview')}</span>
              {changes.map((c, i) => (
                <div key={i} className="mono" style={{ fontSize: 12 }}>{c.from} → {c.to}</div>
              ))}
              {targets.length > 0 && <div className="hint">{t('tw.willApply', { n: targets.length })}</div>}
            </div>
          )}

          {report && (
            <div className="panel" style={{ marginTop: 12 }}>
              <b>{report.ok ? t('tw.done') : t('tw.failed')}</b>
              {report.steps?.map((s, i) => (
                <div key={i} className="hint" style={{ fontSize: 12 }}>
                  {s.ok ? '✓' : '✗'} {s.step}{s.error ? ` — ${s.error}` : ''}
                  {s.preflight?.verified ? ` (${s.preflight.verified})` : ''}
                  {s.target ? ` → ${s.target}` : ''}
                </div>
              ))}
              {report.transcoderId && (
                <div className="hint" style={{ marginTop: 4 }}>{t('tw.leftPaused', { id: report.transcoderId })}</div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onClose}>{t('action.close')}</button>
        <button className="primary" disabled={busy || !graph || !name.trim()} onClick={run}>
          {busy ? '…' : t('tw.create')}
        </button>
      </div>
    </Modal>
  );
}
