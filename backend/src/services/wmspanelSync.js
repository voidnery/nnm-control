import { Settings } from '../models/Settings.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { wmspanel } from './wmspanelClient.js';

// Fleet auto-sync: in WMSPanel control plane mode the panel pulls the server
// list from WMSPanel and materializes/updates local server entries.
//
// Rules (deliberate, to stay non-destructive):
// - upsert by wmspanelServerId; only kind === 'Nimble' servers are imported
// - name/tags/status are refreshed on every sync
// - host is set ONLY when empty (first custom_ip, else first IPv4) — a host
//   corrected by the operator is never overwritten
// - native management port/token are NOT known to WMSPanel: port defaults to
//   8082, token stays empty until the operator fills it in
// - local servers missing in WMSPanel are NOT deleted (safety); they just
//   keep their last known wmspanelStatus
export async function syncServersFromWmspanel({ force = false } = {}) {
  const settings = await Settings.load();
  if (!force && settings.controlPlane !== 'wmspanel') {
    return { skipped: true, reason: 'control plane is not wmspanel' };
  }
  if (!settings.wmspanel.clientId || !settings.wmspanel.apiKey) {
    return { skipped: true, reason: 'wmspanel credentials not configured' };
  }

  const data = await wmspanel.listServers(settings.wmspanel);
  const remote = (data.servers || []).filter(s => s.kind === 'Nimble');

  let created = 0, updated = 0;
  for (const ws of remote) {
    const pickHost = () => {
      const custom = (ws.custom_ips || []).find(Boolean);
      if (custom) return custom;
      const v4 = (ws.ip || []).find(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
      return v4 || (ws.ip || [])[0] || '';
    };
    const existing = await NimbleServer.findOne({ wmspanelServerId: ws.id });
    if (existing) {
      existing.name = ws.name || existing.name;
      existing.tags = Array.isArray(ws.tags) ? ws.tags : existing.tags;
      existing.wmspanelStatus = ws.status || '';
      existing.syncedFromWmspanel = true;
      existing.lastSyncAt = new Date();
      if (!existing.host) existing.host = pickHost();
      await existing.save();
      updated++;
    } else {
      await NimbleServer.create({
        name: ws.name || ws.id,
        host: pickHost(),
        port: 8082,
        token: '',
        tags: Array.isArray(ws.tags) ? ws.tags : [],
        wmspanelServerId: ws.id,
        syncedFromWmspanel: true,
        wmspanelStatus: ws.status || '',
        lastSyncAt: new Date(),
        notes: 'Auto-imported from WMSPanel. Set the native management token to enable live status.',
      });
      created++;
    }
  }
  return { skipped: false, created, updated, remoteTotal: remote.length };
}

const SYNC_INTERVAL_MS = 10 * 60 * 1000; // 144 calls/day — far below the 15k limit

export function startPeriodicSync() {
  const tick = async () => {
    try {
      const r = await syncServersFromWmspanel();
      if (!r.skipped) console.log(`[wmspanel-sync] created=${r.created} updated=${r.updated} total=${r.remoteTotal}`);
    } catch (e) {
      console.error(`[wmspanel-sync] failed: ${e.message}`);
    }
  };
  setTimeout(tick, 15 * 1000);           // shortly after boot
  setInterval(tick, SYNC_INTERVAL_MS);
}
