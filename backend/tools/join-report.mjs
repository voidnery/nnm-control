#!/usr/bin/env node
//
// Why a tab's live columns are empty — asked from the panel, on purpose.
//
// This is the investigation that used to be shipped inside the live-objects
// response and rendered into the page. It does not belong there: it costs
// bytes on a request polled every ten seconds, and it puts server internals on
// a screen for a question that is asked twice a year. So it lives here, run
// deliberately, and the panel keeps only the sentence an operator acts on.
//
// Run inside the API container, where the database and the WMSPanel
// credentials already are:
//
//   docker compose exec api node tools/join-report.mjs <serverId> [kind]
//
// kind: incoming (SRT In) | udp (SRT Out) | outgoing | republish
//
// Addresses are reduced to their first three octets. Ids and ports are kept —
// they are the point.
import mongoose from 'mongoose';
import { config } from '../src/config.js';
import { Settings } from '../src/models/Settings.js';
import { NimbleServer } from '../src/models/NimbleServer.js';
import { nimble } from '../src/services/nimbleClient.js';
import { wmspanel } from '../src/services/wmspanelClient.js';
import { joinLive, localPort, entryIdentity, entryList } from '../src/services/streamJoin.js';

const [serverId, kind = 'incoming'] = process.argv.slice(2);
if (!serverId) {
  console.error('usage: node tools/join-report.mjs <serverId> [incoming|udp|outgoing|republish]');
  process.exit(2);
}

const SOURCES = {
  incoming: { native: ['srtReceiverStats', 'srtSenderStats'], wms: 'incomingList', pick: (d) => d.streams || d.settings || [] },
  outgoing: { native: ['srtSenderStats', 'srtReceiverStats'], wms: 'outgoingList', pick: (d) => d.streams || d.settings || [] },
  udp: { native: ['srtSenderStats', 'srtReceiverStats'], wms: 'udpList', pick: (d) => d.settings || [] },
  republish: { native: ['republishStats'], wms: 'republishList', pick: (d) => d.rules || d.republish_rules || [] },
};
const src = SOURCES[kind];
if (!src) { console.error(`unknown kind "${kind}"`); process.exit(2); }

const maskIp = (v) => String(v ?? '').replace(/(\d+\.\d+\.\d+)\.\d+/g, '$1.x');

await mongoose.connect(config.mongoUrl);
const server = await NimbleServer.findById(serverId);
if (!server) { console.error('server not found'); process.exit(1); }
const settings = await Settings.load();

const [wmsRes, statusRes, ...nativeRes] = await Promise.allSettled([
  wmspanel[src.wms](settings.wmspanel, server.wmspanelServerId),
  nimble.serverStatus(server),
  ...src.native.map(fn => nimble[fn](server)),
]);

const entries = [];
nativeRes.forEach((r, i) => {
  if (r.status !== 'fulfilled') return;
  for (const e of entryList(r.value)) entries.push({ ...e, __from: src.native[i] });
});
const objects = wmsRes.status === 'fulfilled' ? src.pick(wmsRes.value) : [];

const joined = joinLive(entries, objects);

const nIds = new Set(entries.map(e => String(e.setting_id ?? '').toLowerCase()).filter(Boolean));
const wIds = new Set(objects.map(o => String(o.id ?? '').toLowerCase()).filter(Boolean));
const nPorts = new Set(entries.map(e => (localPort(e.id) || '').replace('port:', '')).filter(Boolean));
const wPorts = new Set(objects.map(o => String(o.port || '')).filter(Boolean));

// Which machine answered. Two disjoint socket sets from one endpoint can only
// mean two Nimble instances, and that is the first thing to rule out.
const si = statusRes.status === 'fulfilled' ? statusRes.value?.SysInfo : null;

const report = {
  server: { id: String(server._id), name: server.name, url: maskIp(server.baseUrl || server.host || '') },
  answeredBy: si ? { cores: si.ap ?? null, ramGb: si.tpms ? Math.round(si.tpms / 1e9) : null, gpu: si.nvml?.[0]?.name || null } : null,
  kind,
  nativeEndpoints: src.native.map((fn, i) => ({
    endpoint: fn,
    ok: nativeRes[i].status === 'fulfilled',
    count: nativeRes[i].status === 'fulfilled' ? entryList(nativeRes[i].value).length : 0,
    error: nativeRes[i].status === 'rejected' ? String(nativeRes[i].reason?.message).slice(0, 200) : undefined,
  })),
  wmspanel: {
    ok: wmsRes.status === 'fulfilled',
    count: objects.length,
    error: wmsRes.status === 'rejected' ? String(wmsRes.reason?.message).slice(0, 200) : undefined,
  },
  // Sets, never samples. Two five-entry samples failing to overlap is what
  // sent this investigation down a wrong path for several rounds.
  overlap: {
    settingIds: nIds.size,
    objectIds: wIds.size,
    idOverlap: [...wIds].filter(id => nIds.has(id)).length,
    overlappingIds: [...wIds].filter(id => nIds.has(id)).slice(0, 10),
    nimblePorts: nPorts.size,
    wmspanelPorts: wPorts.size,
    portOverlap: [...wPorts].filter(p => nPorts.has(p)).length,
    overlappingPorts: [...wPorts].filter(p => nPorts.has(p)).slice(0, 10),
  },
  join: {
    strategy: joined.strategy || null,
    matched: joined.matched,
    unmatchedObjects: joined.unmatchedObjects.length,
    candidates: joined.candidates.filter(c => c.matched),
  },
  sampleEntries: entries.slice(0, 5).map(e => ({
    from: e.__from,
    setting_id: e.setting_id ?? null,
    id: maskIp(e.id),
    identity: entryIdentity(e),
    state: e.state ?? null,
    hasStats: Boolean(e.stats),
  })),
  sampleObjects: objects.slice(0, 5).map(o => ({ id: String(o.id), name: o.name, port: o.port ?? null })),
};

process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
await mongoose.disconnect();
