import { Router } from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { Channel, channelName } from '../models/Channel.js';
import { DeliveryNetwork } from '../models/DeliveryNetwork.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { Settings } from '../models/Settings.js';
import { wmspanel } from '../services/wmspanelClient.js';
import { nimble, agentIsLive } from '../services/nimbleClient.js';
import { indexStreams } from '../services/networkState.js';
import { channelLinks } from '../services/channelLinks.js';
import { derivePlan, channelReadiness } from '../services/derivePlan.js';
import { deriveProtection, newTokenKey } from '../services/deriveProtection.js';
import { signUrl } from '../services/wmsAuth.js';
import { dvrUrl, momentUrl, recordingFor } from '../services/dvrLinks.js';
import { networkSteps } from '../services/networkSteps.js';
import { logEvent } from '../services/audit.js';

export const channelRouter = Router();
channelRouter.use(requireAuth);

const pub = (c) => ({
  id: c.id, application: c.application, stream: c.stream,
  label: c.label, notes: c.notes, kind: c.kind, enabled: c.enabled,
  protocol: c.protocol || 'hls',
  // The signing key is the whole secret: whoever holds it can mint links for
  // this channel. It is never returned — only whether one exists — so it
  // cannot leak through a response somebody is looking at over a shoulder.
  protection: {
    mode: c.protection?.mode || 'open',
    hasKey: Boolean(c.protection?.tokenKey),
    validMinutes: c.protection?.validMinutes ?? 20,
    bindToIp: Boolean(c.protection?.bindToIp),
    allowedDomains: c.protection?.allowedDomains || [],
    countries: c.protection?.countries || [],
    countriesAllow: c.protection?.countriesAllow !== false,
    ranges: c.protection?.ranges || [],
    rangesAllow: c.protection?.rangesAllow !== false,
  },
  network: c.network ? String(c.network) : null,
  name: channelName(c), updatedAt: c.updatedAt,
});

const trim = s => String(s || '').replace(/^\/+|\/+$/g, '');

// Everything the account already holds, across all three families.
//
// Read in one place so the preview and the apply see the same thing: a plan
// computed against a partial reading proposes objects that exist, and the
// apply then either duplicates them or fails on the duplicate.
async function readProtectionObjects(cfg, groups, rules) {
  const refererGroups = await wmspanel.refererGroupList(cfg).then(r => r.referer_groups || []).catch(() => []);
  const ipRanges = await wmspanel.ipRangeList(cfg).then(r => r.ip_ranges || []).catch(() => []);
  // The CIDRs of each range group, because a group with none permits nothing
  // and looks identical to a group with the right ones.
  const cidrsByGroup = {};
  for (const g of ipRanges) {
    const list = await wmspanel.ipRangeCidrs(cfg, g.id).then(r => r.cidrs || []).catch(() => []);
    cidrsByGroup[String(g.id)] = list.map(c => (typeof c === 'string' ? c : c.cidr || c.range)).filter(Boolean);
  }
  return { groups, rules, refererGroups, ipRanges, cidrsByGroup };
}

// Chosen, applied, and actually in force — three states an operator conflates
// until one of them bites.
//
// `chosen` is what the panel holds. `applied` is whether the WMSAuth rule
// exists on the account, which is what Nimble reads. `effective` is whether it
// does anything: an application in HTTP Origin mode is not protected by a
// signature however many rules point at it, which is the case where every
// screen looks correct and the stream is open.
function protectionStatus(channel, { authRules, authGroups, originApps }) {
  const mode = channel.protection?.mode || 'open';
  const app = trim(channel.application);
  const name = `nnm:${app}/${trim(channel.stream)}`;

  if (mode === 'open') return { mode, chosen: 'open', applied: null, effective: true, code: 'open' };
  if (authGroups === null) {
    return { mode, chosen: mode, applied: null, effective: null, code: 'unknown' };
  }
  const rule = authRules.get(name) || null;
  // Defensive on purpose. The caller should pass this; when it did not, the
  // page returned 500 and the operator saw "Internal server error" with no
  // way to tell which of a dozen calls had failed. A missing list is now the
  // same as an empty one, and the status still says what it knows.
  const defeated = (originApps || []).some(oa => trim(oa.application) === app);
  return {
    mode, chosen: mode,
    applied: Boolean(rule),
    rule: rule ? { id: rule.id, group: rule.groupName } : null,
    effective: Boolean(rule) && !defeated,
    code: !rule ? 'not-applied' : defeated ? 'defeated-by-http-origin' : 'in-force',
  };
}

