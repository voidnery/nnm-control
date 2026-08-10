import { Router } from 'express';
import dns from 'node:dns/promises';
import net from 'node:net';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { status as geoStatus, lookup, ATTRIBUTION, EDITIONS } from '../services/geoip.js';
import { downloadEdition } from '../services/geoipUpdate.js';
import { logEvent } from '../services/audit.js';

export const geoipRouter = Router();
geoipRouter.use(requireAuth);

// Only one update may run at a time. Two concurrent downloads of a 124 MB file
// racing to rename onto the same path is not a theoretical problem: the button
// is in a page an operator will click twice when it feels slow.
let running = null;

geoipRouter.get('/geoip', requirePerm('cdn.view'), async (_req, res) => {
  res.json({ ...(await geoStatus()), updating: Boolean(running) });
});

geoipRouter.post('/geoip/update', requirePerm('cdn.manage'), async (req, res) => {
  const edition = String(req.body?.edition || 'country');
  if (!EDITIONS[edition]) return res.status(400).json({ error: `unknown edition: ${edition}` });
  if (running) return res.status(409).json({ error: 'an update is already running' });
  running = downloadEdition(edition);
  try {
    const r = await running;
    await logEvent(req, 'geoip.update', { edition, ok: r.ok, release: r.release, error: r.error });
    res.status(r.ok ? 200 : 502).json({ ...r, attribution: ATTRIBUTION });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  } finally { running = null; }
});

// The address actually looked up. `host` on a server may be a name, and which
// address it resolved to is the difference between an answer an operator can
// check and one they can only believe.
async function addressOf(host) {
  if (net.isIP(host)) return { ip: host, via: 'literal' };
  const { address } = await dns.lookup(host);
  return { ip: address, via: 'dns' };
}

// Resolve one server. Never overwrites a manual entry: DB-IP infers a location
// from a routing prefix, the operator knows which rack the machine is in.
geoipRouter.post('/servers/:id/geo/resolve', requirePerm('cdn.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  let ip, via;
  try { ({ ip, via } = await addressOf(server.host)); }
  catch (e) { return res.status(422).json({ error: `cannot resolve ${server.host}: ${e.message}` }); }

  const r = await lookup(ip);
  if (!r.ok) return res.status(r.reason === 'no-database' ? 409 : 422).json({ error: r.reason, ip, via });

  const manualCountry = server.geo?.source === 'manual';
  const manualCoords = server.geo?.coordsSource === 'manual';
  if (!manualCountry) {
    server.geo.countryCode = r.countryCode;
    server.geo.countryName = r.countryName;
    server.geo.city = r.city;
    server.geo.source = 'auto';
  }
  // Coordinates move only when the loaded edition actually has them. The
  // Country edition resolves a country and carries no coordinates at all, and
  // inventing a centroid here would put a marker on the globe that no
  // measurement backs.
  if (!manualCoords && r.hasCoordinates) {
    server.geo.lat = r.lat;
    server.geo.lon = r.lon;
    server.geo.coordsSource = 'auto';
  }
  server.geo.resolvedIp = ip;
  server.geo.resolvedAt = new Date();
  server.geo.edition = r.edition || '';
  server.geo.release = r.release || '';
  await server.save();

  res.json({
    ok: true, ip, via, geo: server.geo,
    keptManual: { country: manualCountry, coordinates: manualCoords },
    coordinatesAvailable: r.hasCoordinates,
    attribution: ATTRIBUTION,
  });
});

geoipRouter.put('/servers/:id/geo', requirePerm('cdn.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const b = req.body || {};

  if (b.countryCode !== undefined) {
    const cc = String(b.countryCode).trim().toUpperCase();
    if (cc && !/^[A-Z]{2}$/.test(cc)) return res.status(400).json({ error: 'countryCode must be ISO-3166 alpha-2' });
    server.geo.countryCode = cc;
    server.geo.countryName = String(b.countryName ?? server.geo.countryName ?? '');
    server.geo.city = String(b.city ?? server.geo.city ?? '');
    server.geo.source = cc ? 'manual' : '';
  }
  if (b.lat !== undefined || b.lon !== undefined) {
    const lat = b.lat === null || b.lat === '' ? null : Number(b.lat);
    const lon = b.lon === null || b.lon === '' ? null : Number(b.lon);
    if (lat !== null && !(lat >= -90 && lat <= 90)) return res.status(400).json({ error: 'lat must be between -90 and 90' });
    if (lon !== null && !(lon >= -180 && lon <= 180)) return res.status(400).json({ error: 'lon must be between -180 and 180' });
    // Half a coordinate is not a position. Rejecting it here keeps a marker
    // from landing on the null island.
    if ((lat === null) !== (lon === null)) return res.status(400).json({ error: 'lat and lon must be set or cleared together' });
    server.geo.lat = lat; server.geo.lon = lon;
    server.geo.coordsSource = lat === null ? '' : 'manual';
  }
  await server.save();
  await logEvent(req, 'server.geo.edit', { serverId: String(server._id), geo: server.geo });
  res.json({ ok: true, geo: server.geo });
});
