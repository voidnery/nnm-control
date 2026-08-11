import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { Reader } from 'maxmind';

// Where a Nimble server physically is, answered offline.
//
// The panel has to know a node's country to place it in a delivery network,
// and asking a third-party API would mean sending the IP of every server in
// the fleet to someone else on every lookup. So the lookup is a local MMDB
// file, fetched on demand into the data volume.
//
// The database is DB-IP Lite, CC BY 4.0. The licence is not decoration: it
// requires a visible link back to db-ip.com on any page that shows results
// from it, which is why `attribution` travels with every answer and why
// audit:attribution exists.
export const ATTRIBUTION = {
  text: 'IP Geolocation by DB-IP',
  url: 'https://db-ip.com',
  licence: 'CC BY 4.0',
  licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
};

// Both editions are MaxMind-DB format and both are free under CC BY 4.0.
// Country is the default and it is not a compromise: it is 15x smaller *and*
// DB-IP rates it more accurate than City (index 81 vs 77), because city
// granularity adds error it does not remove. City exists only because it
// carries approximate coordinates, which Country does not.
export const EDITIONS = {
  country: {
    id: 'country',
    slug: 'dbip-country-lite',
    label: 'DB-IP Country Lite',
    approxBytes: 7.9e6,
    accuracyIndex: 81,
    hasCoordinates: false,
    page: 'https://db-ip.com/db/download/ip-to-country-lite',
  },
  city: {
    id: 'city',
    slug: 'dbip-city-lite',
    label: 'DB-IP City Lite',
    approxBytes: 124.2e6,
    accuracyIndex: 77,
    hasCoordinates: true,
    page: 'https://db-ip.com/db/download/ip-to-city-lite',
  },
};

export const GEOIP_DIR = process.env.GEOIP_DIR || '/var/lib/nnm-control/geoip';
const activePath = () => path.join(GEOIP_DIR, 'active.mmdb');
const metaPath = () => path.join(GEOIP_DIR, 'active.json');

// Releases are monthly, published on the 1st. The URL carries the release, so
// it has to be built rather than guessed at random: this is the only shape
// db-ip.com serves, taken from their download page.
export const downloadUrl = (edition, year, month) =>
  `https://download.db-ip.com/free/${EDITIONS[edition].slug}-${year}-${String(month).padStart(2, '0')}.mmdb.gz`;

// The releases worth trying, newest first. The current month's file does not
// exist until the 1st has passed in DB-IP's timezone, and a panel started on
// the 1st should fall back rather than report the database missing.
export function candidateReleases(now = new Date(), depth = 3) {
  const out = [];
  for (let i = 0; i < depth; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  }
  return out;
}

let cache = null;   // { reader, mtimeMs }

async function readMeta() {
  try { return JSON.parse(await fs.readFile(metaPath(), 'utf8')); }
  catch { return null; }
}

async function reader() {
  let st;
  try { st = await fs.stat(activePath()); } catch { cache = null; return null; }
  if (cache && cache.mtimeMs === st.mtimeMs) return cache.reader;
  const buf = await fs.readFile(activePath());
  cache = { reader: new Reader(buf), mtimeMs: st.mtimeMs };
  return cache.reader;
}

export function invalidateCache() { cache = null; }

export async function status() {
  const meta = await readMeta();
  let size = 0, present = false, databaseType = '', buildEpoch = null;
  try {
    const st = await fs.stat(activePath());
    size = st.size; present = true;
    const r = await reader();
    if (r) { databaseType = r.metadata.databaseType; buildEpoch = r.metadata.buildEpoch; }
  } catch { present = false; }
  return {
    present,
    edition: meta?.edition || null,
    release: meta?.release || null,
    installedAt: meta?.installedAt || null,
    databaseType, size,
    builtAt: buildEpoch ? new Date(buildEpoch * 1000).toISOString() : null,
    hasCoordinates: meta?.edition ? EDITIONS[meta.edition].hasCoordinates : false,
    editions: Object.values(EDITIONS),
    attribution: ATTRIBUTION,
  };
}

