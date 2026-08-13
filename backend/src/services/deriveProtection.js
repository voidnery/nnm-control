import crypto from 'node:crypto';

// From "only our sites may embed this" to the objects WMSPanel holds.
//
// Same reversal as the routes: the operator states who may watch, and the
// panel works out the groups and rules. What makes this one harder is that the
// objects are shared. A WMSAuth group carries servers and rules, and one group
// can serve many channels — so deriving a group per channel would fill the
// account with near-duplicates that nobody can later tell apart.
//
// The rule adopted here: one group per delivery network, named after it, with
// one rule per protected channel inside it. A network is the unit that already
// owns a set of servers, which is exactly what a group needs, and it keeps the
// account readable by someone looking at WMSPanel directly — which they will,
// because this panel does not yet do everything.
//
// Nothing here writes. It computes what should exist, and the apply path
// compares that against what does — the same shape as the route planner, for
// the same reason: a preview and an apply that compute separately eventually
// disagree, and the disagreement is invisible until it matters.

const trim = s => String(s || '').replace(/^\/+|\/+$/g, '');

// A key nobody typed. It is the entire secret — whoever holds it can mint
// links for that channel — so it is generated at full strength rather than
// left to somebody's imagination, and the panel never shows it again.
export const newTokenKey = () => crypto.randomBytes(24).toString('base64url');

export const groupNameFor = (network) => `nnm:${network?.name || 'network'}`;
export const refererNameFor = (network) => `nnm:${network?.name || 'network'}:referers`;
export const rangeNameFor = (network) => `nnm:${network?.name || 'network'}:ranges`;
export const ruleNameFor = (channel) => `nnm:${trim(channel.application)}/${trim(channel.stream)}`;

// What each protection mode needs in order to work at all. Returned as
// findings rather than thrown, because an operator half-way through
// configuring something is not making a mistake.
export function protectionProblems({ channel, originApps = [] }) {
  const p = channel.protection || {};
  const app = trim(channel.application);
  const problems = [];
  const add = (code, severity = 'block', extra = {}) => problems.push({ code, severity, ...extra });

  if (p.mode === 'open') return problems;

  // The interaction that defeats everything, from Softvelum's own paywall FAQ:
  // an application in HTTP Origin mode is not protected by a signature. The
  // operator sees a rule, sees a signed link, and the stream is open.
  if (originApps.some(oa => trim(oa.application) === app)) {
    add('http-origin-defeats-protection', 'block', { application: app });
  }

  if (p.mode === 'token') {
    if (!p.tokenKey) add('no-token-key');
    // A window long enough to be shared is not a window. Said as a warning
    // rather than a refusal: an operator may have a reason.
    if (Number(p.validMinutes) > 24 * 60) add('very-long-validity', 'warn', { minutes: p.validMinutes });
    if (Number(p.validMinutes) < 1) add('validity-too-short');
  }

  if (p.mode === 'referer') {
    if (!(p.allowedDomains || []).length) add('no-domains');
    // Referer is a header the client sends, and a client may not send it.
    // Worth saying once, where the choice is made, rather than after somebody
    // discovers their stream is watchable with curl.
    add('referer-is-advisory', 'note');
  }

  if (p.mode === 'geo') {
    // WMSPanel has GET /v1/geo and no POST: the country list is reference data
    // it holds, not an object an API caller creates. So a country restriction
    // cannot be written the way a referer group can, and offering it as though
    // it could would be the panel promising something it has no way to do.
    //
    // Blocking rather than silently ignoring: an operator who picked "by
    // country" and saw no complaint would believe the channel was restricted.
    add('geo-not-writable', 'block');
    if (!(p.countries || []).length) add('no-countries');
    const bad = (p.countries || []).filter(c => !/^[A-Z]{2}$/.test(String(c).toUpperCase()));
    if (bad.length) add('bad-country-code', 'block', { codes: bad });
  }

  if (p.mode === 'ip') {
    if (!(p.ranges || []).length) add('no-ranges');
    const bad = (p.ranges || []).filter(r => !/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(String(r).trim()));
    if (bad.length) add('bad-range', 'block', { ranges: bad });
  }

  // An allow-list that permits nothing locks everyone out including the
  // operator, and it is one empty array away at all times.
  if (p.mode === 'geo' && p.countriesAllow && !(p.countries || []).length) add('allow-list-empty');
  if (p.mode === 'ip' && p.rangesAllow && !(p.ranges || []).length) add('allow-list-empty');

  return problems;
}

