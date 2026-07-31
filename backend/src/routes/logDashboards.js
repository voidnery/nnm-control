import { Router } from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { LogDashboard, hashShareToken, newShareToken } from '../models/LogDashboard.js';
import { searchLogs, groupLogs, maskSecrets } from '../services/logQuery.js';
import { logEvent } from '../services/audit.js';
import { publicUrl } from '../services/publicUrl.js';

// iter10 m5 — dashboards, and links to them.
//
// The security property that shapes this file: a share token answers ONLY for
// the windows stored on its dashboard. The public route reads every filter
// from the database and ignores the query string, so the link cannot be edited
// into a query for something else. Without that, one shared link to a
// transcoder view would be read access to the whole warehouse.
export const logDashboardRouter = Router();

const clampWindow = (w = {}, i = 0) => ({
  id: String(w.id || `w${i}-${Date.now().toString(36)}`).slice(0, 40),
  title: String(w.title || '').slice(0, 80),
  category: String(w.category || 'all').slice(0, 40),
  serverId: String(w.serverId || '').slice(0, 40),
  levels: Array.isArray(w.levels) ? w.levels.filter(x => /^[A-Z]$/.test(x)).slice(0, 6) : [],
  subs: Array.isArray(w.subs) ? w.subs.map(String).slice(0, 30) : [],
  range: ['15m', '1h', '6h', '24h', 'all'].includes(w.range) ? w.range : '1h',
  query: String(w.query || '').slice(0, 200),
  mode: w.mode === 'raw' ? 'raw' : 'grouped',
  height: Math.min(900, Math.max(120, Number(w.height) || 240)),
  span: Math.min(3, Math.max(1, Number(w.span) || 1)),
});

const publicView = (d) => ({
  id: String(d._id),
  name: d.name,
  description: d.description,
  columns: d.columns,
  refreshSec: d.refreshSec,
  windows: d.windows,
});

// ---------------------------------------------------------------- public ---
//
// No session. Declared before the authenticated half so the token path is
// never shadowed by it.

async function loadShared(req, res, next) {
  const token = String(req.params.token || '');
  if (token.length < 20) return res.status(404).json({ error: 'not found' });
  const d = await LogDashboard.findOne({ shareTokenHash: hashShareToken(token), shareEnabled: true });
  if (!d) return res.status(404).json({ error: 'this link is unknown, revoked or disabled' });
  if (d.shareExpiresAt && d.shareExpiresAt.getTime() < Date.now()) {
    return res.status(410).json({ error: 'this link has expired' });
  }
  req.dash = d;
  next();
}

logDashboardRouter.get('/shared/:token', loadShared, async (req, res) => {
  req.dash.shareHits += 1;
  req.dash.shareLastAt = new Date();
  await req.dash.save();
  res.json(publicView(req.dash));
});