// One shape out, whichever edition is loaded. A Country database simply has
// no coordinates, and saying so is the point: the caller must not fill them in
// from somewhere else and present the result as measured.
export function shape(record, edition) {
  if (!record) return null;
  const c = record.country || record.registered_country || null;
  const loc = record.location || null;
  return {
    countryCode: c?.iso_code || '',
    countryName: c?.names?.en || '',
    city: record.city?.names?.en || '',
    lat: typeof loc?.latitude === 'number' ? loc.latitude : null,
    lon: typeof loc?.longitude === 'number' ? loc.longitude : null,
    hasCoordinates: Boolean(EDITIONS[edition]?.hasCoordinates && typeof loc?.latitude === 'number'),
  };
}

// Addresses that no geolocation database can ever answer for, because they are
// not on the public internet: RFC1918, loopback, link-local, carrier-grade NAT
// and their IPv6 equivalents.
//
// This matters because the honest answer is completely different from "not in
// the database". A public address that is missing might appear in next month's
// release; 192.168.200.129 never will, from any vendor, ever — the operator
// has to type the location in, and telling them "not found" sends them to
// re-download a database instead.
export function addressScope(ip) {
  if (!net.isIP(ip)) return 'invalid';
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return 'private';
    if (a === 127) return 'loopback';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 169 && b === 254) return 'link-local';
    if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
    if (a === 0 || a >= 224) return 'reserved';
    return 'public';
  }
  const low = ip.toLowerCase();
  if (low === '::1') return 'loopback';
  if (/^f[cd]/.test(low)) return 'private';        // fc00::/7 unique local
  if (/^fe[89ab]/.test(low)) return 'link-local';  // fe80::/10
  // An IPv4 address wearing an IPv6 hat is still that address.
  const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return addressScope(mapped[1]);
  return 'public';
}

export async function lookup(ip) {
  const r = await reader();
  if (!r) return { ok: false, reason: 'no-database' };
  // Checked here rather than left to the reader: it answers null for garbage,
  // which is the same answer it gives for an address that is simply absent,
  // and those two need different words in front of an operator.
  if (!net.isIP(ip)) return { ok: false, reason: 'bad-address' };
  const scope = addressScope(ip);
  if (scope !== 'public') return { ok: false, reason: 'private-address', scope };
  const meta = await readMeta();
  let record;
  try { record = r.get(ip); }
  catch (e) { return { ok: false, reason: 'bad-address', error: e.message }; }
  if (!record) return { ok: false, reason: 'not-found' };
  const s = shape(record, meta?.edition);
  if (!s.countryCode) return { ok: false, reason: 'not-found' };
  return { ok: true, ...s, edition: meta?.edition || null, release: meta?.release || null };
}

// Used by the installer to refuse a download that did not survive the wire.
// Opening it is the only check that matters: a file can be the right size,
// gunzip cleanly, and still not be a database.
export async function verifyFile(file) {
  const buf = await fs.readFile(file);
  const r = new Reader(buf);
  if (!r.metadata?.nodeCount) throw new Error('no node count in metadata');
  const probe = r.get('8.8.8.8');
  return { databaseType: r.metadata.databaseType, nodeCount: r.metadata.nodeCount,
           buildEpoch: r.metadata.buildEpoch, probed: Boolean(probe) };
}

export async function install(tmpFile, { edition, release }) {
  await fs.mkdir(GEOIP_DIR, { recursive: true });
  const info = await verifyFile(tmpFile);
  // The previous database stays until the new one has been verified and moved
  // into place, so a failed update leaves a working panel rather than none.
  await fs.rename(tmpFile, activePath());
  await fs.writeFile(metaPath(), JSON.stringify(
    { edition, release, installedAt: new Date().toISOString(), ...info }, null, 2));
  invalidateCache();
  return info;
}

export { activePath, metaPath, createReadStream, createWriteStream };
