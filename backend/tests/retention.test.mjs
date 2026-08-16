// Nothing may grow without a ceiling.
//
// The panel's own machine stopped: 96 GB full, services down, a Redis journal
// truncated mid-write. Four things had no bound, and each was reasonable on
// its own:
//
//   auditlogs      8.6 million rows, 50 GB — of which fourteen were people.
//                  Every agent poll is a POST, and the rule was "audit every
//                  mutating request".
//   backups        Fourteen archives, counted by file. The database grew from
//                  228 MB to 7 GB in twelve days, so fourteen became 34 GB.
//   docker logs    4 GB, no max-size.
//   mongodump      Wrote until the disk ran out rather than refusing.
//
// None was a bug. Each was a limit expressed in the wrong unit, or against a
// subject that changed. These checks are about the ceilings, not the numbers.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// A named import: this build of js-yaml has no default export, and the
// difference is a module that will not load rather than a value that is
// undefined at the point of use.
import { load as loadYaml } from 'js-yaml';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

console.log('\nMACHINE TRAFFIC IS NOT AN AUDIT TRAIL:');

const audit = read('backend/src/services/audit.js');

check('agent polling is not written to the audit log', () => {
  // 8.6 million rows, fourteen of them people. Audit answers "who did what",
  // and a polling loop is not a who.
  assert.ok(/MACHINE_ROUTES/.test(audit), 'every mutating request is still audited');
  assert.ok(/agent-gw/.test(audit), 'the agent gateway is still audited');
  assert.ok(/full\.startsWith\(prefix\)/.test(audit), 'the exclusion does not match by path');
});

check('the exclusion is a short list of machine routes, not an allow-list', () => {
  // A new operator action must be audited by default rather than by somebody
  // remembering to add it.
  const m = /const MACHINE_ROUTES = \[([\s\S]*?)\]/.exec(audit);
  assert.ok(m, 'the machine routes are not listed');
  const entries = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  assert.ok(entries.length <= 4, `${entries.length} routes excluded — this is becoming an allow-list`);
  for (const e of entries) assert.ok(e.startsWith('/'), `${e} is not a path prefix`);
});

console.log('\nEVERY COLLECTION THAT GROWS HAS A CEILING:');

const models = readdirSync(path.join(ROOT, 'backend/src/models'));

check('anything written by a loop expires or is capped', () => {
  // Named individually: these are the ones a running panel appends to without
  // an operator doing anything, and an unbounded one of these is what filled
  // the disk.
  for (const name of ['AuditLog', 'StatSample', 'LogRecord', 'AgentTask', 'AgentEvent',
                      'ApiUsage', 'DeliveryCheck', 'AgentEnrollment']) {
    const src = read(`backend/src/models/${name}.js`);
    assert.ok(/expireAfterSeconds|capped:/.test(src),
      `${name} is appended to by the panel itself and has no ceiling`);
  }
});

check('the audit window is not a quarter any more', () => {
  // Ninety days was chosen when this held operator actions only. It then held
  // every agent poll as well.
  const m = /expireAfterSeconds: (\d+) \* 24 \* 3600/.exec(read('backend/src/models/AuditLog.js'));
  assert.ok(m, 'the audit retention is no longer expressed in days');
  assert.ok(Number(m[1]) <= 30, `${m[1]} days of audit on the panel's own disk`);
});

console.log('\nBACKUPS ARE BOUNDED IN BYTES, NOT IN FILES:');

const cli = read('packaging/nnm-control-cli');

check('a total size cap, because counting files assumes they stay the same size', () => {
  // Fourteen archives of 228 MB is 3 GB. Fourteen of 7 GB is 98 GB, on a 96 GB
  // disk. The count never changed; the database did.
  assert.ok(/NNM_BACKUP_MAX_GB/.test(cli), 'backups are capped by count alone');
  assert.ok(/du -sm "\$BDIR"/.test(cli), 'nothing measures the directory');
  // And the default is a number that fits on a disk. A cap of 999999 is a
  // variable, not a limit — the check passed on one, which is the difference
  // between testing that a mechanism exists and testing that it binds.
  const dflt = /MAXGB=\$\{MAXGB:-(\d+)\}/.exec(cli);
  assert.ok(dflt, 'the size cap has no default');
  assert.ok(Number(dflt[1]) <= 50, `the default cap is ${dflt[1]}GB, which bounds nothing`);
});