// What the origins are publishing that is not a channel yet.
//
// Adding a channel used to mean typing an application and a stream that the
// origin already knows, and a name typed twice is a name eventually typed
// wrong. This offers them — across every network, since a stream is worth
// delivering regardless of which network the operator happens to be looking
// at, and the network is chosen when the channel is created.
// Write the protection a network's channels imply.
//
// Same shape as applying routes, and for the same reasons: the plan is
// recomputed here rather than trusted from the client, blocking findings
// refuse rather than warn, and everything written is read back — because this
// account has no WMSAuth objects at all, so every request body below is
// documented rather than observed, and the first write is the first real test
// of its shape.
channelRouter.post('/networks/:id/protection/apply', requirePerm('cdn.manage'), async (req, res) => {
  const [network, servers, channels] = await Promise.all([
    DeliveryNetwork.findById(req.params.id),
    NimbleServer.find(),
    Channel.find({ network: req.params.id, enabled: true }),
  ]);
  if (!network) return res.status(404).json({ error: 'network-not-found', code: 'network-not-found' });

  const cfg = (await Settings.load()).wmspanel;
  const originApps = await wmspanel.originAppList(cfg).then(r => r.settings || []).catch(() => []);
  const groups = await wmspanel.authGroupList(cfg).then(r => r.groups || []).catch(() => []);
  const rulesFlat = [];
  for (const g of groups) {
    const rr = await wmspanel.authRuleList(cfg, g.id).then(r => r.rules || []).catch(() => []);
    for (const r of rr) rulesFlat.push({ ...r, groupId: g.id });
  }
  const existing = await readProtectionObjects(cfg, groups, rulesFlat);
  const plan = deriveProtection({ network, servers, channels, originApps, existing });

  if (plan.blocking?.length) {
    // Recomputed here, not taken from whatever the page was showing: the
    // account can change between a preview and a press, and the change that
    // matters most — an application put into HTTP Origin mode — is invisible
    // from this page entirely.
    return res.status(422).json({ error: 'protection-blocked', code: 'protection-blocked', ...plan });
  }

  const steps = [];
  const created = { groups: [], rules: [], referers: [], ranges: [] };
  let ok = true;

  try {
    const groupItem = plan.items.find(i => i.kind === 'wmsauth-group');
    let groupId = groupItem?.detail?.groupId || null;
    const wantServers = groupItem?.detail?.servers || [];

    // Only when something needs signing. A network protected purely by referer
    // would otherwise get an empty WMSAuth group that does nothing.
    if (groupItem && !groupId) {
      const r = await wmspanel.authGroupCreate(cfg, { name: plan.groupName, server_ids: wantServers });
      groupId = r?.group?.id || r?.id || null;
      if (!groupId) {
        // A response without an id is not proof that nothing was written, and
        // deleting on that assumption would remove a group that exists.
        const back = await wmspanel.authGroupList(cfg).catch(() => ({ groups: [] }));
        groupId = (back.groups || []).find(g => g.name === plan.groupName)?.id || null;
        if (!groupId) throw new Error('WMSPanel returned no group id and the group is not in the list afterwards');
      }
      created.groups.push(groupId);
      steps.push({ step: `create group ${plan.groupName}`, ok: true, groupId });
    }

    // Hotlink protection.
    for (const item of plan.items.filter(i => i.kind === 'referer-group' && i.action !== 'keep')) {
      const body = { name: item.subject, referers: item.detail.domains, server_ids: item.detail.servers };
      if (item.action === 'create') {
        const r = await wmspanel.refererGroupCreate(cfg, body);
        const id = r?.referer_group?.id || r?.id || null;
        if (id) created.referers.push(id);
        steps.push({ step: `create referer group ${item.subject}`, ok: true, id: id || null });
      } else {
        await wmspanel.refererGroupUpdate(cfg, item.detail.id, body);
        steps.push({ step: `update referer group ${item.subject}`, ok: true, verified: 'domains rewritten' });
      }
    }

    // IP ranges: the group, then the CIDRs. Both, because the group alone
    // permits nothing and a half-applied restriction locks everybody out.
    let rangeGroupId = plan.items.find(i => i.kind === 'ip-range-group')?.detail?.id || null;
    for (const item of plan.items.filter(i => i.kind === 'ip-range-group' && i.action === 'create')) {
      const r = await wmspanel.ipRangeCreate(cfg, { name: item.subject, server_ids: item.detail.servers });
      rangeGroupId = r?.ip_range?.id || r?.id || null;
      if (!rangeGroupId) {
        const back = await wmspanel.ipRangeList(cfg).catch(() => ({ ip_ranges: [] }));
        rangeGroupId = (back.ip_ranges || []).find(g => g.name === item.subject)?.id || null;
        if (!rangeGroupId) throw new Error('WMSPanel returned no ip range id and the group is not in the list afterwards');
      }
      created.ranges.push(rangeGroupId);
      steps.push({ step: `create ip range group ${item.subject}`, ok: true, id: rangeGroupId });
    }
    for (const item of plan.items.filter(i => i.kind === 'ip-range-cidrs')) {
      const id = item.detail.id || rangeGroupId;
      if (!id) throw new Error('no ip range group to assign CIDRs to');
      await wmspanel.ipRangeAssign(cfg, id, { cidrs: item.detail.assign });
      steps.push({ step: `assign ${item.detail.assign.length} range(s)`, ok: true, verified: item.detail.assign.join(', ') });
    }

    const existingRules = groupId
      ? await wmspanel.authRuleList(cfg, groupId).then(r => r.rules || []).catch(() => [])
      : [];
    for (const item of plan.items.filter(i => i.kind === 'wmsauth-rule' && i.action !== 'keep')) {
      const channel = channels.find(c => `nnm:${c.application}/${c.stream}` === item.subject);
      if (!channel) continue;
      if (existingRules.some(r => r.name === item.subject)) {
        steps.push({ step: `rule ${item.subject}`, ok: true, verified: 'already present' });
        continue;
      }
      const body = {
        name: item.subject,
        // The application and stream this rule covers. Sent as plain names
        // rather than a pattern: a regular expression that matches more than
        // intended protects more than intended, which sounds harmless and is
        // how an unrelated stream stops playing.
        application: channel.application,
        stream: channel.stream,
        password: channel.protection.tokenKey,
        time_tolerance: 300,
      };
      const r = await wmspanel.authRuleCreate(cfg, groupId, body);
      const id = r?.rule?.id || r?.id || '';
      created.rules.push({ groupId, id });
      steps.push({ step: `create rule ${item.subject}`, ok: true, ruleId: id || null,
                   verified: id ? 'created' : 'created, no id returned' });
    }
  } catch (e) {
    ok = false;
    // Undo only what this run made. A group that existed before is left alone:
    // it may carry rules for channels this run knows nothing about.
    const undone = [];
    for (const r of created.rules.reverse()) {
      try { await wmspanel.authRuleDelete(cfg, r.groupId, r.id); undone.push(r.id); } catch { /* reported below */ }
    }
    for (const g of created.groups.reverse()) {
      try { await wmspanel.authGroupDelete(cfg, g); undone.push(g); } catch { /* reported below */ }
    }
    for (const g of created.referers.reverse()) {
      try { await wmspanel.refererGroupDelete(cfg, g); undone.push(g); } catch { /* reported below */ }
    }
    for (const g of created.ranges.reverse()) {
      try { await wmspanel.ipRangeDelete(cfg, g); undone.push(g); } catch { /* reported below */ }
    }
    steps.push({ step: 'apply', ok: false, error: String(e?.message || e).slice(0, 300),
                 upstreamError: e?.data ?? undefined,
                 rolledBack: undone.length ? `${undone.length} object(s) removed` : 'nothing to roll back' });
  }

  const applied = steps.filter(x => x.ok).length;
  await logEvent(req, 'cdn.protection.apply', { network: network.name, ok, applied });
  // `applied` because the page reports "written: N" and read it off this
  // response — without it the operator was told "written: undefined", which is
  // the panel admitting it does not know what it just did.
  res.status(ok ? 200 : 502).json({ ok, applied, steps, plan });
});

