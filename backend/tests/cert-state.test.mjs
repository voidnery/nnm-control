// A certificate has more than two states, and each has a different fix.
//
// The panel used to know "a path is configured" or "it is not", which decides
// nothing. Worse, its one suggestion — reissue — is wrong for the case that
// looks most like it needs one: a certificate that does not cover the name
// this edge is reached by will come back identical however many times it is
// reissued.
//
// And the parts diagnosis: the panel named both possible causes and left the
// operator to find out which. It can read `alhls_enabled` through the same API
// it writes it with, so it does.

import assert from 'node:assert/strict';
import { certificateVerdict, partsDiagnosis, ACTIONS, WARN_DAYS } from '../src/services/certState.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

console.log('Certificate state\n');

const now = new Date('2026-08-19T00:00:00Z');
const inDays = (n) => new Date(now.getTime() + n * 86400000).toISOString();
const good = { tls: true, certTrusted: true, certExpired: false, certExpiresAt: inDays(89) };

check('a working certificate is left alone, and says so', () => {
  const v = certificateVerdict({ tls: good, certDomain: 'edge.example.ru', now });
  assert.equal(v.state, 'ok');
  assert.equal(v.action, ACTIONS.keep);
  assert.equal(v.daysLeft, 89);
});

check('nothing read from the wire is not "there is no certificate"', () => {
  // Two different problems: nobody looked, versus looked and found none.
  const unread = certificateVerdict({ tls: null, certDomain: 'e.ru', configuredPath: '/etc/x/fullchain.pem', now });
  assert.equal(unread.state, 'unreadable');
  assert.equal(unread.action, null, 'an action was recommended on no evidence');
  const none = certificateVerdict({ tls: null, configuredPath: null, now });
  assert.equal(none.state, 'none');
  assert.equal(none.action, ACTIONS.issue);
});

check('an expired certificate is reissued, not re-diagnosed', () => {
  const v = certificateVerdict({ tls: { ...good, certExpired: true, certExpiresAt: inDays(-3) },
                                 certDomain: 'e.ru', now });
  assert.equal(v.state, 'expired');
  assert.equal(v.action, ACTIONS.reissue);
});

check('a name mismatch asks for a different name, because reissuing repeats it', () => {
  // The case that looks most like it needs a reissue and is the one reissuing
  // cannot fix.
  const v = certificateVerdict({
    tls: { ...good, certTrusted: false, certError: 'Hostname/IP does not match certificate\'s altnames' },
    certDomain: 'e.ru', now,
  });
  assert.equal(v.state, 'wrong-domain');
  assert.equal(v.action, ACTIONS['change-domain']);
  assert.notEqual(v.action, ACTIONS.reissue, 'the panel would send the operator round the same loop');
});

check('an untrusted certificate for another reason is reissued', () => {
  const v = certificateVerdict({
    tls: { ...good, certTrusted: false, certError: 'unable to verify the first certificate' },
    certDomain: 'e.ru', now,
  });
  assert.equal(v.state, 'untrusted');
  assert.equal(v.action, ACTIONS.reissue);
});

check('the expiry warning sits outside certbot\'s own renewal window', () => {
  assert.ok(WARN_DAYS < 30, 'warning at 30 fires on every healthy machine for a month');
  assert.equal(certificateVerdict({ tls: { ...good, certExpiresAt: inDays(10) }, now }).state, 'expiring');
  assert.equal(certificateVerdict({ tls: { ...good, certExpiresAt: inDays(40) }, now }).state, 'ok');
});

check('every verdict carries a reason, because the action alone is an instruction to obey', () => {
  for (const t of [{ tls: good }, { tls: null }, { tls: { ...good, certExpired: true } },
                   { tls: { ...good, certTrusted: false, certError: 'x' } }]) {
    const v = certificateVerdict({ ...t, now });
    assert.ok(v.why && v.why.length > 30, `${v.state} has no explanation`);
  }
});

// --- which of the two causes ------------------------------------------------

console.log('');

check('parts present is the end of it', () => {
  assert.equal(partsDiagnosis({ playlist: { lowLatency: { confirmed: true } } }).state, 'ok');
});

check('the checkbox being off is named, not offered as one of two guesses', () => {
  const d = partsDiagnosis({ application: { alhls_enabled: false }, playlist: { lowLatency: {} } });
  assert.equal(d.state, 'off-in-wmspanel');
  assert.equal(d.action, 'enable');
});

check('on in WMSPanel with no parts is the restart, definitely', () => {
  const d = partsDiagnosis({ application: { alhls_enabled: true }, playlist: { lowLatency: {} } });
  assert.equal(d.state, 'needs-restart');
});

check('an unreadable application says so rather than picking a cause', () => {
  const d = partsDiagnosis({ application: null, playlist: { lowLatency: {} } });
  assert.equal(d.state, 'application-unknown');
  assert.match(d.why, /two possibilities/);
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall certificate state checks passed');
process.exit(failures ? 1 : 0);