check('it refuses rather than filling the disk', () => {
  // mongodump writes until it runs out of room, and a machine with no free
  // space stops answering — which is how this was found.
  assert.ok(/FREE_MB/.test(cli) && /Not enough room/.test(cli),
    'the dump starts without checking there is room for it');
  assert.ok(/NEED_MB=\$\(\( \$\(du -m "\$LAST" \| cut -f1\) \* 2 \)\)/.test(cli),
    'the estimate does not come from the last archive');
});

check('a failed dump does not leave something that looks like a backup', () => {
  // Worse than none, because it would be restored.
  assert.ok(/rm -f "\$F"/.test(cli), 'a partial archive survives a failed dump');
});

check('the size cap never deletes the only archive left', () => {
  assert.ok(/-le 1 \] && break/.test(cli), 'a small cap would delete the backup just taken');
});

console.log('\nCONTAINER LOGS HAVE A CEILING TOO:');

for (const file of ['docker-compose.yml', 'docker-compose.dev.yml']) {
  check(`${file}: only services carry service keys`, () => {
    // `logging` on a volume is not a harmless extra: compose validates its
    // schema and refuses the whole file, so the panel would not start at all.
    // A script of mine added it by matching two-space indentation, which is
    // also how volume names are written — and I checked the result with a YAML
    // parser rather than with the thing that would run it. That is the same
    // lesson as `sh -n`, one day later, unapplied.
    const doc = loadYaml(read(file));
    const SERVICE_ONLY = ['logging', 'image', 'restart', 'ports', 'environment',
                          'depends_on', 'command', 'healthcheck', 'build'];
    for (const section of ['volumes', 'networks', 'configs', 'secrets']) {
      for (const [name, body] of Object.entries(doc[section] || {})) {
        if (!body || typeof body !== 'object') continue;
        for (const key of SERVICE_ONLY) {
          assert.ok(!(key in body),
            `${section}.${name} has "${key}", which compose only allows on a service — `
            + 'the file will be rejected and nothing will start');
        }
      }
    }
  });

  check(`${file}: every service caps its log`, () => {
    // Four gigabytes accumulated before anybody looked.
    const doc = loadYaml(read(file));
    const services = Object.entries(doc.services || {});
    assert.ok(services.length, 'no services found');
    for (const [name, svc] of services) {
      assert.ok(svc.logging?.options?.['max-size'], `${name} has no max-size`);
      assert.ok(svc.logging?.options?.['max-file'], `${name} has no max-file`);
    }
  });
}

console.log('\nOLD MACHINE TRAFFIC CAN BE SWEPT FROM THE PANEL:');

const auditSvc = read('backend/src/services/audit.js');
const auditRoutes = read('backend/src/routes/audit.js');
const auditPage = read('frontend/src/pages/AuditPage.jsx');

check('the sweep matches exactly what the middleware no longer records', () => {
  // Built from the same list, so "what we do not write" and "what can be
  // removed" cannot drift into two different answers — which would either
  // leave rows behind forever or delete somebody's actions.
  assert.ok(/export const MACHINE_ROUTES/.test(auditSvc), 'the route list is not shared');
  assert.ok(/MACHINE_ROUTES\s*\n?\s*\.map/.test(auditSvc), 'the filter is written out separately');
});

check('the count is shown before anything is deleted', () => {
  // Deleting millions of rows from a log people rely on is not something to
  // learn the size of afterwards.
  assert.ok(/'\/sweepable'/.test(auditRoutes), 'nothing counts first');
  assert.ok(/keeping:/.test(auditRoutes), 'it does not say what survives');
});