// A link to what was recorded.
//
// The panel cannot switch recording on — WMSPanel has no POST for it — so this
// is playback only: the archive, a fragment around a moment, or a rewind. The
// moment form exists because that is how somebody watching a match asks, and
// turning "19:42" into an epoch range by hand at speed is how the wrong minute
// gets sent out.
channelRouter.post('/channels/:id/replay', requirePerm('cdn.view'), async (req, res) => {
  const c = await Channel.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'channel-not-found', code: 'channel-not-found' });

  const servers = await NimbleServer.find();
  const net = c.network ? await DeliveryNetwork.findById(c.network) : null;
  // From an edge, like any other viewer link. The archive lives where the
  // recording was made, so an edge that only re-streams has nothing — but that
  // is a fact about the fleet, and the probe below reports it rather than this
  // guessing.
  const byId = new Map(servers.map(s => [String(s._id), s]));
  const edge = (net?.nodes || [])
    .filter(n => n.role === 'edge' && n.enabled !== false)
    .map(n => byId.get(String(n.server))).filter(Boolean)[0]
    || servers.find(s => String(s._id) === String((net?.nodes || []).find(n => n.role === 'origin')?.server));
  if (!edge) return res.status(422).json({ error: 'no-server-for-replay', code: 'no-server-for-replay' });

  const common = {
    host: edge.playbackEndpoints?.[0]?.host || edge.wmspanelDomains?.[0] || edge.host,
    port: edge.httpPort || 8081,
    application: c.application, stream: c.stream,
    container: req.body?.container === 'fmp4' ? 'fmp4' : 'ts',
  };

  let link;
  try {
    if (req.body?.at) {
      link = momentUrl({
        ...common, at: req.body.at,
        beforeSeconds: Math.max(0, Number(req.body.before) || 15),
        afterSeconds: Math.max(1, Number(req.body.after) || 15),
      });
    } else if (req.body?.shiftSeconds) {
      link = dvrUrl({ ...common, mode: 'timeshift', shiftSeconds: Number(req.body.shiftSeconds),
                      depthSeconds: Number(req.body.depthSeconds) || null });
    } else {
      link = dvrUrl({ ...common, mode: 'full' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'bad-replay-request', code: 'bad-replay-request', detail: String(e.message) });
  }

  const cfg = (await Settings.load()).wmspanel;
  // Whether anything is recorded at all. A replay link for a stream nobody
  // recorded plays nothing, and the operator concludes the archive is broken
  // rather than absent.
  const dvrStreams = await wmspanel.dvrStreamList(cfg).then(r => r.dvr_streams || []).catch(() => null);
  res.json({
    ...link,
    server: edge.name,
    recording: dvrStreams === null ? null : recordingFor(c, dvrStreams),
    recordingKnown: dvrStreams !== null,
  });
});

