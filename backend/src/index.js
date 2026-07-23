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
import { agentRouter } from './routes/agentProxy.js';
import { startStatsCollector } from './services/statsCollector.js';
import { wmspanelRouter } from './routes/wmspanelProxy.js';
import { functionsRouter } from './routes/functions.js';
import { auditRouter } from './routes/audit.js';
import { auditMutations } from './services/audit.js';
import { startPeriodicSync } from './services/wmspanelSync.js';

const app = express();
app.disable('x-powered-by');
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
app.use('/api/servers', agentRouter);
app.use('/api/audit', auditRouter);

app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

const start = async () => {
  await connectDb();
  startPeriodicSync();
  await startStatsCollector();
  if (!config.setupToken) {
    console.warn('[setup] SETUP_TOKEN is empty — first-run setup via web UI is disabled until it is set.');
  }
  app.listen(config.port, () => console.log(`[api] listening on :${config.port}`));
};
start().catch(e => { console.error('[fatal]', e); process.exit(1); });
