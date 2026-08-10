import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { useToast } from '../toast.jsx';
import Modal from './Modal.jsx';
import { ioLabel, codecLabel, filterLabel } from '../lib/pipelineLayout.js';
import PipelineBoard, { GNode, GField } from './PipelineBoard.jsx';

// Build a new scenario from an existing one, staying inside what the API can
// actually persist: clone, retarget decoder/encoder app+stream, name it, and
// optionally push it to more servers. Authoring new pipelines is not possible
// through the API at all, and the wizard says so rather than pretending.
//
// Laid out as the scenario it is copying, for the same reason the editor is:
// a flat table of eight "Source" rows says nothing about which pipeline each
// one feeds, and this dialog is where retargeting the wrong one silently
// creates a second scenario writing over the first one's output.
const elementKey = (kind, pipelineId, io, ioId) => `${kind}|${pipelineId}|${io}|${ioId}`;

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
  const [bulkInApp, setBulkInApp] = useState('');
  const [bulkOutApp, setBulkOutApp] = useState('');
  const [bulkSuffix, setBulkSuffix] = useState('');

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
            out.push({ key: elementKey(kind, p.id, io, e.id), kind, pipelineId: p.id, io, ioId: e.id, elem: e });
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
    return [{ key: el.key, kind: el.kind, pipelineId: el.pipelineId, io: el.io, ioId: el.ioId, app, stream,
              from: `${el.elem.app}/${el.elem.stream}`, to: `${app}/${stream}` }];
  }), [elements, rewrites]);

  const changedKeys = useMemo(() => new Set(changes.map(c => c.key)), [changes]);

  // Bulk helpers write into the same per-element fields the operator can see
  // and correct. Nothing is applied invisibly at submit time: what the boards
  // show is what gets sent.
  const bulk = (io, mutate) => setRewrites(r => {
    const next = { ...r };
    for (const el of elements.filter(e => e.io === io)) {
      const cur = next[el.key] || {};
      next[el.key] = mutate({ app: cur.app ?? el.elem.app ?? '', stream: cur.stream ?? el.elem.stream ?? '' });
    }
    return next;
  });

  const run = async () => {
    setBusy(true); setError(''); setReport(null);
    try {
      const body = {
        name, rewrites: changes.map(({ from, to, key, ...c }) => c),
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

  const endpoint = (kind, pipelineId, io, el) => {
    const key = elementKey(kind, pipelineId, io, el.id);
    const r = rewrites[key] || {};
    const nodeKind = io === 'input' ? 'in' : (kind === 'audio' ? 'out audio' : 'out');
    const untargetable = !el.app && !el.stream;
    return (
      <GNode key={key} kind={nodeKind + ' edit'} changed={changedKeys.has(key)}
             role={io === 'input' ? t('tg.source') : t('tg.encoders')}
             aside={io === 'output' ? codecLabel(el) : String(el.type || '')}>
        <div className="gnode-from mono">{ioLabel(el)}</div>
        <GField label="app" value={r.app ?? el.app ?? ''} onChange={v => setField(key, 'app', v)} />
        <GField label="stream" value={r.stream ?? el.stream ?? ''} onChange={v => setField(key, 'stream', v)} />
        {untargetable && <div className="hint" style={{ fontSize: 10 }}>{t('tw.noTarget')}</div>}
      </GNode>
    );
  };

  const board = (pl, kind, n) => (
    <PipelineBoard
      key={`${kind}${n}:${pl.id || ''}`} pipeline={pl} kind={kind} index={n} edit
      renderInput={i => endpoint(kind, pl.id, 'input', i)}
      renderFilter={(f, { section, index: fn }) => (
        <GNode key={`${section}${fn}`} kind={(section === 'split' ? 'split' : 'flt') + ' copied'}
               role={t('tw.copied')} aside={String(f.type || '')}>
          <div className="gnode-title mono">{filterLabel(f)}</div>
        </GNode>
      )}
      renderOutput={o => endpoint(kind, pl.id, 'output', o)}
    />
  );

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

          <div className="panel gbulk">
            <div className="gbulk-h">{t('tw.bulk')}</div>
            <div className="hint" style={{ fontSize: 11, marginBottom: 6 }}>{t('tw.bulkHint')}</div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <label className="gfield">
                <span>{t('tw.bulkInApp')}</span>
                <input className="mono" value={bulkInApp} onChange={e => setBulkInApp(e.target.value)} />
              </label>
              <button disabled={!bulkInApp.trim()}
                      onClick={() => bulk('input', v => ({ ...v, app: bulkInApp.trim() }))}>{t('action.apply')}</button>
              <label className="gfield">
                <span>{t('tw.bulkOutApp')}</span>
                <input className="mono" value={bulkOutApp} onChange={e => setBulkOutApp(e.target.value)} />
              </label>
              <button disabled={!bulkOutApp.trim()}
                      onClick={() => bulk('output', v => ({ ...v, app: bulkOutApp.trim() }))}>{t('action.apply')}</button>
              <label className="gfield">
                <span>{t('tw.bulkSuffix')}</span>
                <input className="mono" value={bulkSuffix} onChange={e => setBulkSuffix(e.target.value)} />
              </label>
              <button disabled={!bulkSuffix.trim()}
                      onClick={() => bulk('output', v => ({ ...v, stream: v.stream + bulkSuffix.trim() }))}>{t('action.apply')}</button>
            </div>
          </div>

          {(graph.video || []).map((pl, n) => board(pl, 'video', n))}
          {(graph.audio || []).map((pl, n) => board(pl, 'audio', n))}
          {!(graph.video || []).length && !(graph.audio || []).length && (
            <div className="panel hint">{t('tc.noPipelines')}</div>
          )}

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