// A link that satisfies this channel's protection, signed here because the
// key never leaves the server.
//
// The address matters: Nimble hashes the viewer's IP, so a link is bound to
// whoever it was issued for. The panel asks who it is for rather than issuing
// one that works only for the person who pressed the button.
channelRouter.post('/channels/:id/sign', requirePerm('cdn.view'), async (req, res) => {
  const c = await Channel.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'channel-not-found', code: 'channel-not-found' });
  if (c.protection?.mode !== 'token') {
    return res.status(422).json({ error: 'channel-not-token-protected', code: 'channel-not-token-protected' });
  }
  if (!c.protection.tokenKey) {
    return res.status(422).json({ error: 'no-token-key', code: 'no-token-key' });
  }
  const url = String(req.body?.url || '').trim();
  if (!/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: 'url-required', code: 'url-required' });
  }
  const signed = signUrl(url, {
    key: c.protection.tokenKey,
    ip: String(req.body?.ip || '').trim(),
    validMinutes: c.protection.validMinutes,
    checkIp: Boolean(c.protection.bindToIp),
  });
  await logEvent(req, 'cdn.channel.sign', {
    channel: `${c.application}/${c.stream}`, boundToIp: signed.boundToIp, validMinutes: signed.validMinutes,
  });
  res.json(signed);
});

