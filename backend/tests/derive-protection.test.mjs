// Protection as intent, iter22 m2.
//
// The account has none of this today: no WMSAuth groups, no referer groups, no
// IP ranges. Every stream on the fleet is open, which is a decision nobody
// made — and the first thing this derivation does is make the decision
// visible.
//
// The hard part is not the objects. It is that they are shared: a WMSAuth
// group carries servers and rules, and one group can serve many channels, so a
// group per channel would fill the account with near-duplicates nobody can
// later tell apart. One group per network, one rule per protected channel.
import assert from 'node:assert/strict';
import { deriveProtection, protectionProblems, newTokenKey, groupNameFor, ruleNameFor }
  from '../src/services/deriveProtection.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

const SERVERS = [
  { _id: 'o', name: 'selectel', wmspanelServerId: 'W-O' },
  { _id: 'e2', name: 'RU-2', wmspanelServerId: 'W-E2' },
];
const NET = { name: 'prod', nodes: [
  { id: 'n-o', role: 'origin', server: 'o', enabled: true },
  { id: 'n-2', role: 'edge', server: 'e2', upstream: ['n-o'], enabled: true },
] };
const CH = (over = {}) => ({ application: 'test2', stream: 'main', protection: { mode: 'open' }, ...over });
const tok = (over = {}) => CH({ protection: { mode: 'token', tokenKey: 'k', validMinutes: 20, ...over } });

console.log('\nUNPROTECTED IS AN ANSWER, NOT AN OVERSIGHT:');

check('an open channel derives nothing and complains about nothing', () => {
  // Most streams are meant to be watchable. A panel that treats "open" as a
  // fault nags about the normal case until nobody reads it.
  const d = deriveProtection({ network: NET, servers: SERVERS, channels: [CH()] });
  assert.equal(d.items.length, 0);
  assert.deepEqual(d.problems, []);
  assert.equal(d.inSync, true);
});

console.log('\nONE GROUP PER NETWORK, ONE RULE PER CHANNEL:');

check('a protected channel derives a group and a rule', () => {
  const d = deriveProtection({ network: NET, servers: SERVERS, channels: [tok()] });
  assert.deepEqual(d.items.map(i => i.kind), ['wmsauth-group', 'wmsauth-rule']);
  assert.equal(d.items[0].subject, groupNameFor(NET));
  assert.equal(d.items[1].subject, ruleNameFor(tok()));
});

check('two protected channels share one group', () => {
  // A group per channel would leave an account nobody can read — and somebody
  // will read it, because this panel does not yet do everything.
  const d = deriveProtection({
    network: NET, servers: SERVERS,
    channels: [tok(), { ...tok(), stream: 'second' }],
  });
  assert.equal(d.items.filter(i => i.kind === 'wmsauth-group').length, 1);
  assert.equal(d.items.filter(i => i.kind === 'wmsauth-rule').length, 2);
});

check('the group carries the network\'s servers', () => {
  const d = deriveProtection({ network: NET, servers: SERVERS, channels: [tok()] });
  assert.deepEqual(d.items[0].detail.servers.sort(), ['W-E2', 'W-O']);
});

check('an existing group with the same servers is kept, not rewritten', () => {
  const d = deriveProtection({
    network: NET, servers: SERVERS, channels: [tok()],
    existing: { groups: [{ id: 'g1', name: groupNameFor(NET), server_ids: ['W-O', 'W-E2'] }] },
  });
  assert.equal(d.items[0].action, 'keep');
});

check('a group whose servers have changed is updated', () => {
  const d = deriveProtection({
    network: NET, servers: SERVERS, channels: [tok()],
    existing: { groups: [{ id: 'g1', name: groupNameFor(NET), server_ids: ['W-O'] }] },
  });
  assert.equal(d.items[0].action, 'update');
});

console.log('\nTHE KEY IS NEVER IN A PLAN:');

check('a derived rule reports that a key exists, not what it is', () => {
  // A plan is previewed, logged, and sometimes pasted into a chat.
  const d = deriveProtection({ network: NET, servers: SERVERS, channels: [tok()] });
  const rule = d.items.find(i => i.kind === 'wmsauth-rule');
  assert.equal(rule.detail.hasKey, true);
  assert.equal(JSON.stringify(d).includes('"k"'), false, 'the signing key leaked into the plan');
});

