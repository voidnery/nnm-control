// Events of NNM-Control in the family envelope evt/1 (eterix-contracts/evt-1.md rev.1;
// docs/api/PROPOSAL-nnm-api-1.md §3). An event is written once, read through GET /api/v1/events and
// queued for every enabled webhook subscription that wants its type.
//
// emit() never throws and never makes its caller wait for delivery: an event is a consequence of an
// action, and a broken subscription must not fail the action. Everything that decides the content of
// an event is a pure function here, tested without a database (tests/events-webhooks.test.mjs).
import crypto from 'node:crypto';
import os from 'node:os';

export const SCHEMA = 'evt/1';
export const PRODUCT = 'nnm-control';
export const TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

// What NNM-Control emits (§3.4); offered as the subscription filter in the panel.
export const EVENT_TYPES = [
  'stream_object.created', 'stream_object.changed', 'stream_object.deleted', 'stream_object.action',
  'playlist.deployed', 'playlist.stream_stopped', 'playlist.stream_started',
  'channel.unhealthy', 'channel.healthy',
  'agent.offline', 'agent.online',
  'server.unreachable', 'server.reachable', 'stream.up', 'stream.down', 'certificate.expiring',
  'webhook.test',
];

// ---- ULID: 48 bits of milliseconds + 80 random bits, Crockford base32 ----
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulid(now = Date.now(), rand = crypto.randomBytes) {
  let t = '';
  let ms = now;
  for (let i = 0; i < 10; i++) { t = B32[ms % 32] + t; ms = Math.floor(ms / 32); }
  const r = rand(10);
  let bits = 0n;
  for (const b of r) bits = (bits << 8n) | BigInt(b);
  let s = '';
  for (let i = 0; i < 16; i++) { s = B32[Number(bits & 31n)] + s; bits >>= 5n; }
  return t + s;
}

// ---- secrets (evt/1 §3) ----
// A word of the field name, not a substring: push_password, stream_key, aws_secret_access_key,
// apiKey — yes; keyframe_interval, monkey, tokens_total — no.
const SNAKE = /(?:^|[_-])(?:key|secret|password|passwd|pass|token|credentials?)(?:$|[_-])/i;
const CAMEL = /[a-z](?:Key|Secret|Password|Token|Credentials?)(?:$|[A-Z_])/;
export const isSecretKey = (k) => SNAKE.test(k) || CAMEL.test(k);
const URL_CREDS = /:\/\/[^\s/@:]+:[^\s/@]*@/g;
/**
 * A copy with every secret replaced by "***": values of keys that name a secret, the whole
 * Source_AWS block, and user:password in any URL. The shape stays, so a change is still visible.
 */
export function maskSecrets(value, depth = 0) {
  if (depth > 20) return '***';
  if (Array.isArray(value)) return value.map(v => maskSecrets(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = (isSecretKey(k) || k === 'Source_AWS') && v !== null && v !== undefined && v !== ''
        ? '***' : maskSecrets(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.replace(URL_CREDS, '://***@');
  return value;
}

/** Top-level fields that differ — secrets included, by name only. */
export function changedFields(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter(k => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])).sort();
}

/** The evt/1 envelope. Refuses a type outside the grammar rather than sending it. */
export function envelope({ type, subject, actor, data = {}, instance, now = new Date(), id = ulid(now.getTime()) }) {
  if (!TYPE_RE.test(String(type))) throw new Error(`event type «${type}» is not <object>.<event>`);
  if (!subject?.kind) throw new Error('an event needs subject.kind');
  return {
    schema_version: SCHEMA,
    id,
    type,
    occurred_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    product: PRODUCT,
    instance: { id: instance?.id || '', name: instance?.name || '' },
    subject,
    actor: actor?.kind ? { kind: actor.kind, name: actor.name || '' } : { kind: 'system', name: 'nnm-control' },
    data: maskSecrets(data),
  };
}

/** evt/1 §4.1: v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>. */
export function signature(secret, timestamp, body) {
  return `v1=${crypto.createHmac('sha256', String(secret)).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Does this subscription want this type? Empty filter — everything; `x.*` — every `x.` type. */
export function wants(sub, type) {
  // A test event goes only to the subscription it was asked for (routes/webhooks.js).
  if (!sub?.enabled || type === 'webhook.test') return false;
  const f = sub.types || [];
  if (!f.length) return true;
  return f.some(t => t === type || (t.endsWith('.*') && type.startsWith(t.slice(0, -1))));
}

// evt/1 §4.2: 1 min, 5 min, 30 min, 2 h, 6 h, 12 h — then given up (≈ a day in all).
export const RETRY_DELAYS_MS = [60e3, 5 * 60e3, 30 * 60e3, 2 * 3600e3, 6 * 3600e3, 12 * 3600e3];
/** When to try again after `failures` failed attempts, or null — give up. */
export function nextAttemptAt(failures, now = new Date()) {
  const d = RETRY_DELAYS_MS[failures - 1];
  return d === undefined ? null : new Date(now.getTime() + d);
}
export const DISABLE_AFTER = 50;

// ---- the instance (§3.2) ----
let instanceCache = null;
export async function ensureInstance(Settings) {
  const s = await Settings.load();
  if (!s.instanceId) { s.instanceId = ulid(); await s.save(); }
  const host = (() => { try { return new URL(s.publicUrl).hostname; } catch { return ''; } })();
  instanceCache = { id: s.instanceId, name: s.instanceName || host || os.hostname() };
  return instanceCache;
}

// ---- emit ----
let store = null;
/** Wired at start (index.js): models for writing, and the instance. Tests leave it unset. */
export function configureEvents(deps) { store = deps; }

export async function emit({ type, subject, actor, data }) {
  if (!store) return null;
  try {
    const instance = instanceCache || await ensureInstance(store.Settings);
    const env = envelope({ type, subject, actor, data, instance });
    await store.Event.create({ eventId: env.id, type: env.type, occurredAt: new Date(env.occurred_at), envelope: env });
    const subs = await store.WebhookSubscription.find({ enabled: true });
    const due = subs.filter(s => wants(s, env.type));
    if (due.length) {
      await store.WebhookDelivery.insertMany(due.map(s => ({ subscriptionId: s._id, eventId: env.id, type: env.type })));
    }
    return env;
  } catch (e) {
    console.error('[events] not recorded:', e?.message || e);
    return null;
  }
}

/** Who did it, as evt/1 wants it, from a request. */
export const actorOf = (req) => req?.actor || (req?.user ? { kind: 'user', name: req.user.username } : { kind: 'system', name: 'nnm-control' });