// The data for one window. Everything that decides WHAT is returned comes from
// the stored window; the request supplies only which window it wants.
logDashboardRouter.get('/shared/:token/window/:windowId', loadShared, async (req, res) => {
  const w = req.dash.windows.find(x => x.id === req.params.windowId);
  if (!w) return res.status(404).json({ error: 'no such window' });

  const mins = { '15m': 15, '1h': 60, '6h': 360, '24h': 1440, all: 0 }[w.range] || 0;
  const opts = {
    category: w.category, serverId: w.serverId || undefined,
    levels: w.levels.length ? w.levels : undefined,
    subs: w.subs.length ? w.subs : undefined,
    q: w.query || undefined,
    from: mins ? new Date(Date.now() - mins * 60_000).toISOString() : undefined,
    limit: w.mode === 'grouped' ? 40 : 120,
  };
  try {
    if (w.mode === 'grouped') return res.json(await groupLogs(opts));
    const r = await searchLogs(opts);
    // Grouped output is masked already. Raw rows are not, because an operator
    // inside the panel needs the exact line — but a shared link is a screen
    // someone else can be standing in front of, and Nimble writes publish URLs
    // with the stream key in them.
    res.json({ ...r, rows: r.rows.map(x => ({ ...x, msg: maskSecrets(x.msg), cont: maskSecrets(x.cont) })) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ----------------------------------------------------------- authenticated ---

logDashboardRouter.use(requireAuth);

logDashboardRouter.get('/', requirePerm('streams.view'), async (req, res) => {
  const rows = await LogDashboard.find().sort({ name: 1 }).lean();
  res.json(rows.map(d => ({
    id: String(d._id), name: d.name, description: d.description,
    windows: d.windows.length, columns: d.columns, refreshSec: d.refreshSec,
    shareEnabled: d.shareEnabled, shareExpiresAt: d.shareExpiresAt,
    shareHits: d.shareHits, shareLastAt: d.shareLastAt,
    createdBy: d.createdBy, updatedAt: d.updatedAt,
  })));
});

logDashboardRouter.get('/:id', requirePerm('streams.view'), async (req, res) => {
  const d = await LogDashboard.findById(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json({
    ...publicView(d),
    shareEnabled: d.shareEnabled, shareExpiresAt: d.shareExpiresAt,
    shareHits: d.shareHits, shareLastAt: d.shareLastAt, shareCreatedBy: d.shareCreatedBy,
  });
});

logDashboardRouter.post('/', requirePerm('logs.manage'), async (req, res) => {
  const b = req.body || {};
  if (!String(b.name || '').trim()) return res.status(400).json({ error: 'name is required' });
  const d = await LogDashboard.create({
    name: String(b.name).trim().slice(0, 120),
    description: String(b.description || '').slice(0, 400),
    windows: (Array.isArray(b.windows) ? b.windows : []).slice(0, 24).map(clampWindow),
    columns: Math.min(4, Math.max(1, Number(b.columns) || 2)),
    refreshSec: Math.min(3600, Math.max(0, Number(b.refreshSec) || 0)),
    createdBy: req.user?.username || '',
  });
  logEvent({ req, action: 'logs:dashboard-create', target: d.name, outcome: 'ok', status: 200 });
  res.json({ id: String(d._id) });
});

logDashboardRouter.put('/:id', requirePerm('logs.manage'), async (req, res) => {
  const d = await LogDashboard.findById(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (b.name !== undefined) d.name = String(b.name).trim().slice(0, 120) || d.name;
  if (b.description !== undefined) d.description = String(b.description).slice(0, 400);
  if (Array.isArray(b.windows)) d.windows = b.windows.slice(0, 24).map(clampWindow);
  if (b.columns !== undefined) d.columns = Math.min(4, Math.max(1, Number(b.columns) || 2));
  if (b.refreshSec !== undefined) d.refreshSec = Math.min(3600, Math.max(0, Number(b.refreshSec) || 0));
  await d.save();
  logEvent({ req, action: 'logs:dashboard-update', target: d.name, outcome: 'ok', status: 200 });
  res.json({ ok: true });
});

logDashboardRouter.delete('/:id', requirePerm('logs.manage'), async (req, res) => {
  const d = await LogDashboard.findByIdAndDelete(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  logEvent({ req, action: 'logs:dashboard-delete', target: d.name, outcome: 'ok', status: 200 });
  res.json({ ok: true });
});

// Issuing a link is a separate, audited act from editing a dashboard — it is
// the moment production logs become readable without a password, and it should
// not be something that happens as a side effect of saving a layout.
logDashboardRouter.post('/:id/share', requirePerm('logs.manage'), async (req, res) => {
  const d = await LogDashboard.findById(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const raw = newShareToken();
  const days = Number(req.body?.expiresDays);
  d.shareEnabled = true;
  d.shareTokenHash = hashShareToken(raw);
  d.shareCreatedAt = new Date();
  d.shareCreatedBy = req.user?.username || '';
  d.shareExpiresAt = days > 0 ? new Date(Date.now() + days * 86400_000) : null;
  d.shareHits = 0;
  await d.save();
  logEvent({
    req, action: 'logs:dashboard-share', target: d.name,
    detail: { expiresAt: d.shareExpiresAt }, outcome: 'ok', status: 200,
  });
  // Shown once. Only the hash is stored, so a database dump yields no live
  // link — and a lost link is reissued rather than recovered.
  // Built from the panel's public address, not from this request: a reverse
  // proxy that rewrites Host drops the port, and the resulting link then
  // reaches whatever else answers on 443.
  const { url: base, source } = await publicUrl(req);
  res.json({
    token: raw,
    url: `${base}/shared/logs/${raw}`,
    expiresAt: d.shareExpiresAt,
    urlSource: source,
  });
});

logDashboardRouter.delete('/:id/share', requirePerm('logs.manage'), async (req, res) => {
  const d = await LogDashboard.findById(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  d.shareEnabled = false;
  d.shareTokenHash = '';
  d.shareExpiresAt = null;
  await d.save();
  logEvent({ req, action: 'logs:dashboard-unshare', target: d.name, outcome: 'ok', status: 200 });
  res.json({ ok: true });
});