check('a generated key is long enough to be a secret', () => {
  const k = newTokenKey();
  assert.ok(k.length >= 30, `${k.length} chars`);
  assert.notEqual(newTokenKey(), k);
});

console.log('\nWHAT DEFEATS PROTECTION, AND WHAT MERELY WEAKENS IT:');

check('HTTP Origin defeats protection and blocks', () => {
  // Softvelum's own FAQ. The operator sees a rule, sees a signed link, and the
  // stream is open.
  const p = protectionProblems({ channel: tok(), originApps: [{ application: 'test2' }] });
  const f = p.find(x => x.code === 'http-origin-defeats-protection');
  assert.equal(f?.severity, 'block');
});

check('token protection without a key cannot work', () => {
  const p = protectionProblems({ channel: tok({ tokenKey: '' }) });
  assert.ok(p.some(x => x.code === 'no-token-key' && x.severity === 'block'));
});

check('a validity window long enough to be shared is a warning, not a refusal', () => {
  // The operator may have a reason. Refusing would be the panel deciding.
  const p = protectionProblems({ channel: tok({ validMinutes: 60 * 24 * 7 }) });
  assert.equal(p.find(x => x.code === 'very-long-validity')?.severity, 'warn');
});

check('referer protection is stated as advisory', () => {
  // It is a header the client sends, and a client may decline to. Better said
  // where the choice is made than after somebody watches with curl.
  const p = protectionProblems({ channel: CH({ protection: { mode: 'referer', allowedDomains: ['x.com'] } }) });
  assert.equal(p.find(x => x.code === 'referer-is-advisory')?.severity, 'note');
});

console.log('\nA LIST THAT LOCKS EVERYONE OUT:');

check('an allow-list with nothing in it is caught', () => {
  // One empty array away at all times, and it locks out the operator too.
  const geo = protectionProblems({ channel: CH({ protection: { mode: 'geo', countries: [], countriesAllow: true } }) });
  assert.ok(geo.some(x => x.code === 'allow-list-empty'));
  const ip = protectionProblems({ channel: CH({ protection: { mode: 'ip', ranges: [], rangesAllow: true } }) });
  assert.ok(ip.some(x => x.code === 'allow-list-empty'));
});

check('a country that is not a country is refused', () => {
  const p = protectionProblems({ channel: CH({ protection: { mode: 'geo', countries: ['RU', 'Russia'] } }) });
  assert.equal(p.find(x => x.code === 'bad-country-code')?.severity, 'block');
});

check('a range that is not a range is refused', () => {
  const p = protectionProblems({ channel: CH({ protection: { mode: 'ip', ranges: ['10.0.0.0/8', 'somewhere'] } }) });
  assert.deepEqual(p.find(x => x.code === 'bad-range')?.ranges, ['somewhere']);
});

console.log('\nBLOCKED IS NOT IN SYNC:');

check('a blocking problem keeps the plan out of sync even with nothing pending', () => {
  const d = deriveProtection({
    network: NET, servers: SERVERS, channels: [tok()],
    originApps: [{ application: 'test2' }],
    existing: {
      groups: [{ id: 'g1', name: groupNameFor(NET), server_ids: ['W-O', 'W-E2'] }],
      rules: [{ id: 'r1', name: ruleNameFor(tok()) }],
    },
  });
  assert.equal(d.summary.create, 0);
  assert.equal(d.inSync, false, 'everything is written and the protection does not work');
});

console.log('\nTHE KEY DOES NOT LEAVE THE SERVER:');

const { readFileSync } = await import('node:fs');
const routes = readFileSync(new URL('../src/routes/channels.js', import.meta.url), 'utf8');
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = strip(routes);

check('the API returns whether a key exists, never the key', () => {
  // A response is looked at over shoulders, logged by proxies, and pasted into
  // chats. Whoever holds this string can mint links for the channel.
  assert.ok(/hasKey: Boolean\(c\.protection\?\.tokenKey\)/.test(code), 'no hasKey flag');
  assert.ok(!/tokenKey: c\.protection/.test(code), 'the key is returned by the API');
});

check('a key is generated, never accepted from a client', () => {
  // A key that arrived over the wire has been somewhere, and the operator has
  // no way to know where.
  assert.ok(/newTokenKey\(\)/.test(code), 'nothing generates a key');
  assert.ok(!/tokenKey = (p|b)\.(tokenKey|protection)/.test(code), 'a client-supplied key is stored');
});

