// Must be first: it patches Express's router prototype so an async handler
// that throws returns 500 instead of terminating the process, and ES modules
// evaluate imports before the importing module's body.
import './asyncGuard.js';
import express from 'express';
import { config } from './config.js';
import { connectDb } from './db.js';
import { setupRouter } from './routes/setup.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { rolesRouter } from './routes/roles.js';
import { serversRouter } from './routes/servers.js';
import { nimbleRouter } from './routes/nimbleProxy.js';
import { zabbixRouter } from './routes/zabbix.js';
import { settingsRouter } from './routes/settings.js';
import { playlistsRouter } from './routes/playlists.js';
import { streamTagsRouter } from './routes/streamTags.js';
import { copyStreamsRouter } from './routes/copyStreams.js';
import { categoriesRouter } from './routes/categories.js';
import { statsRouter } from './routes/stats.js';
import { logsRouter } from './routes/logs.js';
import { logDashboardRouter } from './routes/logDashboards.js';
import { agentEnrollRouter } from './routes/agentEnroll.js';
import { agentGatewayRouter } from './routes/agentGateway.js';
import { agentFleetRouter } from './routes/agentFleet.js';
import { agentRouter } from './routes/agentProxy.js';
import { transcoderGraphRouter } from './routes/transcoderGraph.js';
import { transcoderTemplateRouter } from './routes/transcoderTemplate.js';
import { transcoderFleetRouter } from './routes/transcoderFleet.js';
import { transcoderEditRouter } from './routes/transcoderEdit.js';
import { startStatsCollector } from './services/statsCollector.js';
import { startSpoolSweeper } from './services/mediaSpool.js';
import { startTaskReaper } from './services/agentBus.js';
import { startAgentWatchdog } from './services/agentWatchdog.js';
import { wmspanelRouter } from './routes/wmspanelProxy.js';
import { functionsRouter } from './routes/functions.js';
import { geoipRouter } from './routes/geoip.js';
import { cdnNetworkRouter } from './routes/cdnNetworks.js';
import { auditRouter } from './routes/audit.js';
import { auditMutations } from './services/audit.js';
import { startPeriodicSync } from './services/wmspanelSync.js';

const app = express();
app.disable('x-powered-by');
// The panel always runs behind nginx (see docker-compose.yml), which terminates
// TLS. Without this, req.protocol is 'http' no matter how the browser reached
// us — which is how the agent installer came to hand out an http:// URL for a
// panel that is served over https, and why the "this panel is on plain HTTP"
// warning fired on a panel that was not. TRUST_PROXY counts hops; set it to 2
// if there is a CDN in front of nginx as well, or 0 to disable when the panel
// is exposed directly.
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
// Media uploads are streamed straight through to the server agent, so the JSON
// parser must not consume (or reject) their binary body.
const isMediaUpload = (req) => req.method === 'PUT' && /^\/api\/servers\/[^/]+\/agent\/media$/.test(req.path);
app.use((req, res, next) => (isMediaUpload(req) ? next() : express.json({ limit: '1mb' })(req, res, next)));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/setup', setupRouter);
app.use('/api', auditMutations);
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/roles', rolesRouter);
app.use('/api/servers', serversRouter);
app.use('/api/nimble', nimbleRouter);
app.use('/api/zabbix', zabbixRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/wmspanel', wmspanelRouter);
app.use('/api/functions', functionsRouter);
app.use('/api/playlists', playlistsRouter);
app.use('/api/stream-tags', streamTagsRouter);
app.use('/api/wmspanel', copyStreamsRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/stats', statsRouter);
// Declared first: its public share routes must not be shadowed by the
// authenticated log router mounted on the same prefix.
app.use('/api/log-dashboards', logDashboardRouter);
app.use('/api/logs', logsRouter);
// iter12 m1 — the agent's own entry point. Authenticated by the agent token,
// never by an operator session.
app.use('/api/agent-gw', agentGatewayRouter);
app.use('/api/agent-fleet', agentFleetRouter);
app.use('/api', agentEnrollRouter);
app.use('/api/servers', agentRouter);
app.use('/api/wmspanel', transcoderGraphRouter);
app.use('/api/wmspanel', transcoderTemplateRouter);
app.use('/api/wmspanel', transcoderFleetRouter);
app.use('/api/wmspanel', transcoderEditRouter);
app.use('/api', geoipRouter);
app.use('/api/cdn', cdnNetworkRouter);
app.use('/api/audit', auditRouter);

app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

const start = async () => {
  await connectDb();
  startPeriodicSync();
  await startStatsCollector();
  startSpoolSweeper();
  startTaskReaper();
  startAgentWatchdog();
  if (!config.setupToken) {
    console.warn('[setup] SETUP_TOKEN is empty — first-run setup via web UI is disabled until it is set.');
  }
  app.listen(config.port, () => console.log(`[api] listening on :${config.port}`));
};
start().catch(e => { console.error('[fatal]', e); process.exit(1); });
