// What the external API (/api/v1) may cost WMSPanel.
//
// The whole panel runs on one WMSPanel account with a daily limit of 15 000 calls (models/ApiUsage.js).
// Before this, every API request for stream settings went to WMSPanel — a PATCH three times — so a script
// polling with a token could spend the budget and leave the panel itself blind until midnight UTC. Now the
// API works on the panel's own data and the panel decides when WMSPanel is asked:
//
//  * reads come from the panel's copy of each list (models/StreamObjectCache.js), which the panel's own
//    screens keep filling; the API refreshes a copy at most once per `refreshSec`, however many requests
//    ask, and only while there is allowance — otherwise it answers from the copy, saying how old it is;
//  * a write is one WMSPanel call, and the copy is updated in place rather than read back;
//  * every call an API request causes counts against `dailyCalls`, and none is made at all once the panel
//    as a whole has used all but `reservePct` per cent of the account limit — that part is the panel's.
// Live streams come from Nimble's native API on each server, which costs nothing (api/v1.js).
import { StreamObjectCache } from '../models/StreamObjectCache.js';
import { ApiUsage, utcDay, DAILY_LIMIT } from '../models/ApiUsage.js';
import { itemsOf } from '../api/streamKinds.js';

export const LIMIT_DEFAULTS = { dailyCalls: 1000, refreshSec: 900, reservePct: 20 };
const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);

/** The limits as they apply: defaults filled in, each held to a sane range. */
export function apiLimits(settings) {
  const l = settings?.apiLimits || {};
  return {
    dailyCalls: clamp(l.dailyCalls, 0, DAILY_LIMIT, LIMIT_DEFAULTS.dailyCalls),
    refreshSec: clamp(l.refreshSec, 60, 86400, LIMIT_DEFAULTS.refreshSec),
    reservePct: clamp(l.reservePct, 0, 90, LIMIT_DEFAULTS.reservePct),
  };
}

// Where the copies and the counts live; replaced in tests.
const mongoStore = {
  get: (sid, list) => StreamObjectCache.findOne({ sid, list }).lean(),
  put: (sid, list, items, fetchedAt = new Date()) =>
    StreamObjectCache.updateOne({ sid, list }, { $set: { items, fetchedAt } }, { upsert: true }),
  usage: async (day) => {
    const d = await ApiUsage.findOne({ day }).lean();
    return { calls: d?.calls || 0, apiCalls: d?.apiCalls || 0 };
  },
  charge: (day) => ApiUsage.updateOne(
    { day }, { $inc: { apiCalls: 1 }, $set: { lastAt: new Date() }, $setOnInsert: { firstAt: new Date() } }, { upsert: true }),
};
let store = mongoStore;
export const setStore = (s) => { store = s || mongoStore; };

/** Seconds until the WMSPanel day turns (assumed UTC midnight, see models/ApiUsage.js). */
export const secondsToReset = (now = new Date()) =>
  Math.max(1, Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) / 1000));

/** The allowance today: {ok, reason?, used, limit, panelCalls, panelLimit}. */
export async function allowance(limits) {
  const u = await store.usage(utcDay());
  const panelLimit = Math.floor(DAILY_LIMIT * (1 - limits.reservePct / 100));
  const base = { used: u.apiCalls, limit: limits.dailyCalls, panelCalls: u.calls, panelLimit };
  if (u.apiCalls >= limits.dailyCalls) return { ok: false, reason: 'api_allowance', ...base };
  if (u.calls >= panelLimit) return { ok: false, reason: 'panel_reserve', ...base };
  return { ok: true, ...base };
}

/** Refused for the budget: the API answers 429 with this. */
export class BudgetError extends Error {
  constructor(a) {
    super(a.reason === 'api_allowance'
      ? `the API has used its WMSPanel allowance for today (${a.used} of ${a.limit} calls)`
      : `the panel has used ${a.panelCalls} of its WMSPanel calls today; the rest is kept for the panel itself`);
    this.code = 'wmspanel_budget';
    this.details = { reason: a.reason, used: a.used, limit: a.limit, retryAfter: secondsToReset() };
  }
}

/** One WMSPanel call on behalf of the API, or a BudgetError. */
export async function spend(limits, fn) {
  const a = await allowance(limits);
  if (!a.ok) throw new BudgetError(a);
  // Counted before the attempt, as the client counts: a failed call still left the account.
  await store.charge(utcDay());
  return fn();
}

/** The panel read a list for itself: keep it, the API reads it for free. */
export async function remember(sid, list, resp) {
  if (!sid || !list) return resp;
  try { await store.put(String(sid), list, itemsOf(resp)); } catch { /* the copy is a convenience, never a failure */ }
  return resp;
}

const inflight = new Map();

/**
 * The list for the API: {items, fetchedAt, stale, reason?}. From the copy while it is fresh; otherwise
 * one refresh (shared by concurrent requests) if the allowance permits, else the copy as it is.
 */
export async function listFor({ sid, list, limits, fetch, now = Date.now() }) {
  const c = await store.get(sid, list);
  const age = c ? (now - new Date(c.fetchedAt).getTime()) / 1000 : Infinity;
  if (c && age < limits.refreshSec) return { items: c.items, fetchedAt: new Date(c.fetchedAt), stale: false };
  const key = `${sid}\u0000${list}`;
  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      const items = itemsOf(await spend(limits, fetch));
      const fetchedAt = new Date();
      await store.put(sid, list, items, fetchedAt);
      return { items, fetchedAt, stale: false };
    })().finally(() => inflight.delete(key)));
  }
  try { return await inflight.get(key); }
  catch (e) {
    // Out of allowance, or WMSPanel failed: the copy the panel has is still the best answer there is.
    if (c) return { items: c.items, fetchedAt: new Date(c.fetchedAt), stale: true, reason: e?.code === 'wmspanel_budget' ? 'wmspanel_budget' : 'upstream_failed' };
    throw e;
  }
}

/** After a write through the API: change the copy in place instead of reading the list back. */
export async function updateCopy(sid, list, change) {
  const c = await store.get(sid, list);
  if (!c) return null;
  const items = change(c.items || []);
  await store.put(sid, list, items, new Date(c.fetchedAt));
  return items;
}

/** A write whose result cannot be applied in place (a creation without an id): read it next time. */
export async function expireCopy(sid, list) {
  const c = await store.get(sid, list);
  if (c) await store.put(sid, list, c.items || [], new Date(0));
}

/** What the panel shows about it. */
export async function budgetReport(limits) {
  const a = await allowance(limits);
  return { ...limits, used: a.used, panelCalls: a.panelCalls, panelLimit: a.panelLimit, accountLimit: DAILY_LIMIT, blocked: a.ok ? null : a.reason };
}