check('signing happens on the server, with the stored key', () => {
  assert.ok(/key: c\.protection\.tokenKey/.test(code), 'the sign endpoint does not use the stored key');
  assert.ok(/channels\/:id\/sign/.test(code));
});

check('a channel that is not token-protected cannot be signed', () => {
  // Otherwise the panel hands out a signature for a rule that does not exist,
  // and the link works — until protection is switched on and it does not.
  assert.ok(/channel-not-token-protected/.test(code));
});

check('signing is audited with what it was bound to, not with the key', () => {
  const i = code.indexOf("'cdn.channel.sign'");
  assert.ok(i > 0, 'signing is not audited');
  const entry = code.slice(i, i + 240);
  assert.ok(/boundToIp/.test(entry));
  assert.ok(!/tokenKey/.test(entry), 'the audit log records the signing key');
});

console.log('\nAPPLYING IS AS CAREFUL AS THE ROUTES WERE:');

check('the plan is recomputed on apply, not taken from the page', () => {
  // The account changes between a preview and a press, and the change that
  // matters most — an application put into HTTP Origin mode — is invisible
  // from the page entirely.
  const apply = code.slice(code.indexOf("protection/apply"), code.indexOf("channels/:id/sign"));
  assert.ok(/deriveProtection\(\{ network, servers, channels/.test(apply), 'the plan is trusted from the client');
  assert.ok(/plan\.blocking\?\.length/.test(apply), 'a blocked plan is applied anyway');
});

check('a group that existed before this run is not rolled back', () => {
  // It may carry rules for channels this run knows nothing about. Undoing
  // only what was made is the difference between a rollback and an outage.
  const apply = code.slice(code.indexOf("protection/apply"), code.indexOf("channels/:id/sign"));
  assert.ok(/created\.groups/.test(apply) && /created\.rules/.test(apply));
  assert.ok(/for \(const g of created\.groups\.reverse\(\)\)/.test(apply), 'rollback is not limited to what was created');
});

check('a create with no id looks for the object before undoing', () => {
  // A response without an id is not proof that nothing was written, and
  // deleting on that assumption removes a group that exists. Same lesson as
  // the routes, applied before it could cost anything.
  const apply = code.slice(code.indexOf("protection/apply"), code.indexOf("channels/:id/sign"));
  assert.ok(/authGroupList\(cfg\)\.catch/.test(apply));
});

check('a rule names one application and stream, not a pattern', () => {
  // A regular expression that matches more than intended protects more than
  // intended, which sounds harmless right up until an unrelated stream stops
  // playing.
  const apply = code.slice(code.indexOf("protection/apply"), code.indexOf("channels/:id/sign"));
  assert.ok(/application: channel\.application/.test(apply));
  assert.ok(/stream: channel\.stream/.test(apply));
  assert.ok(!/regex|regexp|\.\*/.test(apply), 'the rule is built from a pattern');
});

console.log('\nTHE DIALOG SAYS WHAT EACH CHOICE COSTS:');

const front = readFileSync(new URL('../../frontend/src/components/ChannelsPanel.jsx', import.meta.url), 'utf8');
const dict = readFileSync(new URL('../../frontend/src/i18n.jsx', import.meta.url), 'utf8');

check('every protection mode has a note, in both languages', () => {
  // Each of these has a catch — referer is advisory, IP binding breaks on a
  // network change, a key swap invalidates issued links — and the place to say
  // so is where the choice is made.
  for (const m of ['open', 'token', 'referer', 'geo', 'ip']) {
    assert.equal((dict.match(new RegExp(`'ch\\.prot\\.${m}\\.note':`, 'g')) || []).length, 2, m);
  }
});

check('the key is never rendered, only its existence', () => {
  assert.ok(/protection\.hasKey/.test(front), 'the dialog does not report whether a key exists');
  assert.ok(!/protection\.tokenKey/.test(front), 'the dialog renders the signing key');
});

check('replacing a key warns that issued links die', () => {
  assert.ok(/ch\.keyWillChange/.test(front));
});

console.log(failures ? `\n${failures} protection check(s) failed` : '\nall protection checks passed');
process.exit(failures ? 1 : 0);
