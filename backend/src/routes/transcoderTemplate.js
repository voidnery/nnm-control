import { Router } from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { Settings } from '../models/Settings.js';
import { wmspanel } from '../services/wmspanelClient.js';
import { logEvent } from '../services/audit.js';

export const transcoderTemplateRouter = Router();
transcoderTemplateRouter.use(requireAuth);

const cfg = async () => (await Settings.load()).wmspanel;
const pipelinesOf = (tr) => [
  ...(tr.video_pipelines || []).map(p => ({ kind: 'video', p })),
  ...(tr.audio_pipelines || []).map(p => ({ kind: 'audio', p })),
];

// Element writes (PUT .../input|output/{id}) had never been exercised against
// the live API. Rather than asking an operator to test by hand, the wizard
// proves the path on the fresh clone before touching anything that matters:
// read an element, write it back unchanged, read again and compare. A no-op is
// safe on a paused copy, and if the API rejects or mangles it we stop with its
// actual response instead of corrupting a scenario halfway through.
export async function preflightWrite(c, id, tr) {   // exported for tests
  const first = pipelinesOf(tr).find(({ p }) => (p.inputs || []).length);
  if (!first) return { status: 'skipped', reason: 'the clone has no elements to verify against' };

  const { kind, p } = first;
  const before = p.inputs[0];
  const { id: elemId, ...body } = before;
  try {
    await wmspanel.pipelineIoUpdate(c, id, kind, p.id, 'input', elemId, body);
  } catch (e) {
    return { status: 'rejected', error: e.message, sent: Object.keys(body) };
  }
  const after = (await wmspanel.transcoderGet(c, id)).transcoder;
  const check = pipelinesOf(after).find(x => x.p.id === p.id)?.p?.inputs?.find(i => i.id === elemId);
  if (!check) return { status: 'lost', error: 'the element disappeared after writing it back unchanged' };

  const drifted = Object.keys(body).filter(k => JSON.stringify(check[k]) !== JSON.stringify(before[k]));
  return drifted.length
    ? { status: 'drift', drifted, error: 'the API stored something different from what was sent' }
    : { status: 'ok', verified: `${kind}/${p.id}/input/${elemId}` };
}

// Clone a scenario, retarget its inputs/outputs, name it, and optionally push it
// to more servers. Reported step by step: a half-applied scenario must be
// visible, not guessed at.
transcoderTemplateRouter.post('/transcoders/:id/from-template', requirePerm('wmsobjects.manage'), async (req, res) => {
  const { name, description, tags, rewrites = [], serversToApply = [], skipPreflight = false } = req.body || {};
  const steps = [];
  const c = await cfg();
  let newId = null;

  const step = (name_, fn) => fn().then(
    (detail) => { steps.push({ step: name_, ok: true, ...(detail || {}) }); return detail; },
    (e) => { steps.push({ step: name_, ok: false, error: e.message }); throw e; },
  );

  try {
    const cloned = await step('clone', async () => {
      const r = await wmspanel.transcoderClone(c, req.params.id);
      newId = r?.transcoder?.id || r?.id || null;
      if (!newId) throw new Error('clone succeeded but the API returned no id for the copy');
      return { transcoderId: newId };
    });

    let tr = await step('read clone', async () => {
      const d = await wmspanel.transcoderGet(c, newId);
      return { pipelines: pipelinesOf(d.transcoder).length, _tr: d.transcoder };
    });
    tr = tr._tr;

    if (rewrites.length && !skipPreflight) {
      const pf = await step('verify element writes', async () => {
        const r = await preflightWrite(c, newId, tr);
        if (r.status !== 'ok' && r.status !== 'skipped') {
          const err = new Error(`${r.error} (${r.status})`);
          err.preflight = r;
          throw err;
        }
        return { preflight: r };
      });
      void pf;
    }

    for (const rw of rewrites) {
      await step(`retarget ${rw.kind}/${rw.io}`, async () => {
        const pack = pipelinesOf(tr).find(x => x.p.id === rw.pipelineId);
        const list = pack?.p?.[`${rw.io}s`] || [];
        const elem = list.find(e => e.id === rw.ioId);
        if (!elem) throw new Error('element not found on the clone');
        const { id: _drop, ...body } = elem;
        if (rw.app !== undefined) body.app = rw.app;
        if (rw.stream !== undefined) body.stream = rw.stream;
        await wmspanel.pipelineIoUpdate(c, newId, rw.kind, rw.pipelineId, rw.io, rw.ioId, body);
        return { target: `${body.app}/${body.stream}` };
      });
    }

    if (name || description !== undefined || tags || serversToApply.length) {
      await step('name and apply', async () => {
        const patch = {};
        if (name) patch.name = String(name);
        if (description !== undefined) patch.description = String(description);
        if (Array.isArray(tags)) patch.tags = tags;
        // Documented by the vendor: pushes the scenario to further servers.
        if (serversToApply.length) patch.servers_to_apply = serversToApply;
        await wmspanel.transcoderUpdate(c, null, newId, patch);
        return { servers: serversToApply.length || undefined };
      });
    }

    const final = await step('verify result', async () => {
      const d = await wmspanel.transcoderGet(c, newId);
      const t = d.transcoder;
      const targets = pipelinesOf(t).flatMap(({ p }) =>
        (p.outputs || []).map(o => `${o.app}/${o.stream}`));
      return { name: t.name, paused: Boolean(t.paused), outputs: targets };
    });

    logEvent({ req, action: 'transcoder:from_template',
      target: `${req.params.id} → ${newId} (${final.name})`, outcome: 'ok', status: 200 });
    res.json({ ok: true, transcoderId: newId, steps, result: final });
  } catch (e) {
    logEvent({ req, action: 'transcoder:from_template',
      target: `${req.params.id}${newId ? ` → ${newId}` : ''}`, outcome: 'error', status: 500 });
    // The clone is left in place on purpose: it is paused and inspectable, and
    // deleting it would destroy the evidence of what went wrong.
    res.status(500).json({
      ok: false, transcoderId: newId, steps, error: e.message,
      preflight: e.preflight || null,
    });
  }
});