// The objects a network's protected channels imply, each carrying why it
// exists — same contract as the derived routes.
export function deriveProtection({ network, servers, channels, originApps = [], existing = {} }) {
  const byId = new Map(servers.map(s => [String(s._id ?? s.id), s]));
  // Every server the network uses, since a group's rules apply to its servers.
  const wmsIds = (network?.nodes || [])
    .filter(n => n.enabled !== false)
    .map(n => byId.get(String(n.server))?.wmspanelServerId)
    .filter(Boolean).map(String);

  const protectedChannels = channels.filter(c => (c.protection?.mode || 'open') !== 'open');
  const items = [];
  const problems = [];

  for (const c of protectedChannels) {
    for (const pr of protectionProblems({ channel: c, originApps })) {
      problems.push({ ...pr, channel: `${c.application}/${c.stream}` });
    }
  }

  if (!protectedChannels.length) {
    return { items, problems, groupName: null, summary: { create: 0, update: 0, keep: 0 }, inSync: true };
  }

  const tokenChannels = protectedChannels.filter(c => c.protection.mode === 'token');
  const groupName = groupNameFor(network);
  const group = (existing.groups || []).find(g => g.name === groupName);

  // Only when something actually needs signing. A network protected purely by
  // referer would otherwise get an empty WMSAuth group that does nothing and
  // that somebody later has to work out the purpose of.
  if (tokenChannels.length) items.push({
    kind: 'wmsauth-group',
    action: !group ? 'create' : (sameServers(group, wmsIds) ? 'keep' : 'update'),
    why: 'network-needs-a-group',
    subject: groupName,
    detail: { servers: wmsIds, groupId: group?.id || null },
  });

  // Hotlink protection: one group per network holding every allowed domain,
  // for the same reason the auth group is per network — a group per channel
  // fills the account with near-duplicates nobody can later tell apart.
  const refererDomains = [...new Set(protectedChannels
    .filter(c => c.protection.mode === 'referer')
    .flatMap(c => c.protection.allowedDomains || []))];
  if (refererDomains.length) {
    const name = refererNameFor(network);
    const found = (existing.refererGroups || []).find(g => g.name === name);
    const same = found && sameList(found.referers || found.domains, refererDomains);
    items.push({
      kind: 'referer-group',
      action: !found ? 'create' : (same ? 'keep' : 'update'),
      why: 'domains-may-embed',
      subject: name,
      detail: { id: found?.id || null, domains: refererDomains, servers: wmsIds },
    });
  }

  // IP ranges: a group *and* the CIDRs assigned to it. The group alone permits
  // nothing, so both halves are planned — a plan that stops at the group would
  // report success over a restriction that lets nobody in.
  const ranges = [...new Set(protectedChannels
    .filter(c => c.protection.mode === 'ip')
    .flatMap(c => c.protection.ranges || []))];
  if (ranges.length) {
    const name = rangeNameFor(network);
    const found = (existing.ipRanges || []).find(g => g.name === name);
    items.push({
      kind: 'ip-range-group',
      action: !found ? 'create' : 'keep',
      why: 'networks-may-watch',
      subject: name,
      detail: { id: found?.id || null, servers: wmsIds },
    });
    const have = found ? (existing.cidrsByGroup?.[String(found.id)] || []) : [];
    const missing = ranges.filter(r => !have.includes(r));
    if (missing.length) {
      items.push({
        kind: 'ip-range-cidrs',
        action: 'update',
        why: 'ranges-must-be-assigned',
        subject: name,
        detail: { id: found?.id || null, assign: missing },
      });
    }
  }

  // Rules sign links, so only the channels that use signed links get one. A
  // rule for a referer-protected channel would be an object with no effect
  // that a later reader has to work out the purpose of.
  for (const c of tokenChannels) {
    const name = ruleNameFor(c);
    const rule = (existing.rules || []).find(r => r.name === name);
    items.push({
      kind: 'wmsauth-rule',
      action: !rule ? 'create' : 'keep',
      why: 'channel-is-protected',
      subject: name,
      application: trim(c.application),
      detail: {
        ruleId: rule?.id || null,
        mode: c.protection.mode,
        // The key is never put in a plan. A preview is shown, logged and
        // sometimes pasted into a chat.
        hasKey: Boolean(c.protection.tokenKey),
        validMinutes: c.protection.validMinutes,
      },
    });
  }

  const blocking = problems.filter(p => p.severity === 'block');
  return {
    items, problems, blocking, groupName,
    summary: {
      create: items.filter(i => i.action === 'create').length,
      update: items.filter(i => i.action === 'update').length,
      keep: items.filter(i => i.action === 'keep').length,
    },
    inSync: items.every(i => i.action === 'keep') && blocking.length === 0,
  };
}

// Order-insensitive on purpose: WMSPanel returns a list in whatever order it
// stores it, and comparing positionally would rewrite the group on every plan
// — an update that changes nothing, forever, on an account somebody else also
// edits.
function sameList(have, want) {
  const a = new Set((have || []).map(String));
  const b = new Set((want || []).map(String));
  return a.size === b.size && [...a].every(v => b.has(v));
}

function sameServers(group, wanted) {
  const have = (group.server_ids || group.servers || []).map(String).sort();
  const want = [...wanted].sort();
  return have.length === want.length && have.every((v, i) => v === want[i]);
}