channelRouter.get('/channels/discovered', requirePerm('cdn.view'), async (_req, res) => {
  const [networks, servers, existing] = await Promise.all([
    DeliveryNetwork.find(), NimbleServer.find(), Channel.find(),
  ]);
  const byId = new Map(servers.map(s => [String(s._id), s]));
  const have = new Set(existing.map(c => `${trim(c.application)}/${trim(c.stream)}`));

  // Origins and ingests only. An edge is publishing what it pulled, so
  // offering its streams would suggest creating a channel for something that
  // is already a copy of one.
  const sources = new Map();
  for (const n of networks) {
    for (const node of n.nodes || []) {
      if (!['origin', 'ingest'].includes(node.role) || node.enabled === false) continue;
      const s = byId.get(String(node.server));
      if (s) sources.set(String(s._id), s);
    }
  }

  const found = [];
  const unreachable = [];
  await Promise.all([...sources.values()].map(async (s) => {
    let idx;
    try { idx = indexStreams(await nimble.liveStreams(s)); }
    catch { unreachable.push(s.name); return; }
    for (const [application, entries] of idx) {
      for (const e of entries) {
        const stream = trim(e.stream);
        if (!stream) continue;
        const key = `${application}/${stream}`;
        if (have.has(key)) continue;
        if (!found.some(f => f.key === key)) {
          found.push({ key, application, stream, origin: s.name, bandwidth: e.bandwidth || 0 });
        }
      }
    }
  }));
  found.sort((a, b) => a.key.localeCompare(b.key));
  res.json({ found, unreachable });
});

channelRouter.get('/channels', requirePerm('cdn.view'), async (_req, res) => {
  const items = await Channel.find().sort({ application: 1, stream: 1 });
  res.json({ channels: items.map(pub) });
});

channelRouter.post('/channels', requirePerm('cdn.manage'), async (req, res) => {
  const application = trim(req.body?.application);
  const stream = trim(req.body?.stream);
  if (!application || !stream) {
    return res.status(400).json({ error: 'application-and-stream-required', code: 'application-and-stream-required' });
  }
  if (await Channel.findOne({ application, stream })) {
    // The pair is the identity. Two records claiming one stream would make
    // "the production link for this channel" ambiguous, which is worse than
    // having no answer.
    return res.status(409).json({ error: 'channel-exists', code: 'channel-exists' });
  }
  const c = await Channel.create({
    application, stream,
    label: String(req.body?.label || ''), notes: String(req.body?.notes || ''),
    kind: req.body?.kind === 'test' ? 'test' : 'production',
    protocol: ['hls', 'llhls', 'dash'].includes(req.body?.protocol) ? req.body.protocol : 'hls',
    network: req.body?.network || null,
    createdBy: req.user?.username || '',
  });
  await logEvent(req, 'cdn.channel.create', { application, stream });
  res.status(201).json(pub(c));
});

channelRouter.put('/channels/:id', requirePerm('cdn.manage'), async (req, res) => {
  const c = await Channel.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'channel-not-found', code: 'channel-not-found' });
  const b = req.body || {};
  if (b.label !== undefined) c.label = String(b.label);
  if (b.notes !== undefined) c.notes = String(b.notes);
  if (b.kind !== undefined) c.kind = b.kind === 'test' ? 'test' : 'production';
  if (b.protocol !== undefined && ['hls', 'llhls', 'dash'].includes(b.protocol)) c.protocol = b.protocol;
  if (b.protection !== undefined) {
    const p = b.protection || {};
    if (['open', 'token', 'referer', 'ip', 'geo'].includes(p.mode)) c.protection.mode = p.mode;
    if (p.validMinutes !== undefined) c.protection.validMinutes = Math.max(1, Number(p.validMinutes) || 20);
    if (p.bindToIp !== undefined) c.protection.bindToIp = Boolean(p.bindToIp);
    if (Array.isArray(p.allowedDomains)) c.protection.allowedDomains = p.allowedDomains.map(x => String(x).trim()).filter(Boolean);
    if (Array.isArray(p.countries)) c.protection.countries = p.countries.map(x => String(x).trim().toUpperCase()).filter(Boolean);
    if (p.countriesAllow !== undefined) c.protection.countriesAllow = Boolean(p.countriesAllow);
    if (Array.isArray(p.ranges)) c.protection.ranges = p.ranges.map(x => String(x).trim()).filter(Boolean);
    if (p.rangesAllow !== undefined) c.protection.rangesAllow = Boolean(p.rangesAllow);
    // Generated here, never accepted from the client: a key that arrived over
    // the wire has been somewhere, and the operator has no way to know where.
    if (p.regenerateKey) c.protection.tokenKey = newTokenKey();
    if (c.protection.mode === 'token' && !c.protection.tokenKey) c.protection.tokenKey = newTokenKey();
  }
  if (b.enabled !== undefined) c.enabled = b.enabled !== false;
  if (b.network !== undefined) c.network = b.network || null;
  try { await c.save(); }
  catch (e) { return res.status(422).json({ error: `channel-not-saved`, code: 'channel-not-saved', detail: e.message }); }
  await logEvent(req, 'cdn.channel.update', { id: c.id });
  res.json(pub(c));
});

