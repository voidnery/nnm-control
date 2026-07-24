import { Router } from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { Settings } from '../models/Settings.js';
import { wmspanel } from '../services/wmspanelClient.js';
import { preflightWrite } from './transcoderTemplate.js';
import { logEvent } from '../services/audit.js';

export const transcoderEditRouter = Router();
transcoderEditRouter.use(requireAuth);

const cfg = async () => (await Settings.load()).wmspanel;
const pipelinesOf = (tr) => [
  ...(tr.video_pipelines || []).map(p => ({ kind: 'video', p })),
  ...(tr.audio_pipelines || []).map(p => ({ kind: 'audio', p })),
];

// Softvelum documents exactly what may be changed through the API: application
// and stream names on decoders/encoders, and basic parameters of existing
// filters. Everything else in an element (codec, encoder, forward flags,
// keyframe alignment) is undocumented — the PUT may well accept it, but we
// refuse to present it as supported. Callers can still force it, deliberately.
export const DOCUMENTED_FIELDS = {
  input: ['app', 'stream'],
  output: ['app', 'stream'],
  filter: ['params', 'name'],
};

export function classifyChange(io, field) {
  return (DOCUMENTED_FIELDS[io] || []).includes(field) ? 'documented' : 'undocumented';
}

const findElement = (tr, { kind, pipelineId, io, ioId }) => {
  const pack = pipelinesOf(tr).find(x => x.kind === kind && x.p.id === pipelineId);
  return (pack?.p?.[`${io}s`] || []).find(e => e.id === ioId) || null;
};

// Apply edits one element at a time, each guarded: snapshot -> write -> read
// back -> verify -> restore the snapshot if the result is not what was asked
// for. A half-applied scenario is the worst outcome here, so verification is
// not optional and a failure stops the batch.
transcoderEditRouter.post('/transcoders/:id/apply-edits', requirePerm('wmsobjects.manage'), async (req, res) => {
  const id = req.params.id;
  const edits = Array.isArray(req.body?.edits) ? req.body.edits : [];
  const allowUndocumented = Boolean(req.body?.allowUndocumented);
  if (!edits.length) return res.status(400).json({ error: 'No changes to apply' });

  const c = await cfg();
  const steps = [];
  let applied = 0;

  try {
    let tr = (await wmspanel.transcoderGet(c, id)).transcoder;

    // Refuse undocumented fields unless the operator explicitly opted in.
    const blocked = [];
    for (const e of edits) {
      for (const f of Object.keys(e.set || {})) {
        if (classifyChange(e.io, f) === 'undocumented') blocked.push(`${e.io}.${f}`);
      }
    }
    if (blocked.length && !allowUndocumented) {
      return res.status(400).json({
        error: 'These fields are not documented as changeable through the API',
        fields: [...new Set(blocked)],
      });
    }

    // Prove the write path on this very scenario before changing anything.
    const pf = await preflightWrite(c, id, tr);
    steps.push({ step: 'verify element writes', ok: pf.status === 'ok' || pf.status === 'skipped', preflight: pf });
    if (pf.status !== 'ok' && pf.status !== 'skipped') {
      return res.status(502).json({ ok: false, steps, error: `${pf.error} (${pf.status})`, applied: 0 });
    }

    for (const e of edits) {
      const before = findElement(tr, e);
      if (!before) { steps.push({ step: `${e.io} ${e.ioId}`, ok: false, error: 'element not found' }); break; }

      const { id: _drop, ...body } = before;
      Object.assign(body, e.set || {});
      const snapshot = { ...before };

      try {
        await wmspanel.pipelineIoUpdate(c, id, e.kind, e.pipelineId, e.io, e.ioId, body);
        tr = (await wmspanel.transcoderGet(c, id)).transcoder;
        const after = findElement(tr, e);
        const wrong = Object.entries(e.set || {})
          .filter(([k, v]) => JSON.stringify(after?.[k]) !== JSON.stringify(v))
          .map(([k]) => k);

        if (!after || wrong.length) {
          // Put it back exactly as it was; a wrong value live is worse than none.
          const { id: _d2, ...restore } = snapshot;
          await wmspanel.pipelineIoUpdate(c, id, e.kind, e.pipelineId, e.io, e.ioId, restore).catch(() => {});
          steps.push({ step: `${e.io} ${e.ioId}`, ok: false, rolledBack: true,
            error: after ? `stored a different value for: ${wrong.join(', ')}` : 'element disappeared' });
          break;
        }
        applied++;
        steps.push({ step: `${e.io} ${e.ioId}`, ok: true, set: e.set });
      } catch (err) {
        steps.push({ step: `${e.io} ${e.ioId}`, ok: false, error: err.message });
        break;
      }
    }

    const ok = steps.every(s => s.ok);
    logEvent({ req, action: 'transcoder:edit', target: `${id} (${applied}/${edits.length})`,
      outcome: ok ? 'ok' : 'partial', status: 200 });
    res.json({ ok, applied, total: edits.length, steps });
  } catch (e) {
    logEvent({ req, action: 'transcoder:edit', target: id, outcome: 'error', status: 500 });
    res.status(500).json({ ok: false, error: e.message, steps, applied });
  }
});
