// Retention in the schema against retention in the database.
//
// These are two facts, and until 2026-09-03 nothing kept them equal.
// `expireAfterSeconds` is fixed when the index is created; editing the schema
// afterwards produces an `IndexOptionsConflict` that model initialisation
// swallows, and the collection carries on expiring on the old schedule while
// every comment says otherwise. `AuditLog` went from 90 days to 30 that way.

import assert from 'node:assert/strict';
import { ttlIntent, ttlDrift } from '../src/services/ttlReconcile.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { StatSample } from '../src/models/StatSample.js';
import { AgentTask } from '../src/models/AgentTask.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

console.log('\nTHE SCHEMA IS THE SOURCE OF TRUTH FOR RETENTION:');

check('every collection a loop writes to declares an expiry', () => {
  // Named individually because these are the ones that grow without anybody
  // doing anything, and an unbounded one of them is what filled the disk
  // twice.
  for (const model of [AuditLog, StatSample, AgentTask]) {
    assert.ok(ttlIntent(model).length,
      `${model.collection.collectionName} declares no TTL`);
  }
});

check('the audit log expires in thirty days, and the number is read from the model', () => {
  const [ttl] = ttlIntent(AuditLog);
  assert.equal(ttl.name, 'ts_ttl');
  assert.equal(ttl.seconds, 30 * 24 * 3600);
});

console.log('\nWHAT COUNTS AS DRIFT:');

const intent = ttlIntent(AuditLog);

check('an index with the wrong expiry is changed in place', () => {
  // The real case: production carried ninety days under a schema that said
  // thirty, and would have gone on doing so.
  const drift = ttlDrift(intent, [{ name: 'ts_ttl', expireAfterSeconds: 90 * 24 * 3600 }]);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].action, 'collMod');
  assert.equal(drift[0].has, 90 * 24 * 3600);
  assert.equal(drift[0].seconds, 30 * 24 * 3600);
});

check('an index that already agrees is left alone', () => {
  // MEASURED on the production panel, 2026-09-03: ts_ttl 2592000.
  assert.deepEqual(ttlDrift(intent, [{ name: 'ts_ttl', expireAfterSeconds: 2592000 }]), []);
});

check('an absent index is not drift', () => {
  // Mongoose creates it, and it creates it with the number from the schema.
  // Reporting this as drift would make every fresh install print a warning.
  assert.deepEqual(ttlDrift(intent, []), []);
  assert.deepEqual(ttlDrift(intent, [{ name: '_id_' }]), []);
});

check('an index of the same name with no expiry is flagged, not silently changed', () => {
  // `collMod` cannot add an expiry to an index that has none — that needs a
  // drop and a rebuild, which is not something to do unattended on a
  // collection of unknown size.
  const drift = ttlDrift(intent, [{ name: 'ts_ttl' }]);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].action, 'manual');
  assert.equal(drift[0].has, null);
});

check('a difference of one second is a difference', () => {
  // Not rounded, not tolerated: a comparison with slack is one that stops
  // catching the case it exists for.
  const drift = ttlDrift(intent, [{ name: 'ts_ttl', expireAfterSeconds: 2592001 }]);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].action, 'collMod');
});

if (failures) { console.log(`\n${failures} ttl check(s) failed`); process.exit(1); }
console.log('\nall ttl checks passed');