channelRouter.delete('/channels/:id', requirePerm('cdn.manage'), async (req, res) => {
  const c = await Channel.findByIdAndDelete(req.params.id);
  if (!c) return res.status(404).json({ error: 'channel-not-found', code: 'channel-not-found' });
  await logEvent(req, 'cdn.channel.delete', { application: c.application, stream: c.stream });
  res.json({ ok: true });
});

// Edges of a network, with everything the link generator and the dashboard
// need. Shaped like the arbiter's own gathering because it answers the same
// question and must not answer it differently.
async function edgesOf(network, servers, routes) {
  const byId = new Map(servers.map(s => [String(s._id), s]));
  const out = [];
  for (const n of (network.nodes || []).filter(x => x.role === 'edge' && x.enabled !== false)) {
    const s = byId.get(String(n.server));
    if (!s) continue;
    const mine = routes === null ? undefined
      : routes.filter(r => (r.servers || []).map(String).includes(String(s.wmspanelServerId)))
              .map(r => trim(r.from));
    let channels, healthy = true;
    try { channels = [...indexStreams(await nimble.liveStreams(s)).keys()]; }
    catch { channels = undefined; healthy = false; }
    out.push({
      name: s.name, host: s.host,
      publicHost: s.playbackEndpoints?.[0]?.host || s.wmspanelDomains?.[0] || '',
      httpPort: s.httpPort || 8081,
      weight: n.weight ?? 100, enabled: true, healthy,
      lat: s.geo?.lat ?? null, lon: s.geo?.lon ?? null,
      routes: mine, channels, hasAgent: agentIsLive(s),
    });
  }
  return out;
}

// What a network needs written so its channels are delivered, and why.
//
// The operator adds channels; this works out the rest. Same computation drives
// the preview and the apply, so the two cannot disagree — which is the only
// thing that makes it acceptable for the panel to write into the account
// without asking each time.
channelRouter.get('/networks/:id/derived', requirePerm('cdn.view'), async (req, res) => {
  const [network, servers, channels] = await Promise.all([
    DeliveryNetwork.findById(req.params.id),
    NimbleServer.find(),
    Channel.find({ network: req.params.id, enabled: true }),
  ]);
  if (!network) return res.status(404).json({ error: 'network-not-found', code: 'network-not-found' });
  const cfg = (await Settings.load()).wmspanel;
  const [originApps, routes] = await Promise.all([
    wmspanel.originAppList(cfg).then(r => r.settings || []).catch(() => []),
    wmspanel.routeList(cfg).then(r => r.routes || []).catch(() => []),
  ]);
  const plan = derivePlan({ network, servers, channels, originApps, existingRoutes: routes });
  const authGroups = await wmspanel.authGroupList(cfg).then(r => r.groups || []).catch(() => []);
  // The rules too, not only the groups. Without them every rule looked absent
  // and the plan said "create" forever: the operator pressed write, the object
  // was made, and the step went on asking for it — which reads as the panel
  // not having done what it just did.
  const authRulesFlat = [];
  for (const g of authGroups) {
    const rules = await wmspanel.authRuleList(cfg, g.id).then(r => r.rules || []).catch(() => []);
    for (const r of rules) authRulesFlat.push({ ...r, groupId: g.id });
  }
  const existing = await readProtectionObjects(cfg, authGroups, authRulesFlat);
  const protPlan = deriveProtection({ network, servers, channels, originApps, existing });
  res.json({
    ...plan,
    channels: channels.map(c => ({ ...pub(c), readiness: channelReadiness({ channel: c, plan }) })),
    // The six steps, computed from the same data rather than inferred by the
    // page: a tick has to mean the thing is true, and two places working that
    // out would eventually disagree about what green means.
    //
    // `watched` is not included. Whether content actually arrives is not
    // derivable from configuration — it takes a probe — so the step is empty
    // until the operator runs one, and the page passes the result back in.
    steps: networkSteps({
      network, servers, channels, derived: plan, protection: protPlan,
      // The last time somebody actually asked an edge for a playlist. Step
      // five could never turn green because nothing remembered the answer:
      // the probe ran, the page showed it, and the next request forgot it.
      watched: network.lastVerified?.at ? {
        total: network.lastVerified.total, ok: network.lastVerified.ok,
        failing: network.lastVerified.total - network.lastVerified.ok,
        at: network.lastVerified.at,
      } : null,
    }),
    // Who may watch, derived alongside what carries it. Same computation for
    // preview and apply, for the same reason as the routes.
    protection: protPlan,
  });
});

