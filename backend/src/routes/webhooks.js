import crypto from 'node:crypto';
import { Router } from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { WebhookSubscription, WebhookDelivery } from '../models/Webhook.js';
import { logEvent } from '../services/audit.js';
import { EVENT_TYPES, emit, actorOf } from '../services/events.js';
import { checkUrl } from '../services/webhooks.js';

// Webhook subscriptions from the panel (evt/1; docs/api/PROPOSAL-nnm-api-1.md §3.1). The signing
// secret is shown ONCE, in the answer to the creation; afterwards only that it exists.
export const webhooksRouter = Router();
webhooksRouter.use(requireAuth);
webhooksRouter.use(requirePerm('webhooks.manage'));

const pub = (s) => ({
  id: String(s._id), name: s.name, url: s.url, types: s.types, allowHttp: s.allowHttp, enabled: s.enabled,
  consecutiveFailures: s.consecutiveFailures, disabledReason: s.disabledReason,
  createdBy: s.createdBy, createdAt: s.createdAt,
});

const cleanTypes = (types) => {
  const list = (Array.isArray(types) ? types : []).map(String);
  const bad = list.filter(t => !EVENT_TYPES.includes(t) && !(t.endsWith('.*') && EVENT_TYPES.some(e => e.startsWith(t.slice(0, -1)))));
  return { list: [...new Set(list)], bad };
};

webhooksRouter.get('/types', (_req, res) => res.json(EVENT_TYPES));

webhooksRouter.get('/', async (_req, res) => {
  res.json((await WebhookSubscription.find().sort({ createdAt: -1 })).map(pub));
});

webhooksRouter.post('/', async (req, res) => {
  const { name, url, types, allowHttp = false } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'name required', code: 'name_required' });
  const u = checkUrl(url, { allowHttp: Boolean(allowHttp) });
  if (!u.ok) return res.status(422).json({ error: u.why, code: 'bad_url' });
  const t = cleanTypes(types);
  if (t.bad.length) return res.status(422).json({ error: `unknown event types: ${t.bad.join(', ')}`, code: 'bad_types' });
  const secret = crypto.randomBytes(32).toString('hex');
  const s = await WebhookSubscription.create({
    name: String(name).trim(), url: u.url.toString(), secret, types: t.list, allowHttp: Boolean(allowHttp),
    createdBy: req.user.username,
  });
  logEvent({ req, action: 'webhook:create', target: `${s.name} → ${s.url}`, outcome: 'ok', status: 201 });
  res.status(201).json({ ...pub(s), secret });
});

webhooksRouter.put('/:id', async (req, res) => {
  const s = await WebhookSubscription.findById(req.params.id).catch(() => null);
  if (!s) return res.status(404).json({ error: 'subscription not found', code: 'not_found' });
  const b = req.body || {};
  if (b.name !== undefined) s.name = String(b.name).trim() || s.name;
  if (b.allowHttp !== undefined) s.allowHttp = Boolean(b.allowHttp);
  if (b.url !== undefined || b.allowHttp !== undefined) {
    const u = checkUrl(b.url ?? s.url, { allowHttp: s.allowHttp });
    if (!u.ok) return res.status(422).json({ error: u.why, code: 'bad_url' });
    s.url = u.url.toString();
  }
  if (b.types !== undefined) {
    const t = cleanTypes(b.types);
    if (t.bad.length) return res.status(422).json({ error: `unknown event types: ${t.bad.join(', ')}`, code: 'bad_types' });
    s.types = t.list;
  }
  if (b.enabled !== undefined) {
    s.enabled = Boolean(b.enabled);
    if (s.enabled) { s.consecutiveFailures = 0; s.disabledReason = ''; }
  }
  await s.save();
  res.json(pub(s));
});

webhooksRouter.delete('/:id', async (req, res) => {
  const s = await WebhookSubscription.findByIdAndDelete(req.params.id).catch(() => null);
  if (!s) return res.status(404).json({ error: 'subscription not found', code: 'not_found' });
  logEvent({ req, action: 'webhook:delete', target: s.name, outcome: 'ok', status: 200 });
  res.json({ ok: true });
});

webhooksRouter.get('/:id/deliveries', async (req, res) => {
  const list = await WebhookDelivery.find({ subscriptionId: req.params.id }).sort({ createdAt: -1 }).limit(100).lean();
  res.json(list.map(d => ({
    id: String(d._id), eventId: d.eventId, type: d.type, status: d.status, attempts: d.attempts,
    lastAt: d.lastAt, nextAt: d.nextAt, lastCode: d.lastCode, lastError: d.lastError, response: d.response,
  })));
});

// Again, now: the same event, the same id — the receiver deduplicates (evt/1 §4.3).
webhooksRouter.post('/:id/deliveries/:did/redeliver', async (req, res) => {
  const d = await WebhookDelivery.findOne({ _id: req.params.did, subscriptionId: req.params.id }).catch(() => null);
  if (!d) return res.status(404).json({ error: 'delivery not found', code: 'not_found' });
  d.status = 'pending'; d.nextAt = new Date(); d.attempts = 0;
  await d.save();
  res.json({ ok: true });
});

// A `webhook.test` event addressed to this subscription only — delivered even if the filter excludes it.
webhooksRouter.post('/:id/test', async (req, res) => {
  const s = await WebhookSubscription.findById(req.params.id).catch(() => null);
  if (!s) return res.status(404).json({ error: 'subscription not found', code: 'not_found' });
  const env = await emit({
    type: 'webhook.test', subject: { kind: 'webhook', id: String(s._id), name: s.name },
    actor: actorOf(req), data: { message: 'test delivery from NNM-Control' },
  });
  if (!env) return res.status(503).json({ error: 'events are not available right now', code: 'events_unavailable' });
  await WebhookDelivery.create({ subscriptionId: s._id, eventId: env.id, type: env.type });
  res.json({ ok: true, eventId: env.id });
});
