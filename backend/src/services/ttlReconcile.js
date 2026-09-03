// The retention written in a schema and the retention Mongo is enforcing are
// two different facts, and nothing kept them equal.
//
// `expireAfterSeconds` is fixed when the index is created. Change the number in
// the schema and Mongoose issues `createIndex` with the new options against an
// index that already exists; the server answers `IndexOptionsConflict` (85),
// and because index building happens in the background of model
// initialisation, that error is logged at most and never surfaces. The
// collection keeps expiring on the old schedule for as long as the index
// lives, and every screen and document says otherwise.
//
// `AuditLog` went from 90 days to 30 in a comment that changed nothing on any
// machine already running. It was only ever right on this fleet by accident:
// the index was rebuilt on 2026-09-03 when the collection was dropped by hand
// during an incident, and came back at 2592000 because it was created fresh.
//
// `collMod` changes the expiry of an existing TTL index in place, without a
// rebuild. It is the one operation that makes the schema the source of truth.

// The database handle a command can actually be sent to.
//
// `Model.db` is a Mongoose Connection and has no `.command()`; calls to it
// throw a TypeError that a `catch` turns into a plausible-looking failure.
// `routes/audit.js` learned this the expensive way and its `nativeDb()` is the
// shape that works. `backend/scripts/undef-audit.mjs` fails on `.db.command(`
// for exactly this reason.
const nativeDb = (model) => model.db.getClient().db(model.db.name);

// Read what the schema asks for: every index in the model that carries an
// expiry. Taken from the model rather than a list here, so adding a TTL
// somewhere new is covered without remembering this file.
export function ttlIntent(model) {
  const out = [];
  for (const [key, options] of model.schema.indexes()) {
    if (options && Number.isFinite(options.expireAfterSeconds)) {
      out.push({
        key,
        name: options.name || Object.entries(key).map(([k, v]) => `${k}_${v}`).join('_'),
        seconds: options.expireAfterSeconds,
      });
    }
  }
  return out;
}

// What has to change, given what the schema asks and what the database has.
// Separate from doing it so it can be tested against fixtures.
export function ttlDrift(intent, existing) {
  const byName = new Map((existing || []).map(i => [i.name, i]));
  const drift = [];
  for (const want of intent) {
    const have = byName.get(want.name);
    // Absent is not drift: Mongoose creates it, and creating it with the
    // wrong number is not a thing that happens.
    if (!have) continue;
    const seconds = Number(have.expireAfterSeconds);
    if (!Number.isFinite(seconds)) {
      // An index of the same name without an expiry at all. Changing that
      // needs a drop and a rebuild, which is not something to do behind
      // somebody's back on a collection of unknown size.
      drift.push({ ...want, has: null, action: 'manual' });
      continue;
    }
    if (seconds !== want.seconds) drift.push({ ...want, has: seconds, action: 'collMod' });
  }
  return drift;
}

export async function reconcileTtl(models = []) {
  const report = [];
  for (const model of models) {
    const intent = ttlIntent(model);
    if (!intent.length) continue;
    let existing = [];
    try {
      existing = await model.collection.indexes();
    } catch (e) {
      // A collection that does not exist yet has no indexes and no drift.
      // Anything else is worth saying out loud rather than swallowing: a
      // silent catch here is how the previous version of this problem stayed
      // invisible for months.
      if (e?.codeName !== 'NamespaceNotFound') {
        console.error(`[ttl] ${model.collection.collectionName}: ${e?.message || e}`);
      }
      continue;
    }
    for (const d of ttlDrift(intent, existing)) {
      const coll = model.collection.collectionName;
      if (d.action === 'manual') {
        console.warn(`[ttl] ${coll}.${d.name} has no expiry while the schema asks for ${d.seconds}s — needs a rebuild, not changing it`);
        report.push({ collection: coll, ...d, changed: false });
        continue;
      }
      try {
        await nativeDb(model).command({
          collMod: coll,
          index: { name: d.name, expireAfterSeconds: d.seconds },
        });
        console.log(`[ttl] ${coll}.${d.name}: ${d.has}s → ${d.seconds}s`);
        report.push({ collection: coll, ...d, changed: true });
      } catch (e) {
        console.error(`[ttl] ${coll}.${d.name} could not be changed: ${e?.message || e}`);
        report.push({ collection: coll, ...d, changed: false });
      }
    }
  }
  return report;
}