// One row per channel: where it is delivered, whether anything is arriving,
// and the links to hand out. The question the panel could not answer about its
// own configuration.
channelRouter.get('/channels/overview', requirePerm('cdn.view'), async (_req, res) => {
  const [channels, networks, servers] = await Promise.all([
    Channel.find().sort({ application: 1, stream: 1 }),
    DeliveryNetwork.find(),
    NimbleServer.find(),
  ]);
  const cfg = (await Settings.load()).wmspanel;
  // Null rather than [] when the list could not be read: "we did not ask" and
  // "there are none" lead to different rows.
  const routes = await wmspanel.routeList(cfg).then(r => r.routes || []).catch(() => null);
  // What protection actually exists on the account, as opposed to what the
  // channels ask for. Two different questions, and the operator asked both:
  // which mode is chosen, and which is in force.
  // Needed to tell "protected" from "protected and defeated": an application
  // in HTTP Origin mode is not covered by a signature. This was read in the
  // other handlers and used here without being fetched, which took the whole
  // page down with a bare 500.
  const originApps = await wmspanel.originAppList(cfg).then(r => r.settings || []).catch(() => []);
  const authGroups = await wmspanel.authGroupList(cfg).then(r => r.groups || []).catch(() => null);
  const authRules = new Map();
  if (authGroups) {
    for (const g of authGroups) {
      const rules = await wmspanel.authRuleList(cfg, g.id).then(r => r.rules || []).catch(() => []);
      for (const r of rules) authRules.set(r.name, { ...r, groupId: g.id, groupName: g.name });
    }
  }

  const byNetwork = new Map();
  for (const n of networks) byNetwork.set(String(n._id), n);
  const edgeCache = new Map();
  const rows = [];

  for (const c of channels) {
    const net = c.network ? byNetwork.get(String(c.network)) : null;
    if (!net) {
      // A stream nobody delivers. Invisible before, and exactly the thing
      // worth seeing before an event rather than during one.
      rows.push({ channel: pub(c), network: null, edges: [], links: null, code: 'not-delivered' });
      continue;
    }
    if (!edgeCache.has(String(net._id))) edgeCache.set(String(net._id), await edgesOf(net, servers, routes));
    const edges = edgeCache.get(String(net._id));
    const gwNode = net.gateway?.node ? servers.find(s => String(s._id) === String(net.gateway.node)) : null;
    rows.push({
      channel: pub(c),
      network: { id: net.id, name: net.name, audience: net.audience },
      edges: edges.map(e => ({
        name: e.name, healthy: e.healthy,
        routed: e.routes ? e.routes.includes(c.application) : null,
        serving: e.channels ? e.channels.includes(c.application) : null,
      })),
      links: channelLinks({ channel: c, network: net, edges, node: gwNode }),
      // Chosen versus in force. `unknown` when the account could not be read:
      // saying "not applied" about protection we simply did not look up would
      // be the worst of the three answers.
      protection: protectionStatus(c, { authRules, authGroups, originApps }),
    });
  }
  res.json({ rows, routesRead: routes !== null });
});