check('the operator confirms the number they were shown', () => {
  // Agreeing to "delete 8,598,036 rows" is a different act from clicking a
  // button that happened to be under the cursor.
  // The conditions, not the strings. `if (false)` leaves both messages in the
  // file and unreachable, and a check that greps passes on it — which is what
  // the first version of this did, twice in the same block.
  assert.ok(/if \(!Number\.isFinite\(expected\)\)/.test(auditRoutes),
    'a sweep runs without confirmation');
  assert.ok(/if \(Math\.abs\(actual - expected\) >/.test(auditRoutes),
    'a count that changed since the operator looked is deleted anyway');
  assert.ok(/confirm-count-required/.test(auditRoutes) && /count-changed/.test(auditRoutes),
    'the refusals have no codes of their own');
  assert.ok(/expect: sweep\.machine/.test(auditPage), 'the panel does not send back what it showed');
});

check('sweeping is its own permission', () => {
  // Somebody who may read the audit trail is not automatically somebody who
  // may delete part of it.
  assert.ok(/audit\.manage/.test(read('backend/src/permissions.js')), 'the permission is not declared');
  assert.ok(/requirePerm\('audit\.manage'\)/.test(auditRoutes));
  assert.ok(/requireAuth, requirePerm\('audit\.manage'\)/.test(auditRoutes),
    'the permission check has no authenticated user');
});

check('it compacts, because deleting rows returns no disk', () => {
  // WiredTiger does not shrink its file. A sweep that frees nothing looks
  // broken, and the operator came here because the disk was full.
  assert.ok(/compact:/.test(auditRoutes), 'nothing reclaims the space');
  assert.ok(/aud\.sweepCompact/.test(auditPage), 'the lock it takes is not mentioned');
});

check('nothing calls a driver method this Mongoose no longer has', () => {
  // `collection.stats()` was removed from the driver Mongoose 8 carries. The
  // call threw at runtime, the panel's catch swallowed it, and the button was
  // simply absent — indistinguishable from "nothing to sweep". Checked against
  // the installed driver rather than against a list of names, so this stays
  // true across upgrades.
  const mongoose = require('mongoose');
  const coll = mongoose.connection.collection('probe');
  const REMOVED = ['stats', 'count', 'ensureIndex', 'group', 'mapReduce'];
  const gone = REMOVED.filter(m => typeof coll[m] !== 'function');
  assert.ok(gone.length, 'nothing is actually removed in this driver — this check has lost its subject');

  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(dir)) {
      const p2 = path.join(dir, e);
      if (statSync(p2).isDirectory()) walk(p2);
      else if (e.endsWith('.js')) files.push(p2);
    }
  })(path.join(ROOT, 'backend/src'));

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of gone) {
      const re = new RegExp(`\\.collection\\.${m}\\(`);
      assert.ok(!re.test(src),
        `${path.relative(ROOT, file)} calls collection.${m}(), which this driver does not provide`);
    }
  }
});

check('a count that cannot be read leaves a working page', () => {
  // A number the panel could not fetch is worth a null; an exception is worth
  // neither, and this one hid the whole feature.
  assert.ok(/async function collectionSize\(\)/.test(auditRoutes), 'the size read is not isolated');
  assert.ok(/return null;/.test(auditRoutes), 'a failed size read takes the request with it');
  // In the catch, not merely somewhere in the file: declaring the state and
  // never setting it on failure leaves the button absent and silent, and a
  // check that greps passes on exactly that.
  const catchBlock = auditPage.slice(auditPage.indexOf("api('/audit/sweepable')"),
                                     auditPage.indexOf('const doSweep'));
  assert.ok(/catch \(e\)[\s\S]*setSweepError\(/.test(catchBlock),
    'the panel still hides a failure as an absent button');
  assert.ok(/sweepError &&/.test(auditPage), 'the message is stored and never shown');
});

console.log(failures ? `\n${failures} retention check(s) failed` : '\nall retention checks passed');
process.exit(failures ? 1 : 0);
