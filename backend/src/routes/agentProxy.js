import { Router } from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { Playlist } from '../models/Playlist.js';
import { parsePlaylistFile, comparePlaylists } from '../services/playlistFile.js';
import { PlaylistDeploy } from '../models/PlaylistDeploy.js';
import { captureCurrent, inspect, history, sha256, withoutTask, withTask, findTaskInVersions } from '../services/playlistDeploy.js';
import { resumeTask } from '../services/playlistResume.js';
import { detectDrift, checkJoins, timings, endingSoon } from '../services/playlistAdvice.js';

// Measure the media a playlist names. Failures are absences rather than
// errors: a duration that could not be read disables a resume and hides a
// timing, and neither is a reason to fail the whole request.
async function mediaProbes(server, paths, by) {
  const out = new Map();
  if (!paths?.length) return out;
  try {
    const r = await runTask(server, 'POST /media/probe', { body: { paths }, createdBy: by });
    for (const x of r?.results || []) if (x.ok) out.set(x.path, x);
  } catch { /* nothing measured; the callers all handle an empty map */ }
  return out;
}

async function mediaDurations(server, task, by) {
  const paths = (task?.Blocks || []).flatMap(b => (b.Streams || []).map(s => s.Source)).filter(Boolean);
  const probes = await mediaProbes(server, [...new Set(paths)], by);
  return new Map([...probes].map(([k, v]) => [k, v.durationMs]));
}
import { runTask, enqueueTask, reapExpiredTasks } from '../services/agentBus.js';
import { AgentTask } from '../models/AgentTask.js';
import { diagnose, HINTS } from '../services/agentDiagnosis.js';
import { MediaTransfer } from '../models/MediaTransfer.js';
import { canAccept, spoolUpload, spoolUsage } from '../services/mediaSpool.js';
import { logEvent } from '../services/audit.js';

export const agentRouter = Router();
agentRouter.use(requireAuth);

async function loadServer(req, res, next) {
  const s = await NimbleServer.findById(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  req.srv = s;
  next();
}

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
};

// --- connection management ---
agentRouter.get('/:id/agent', requirePerm('servers.view'), loadServer, (req, res) => {
  const a = req.srv.agent || {};
  res.json({
    enabled: Boolean(a.enabled), hasToken: Boolean(a.token),
    lastContactAt: a.lastContactAt || null, version: a.version || 0,
    interfaces: a.interfaces || [],
    // What the agent last reported it has, so the operator picks from a real
    // list rather than typing a name that may not exist on that box.
    availableInterfaces: a.lastHealth?.interfaces || [],
  });
});

agentRouter.put('/:id/agent', requirePerm('servers.manage'), loadServer, wrap(async (req) => {
  const { enabled, token, interfaces } = req.body || {};
  if (Array.isArray(interfaces)) {
    req.srv.agent.interfaces = interfaces
      .map(x => String(x).trim())
      .filter(x => /^[A-Za-z0-9_.@:-]{1,32}$/.test(x))
      .slice(0, 12);
  }
  req.srv.agent = req.srv.agent || {};
  if (enabled !== undefined) req.srv.agent.enabled = Boolean(enabled);
  if (token) req.srv.agent.token = String(token);   // empty means "keep current"
  await req.srv.save();
  logEvent({ req, action: 'agent:configure', target: req.srv.name, outcome: 'ok', status: 200 });
  return { ok: true };
}));

// iter12 m1 — health and config now travel over the task bus instead of a
// connection to the agent. The browser still gets its answer in this response;
// what changed is that the panel asks by queueing and waiting, so the server
// no longer has to be reachable from here.
agentRouter.get('/:id/agent/health', requirePerm('servers.view'), loadServer,
  wrap(req => runTask(req.srv, 'GET /health', { createdBy: req.user?.username })));

// iter12 m4 — why is this agent not doing what was asked?
//
// The states are read fresh, and expired tasks are reaped first: a task
// sitting past its deadline still marked `queued` would be read as a
// panel-side claim failure, which is a confident wrong answer.
agentRouter.get('/:id/agent/diagnosis', requirePerm('servers.view'), loadServer, wrap(async (req) => {
  await reapExpiredTasks();
  const a = req.srv.agent || {};
  const tasks = await AgentTask.find({ serverId: req.srv._id })
    .sort({ createdAt: -1 }).limit(25).lean();
  const d = diagnose({
    now: new Date(),
    agent: {
      enabled: Boolean(a.enabled),
      hasToken: Boolean(a.token),
      lastContactAt: a.lastContactAt,
      instanceId: a.instanceId,
      version: a.version,
      restarts: a.restarts,
      restartWindowStart: a.restartWindowStart,
    },
    tasks: tasks.map(t => ({
      id: String(t._id), route: t.route, status: t.status,
      createdAt: t.createdAt, claimedAt: t.claimedAt, deadlineAt: t.deadlineAt,
    })),
  });
  return {
    ...d,
    hint: HINTS[d.code] || '',
    agentVersion: a.version || 0,
    instanceId: a.instanceId || '',
    recent: tasks.slice(0, 8).map(t => ({
      route: t.route, status: t.status, createdAt: t.createdAt,
      claimedAt: t.claimedAt, finishedAt: t.finishedAt, error: t.error,
    })),
  };
}));

// --- config files ---
agentRouter.get('/:id/agent/config', requirePerm('playlist.view'), loadServer,
  wrap(req => runTask(req.srv, 'GET /config', {
    query: { name: String(req.query.name || '') }, createdBy: req.user?.username,
  })));

agentRouter.put('/:id/agent/config', requirePerm('playlist.manage'), loadServer, wrap(async (req) => {
  const name = String(req.query.name || req.body?.name || '');
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  const r = await runTask(req.srv, 'PUT /config', {
    query: { name }, body: { content }, createdBy: req.user?.username,
  });
  logEvent({ req, action: 'agent:config_write', target: `${req.srv.name}:${name} (${r.size} B)`, outcome: 'ok', status: 200 });
  return r;
}));

// iter19 m1 — what is on the server right now.
//
// Read-only, and deliberately so: an operator about to change a live playlist
// should be able to see the current state without the act of looking being
// able to alter it.
// What configuration files this server has. The panel offers these rather
// than assuming a name.
agentRouter.get('/:id/agent/config-list', requirePerm('playlist.view'), loadServer,
  wrap(req => runTask(req.srv, 'GET /config/list', { createdBy: req.user?.username })));

agentRouter.get('/:id/agent/playlist-state', requirePerm('playlist.view'), loadServer, wrap(async (req) => {
  const name = String(req.query.name || 'server-playlist.json');

  let file = null;
  let readError = null;
  try {
    file = await runTask(req.srv, 'GET /config', { query: { name }, createdBy: req.user?.username });
  } catch (e) {
    // A missing file is a state, not a failure: a server with no playlist yet
    // is the normal starting point and must not read as broken.
    readError = String(e.message || e).slice(0, 200);
  }

  if (readError && /not found|ENOENT|missing/i.test(readError)) {
    return { name, exists: false, parsed: null, media: null, compare: null };
  }
  if (readError) return { name, exists: null, error: readError, confDir: null };

  // The agent answers a missing file politely rather than by throwing, and
  // that answer was being ignored: `content: null` fell through to the parser,
  // which reported "empty" — so a server that could not be reached, a server
  // with no playlist, and a server with an unreadable one all arrived at the
  // page looking alike. They need different things done about them.
  if (file && file.exists === false) {
    // What IS there, since what was asked for is not. A default filename one
    // character away from the real one — `server-playlist.json` against
    // `server_playlist.json` — reported "no playlist" about a server that had
    // one, and nothing on the page could have told the operator otherwise.
    let alternatives = [];
    try {
      const listing = await runTask(req.srv, 'GET /config/list', { createdBy: req.user?.username });
      alternatives = (listing?.files || []).map(f => f.name);
    } catch { /* an agent too old to list is still an agent that answered */ }
    return {
      name, exists: false, parsed: null, media: null, compare: null,
      confDir: file.dir || null, alternatives,
    };
  }
  if (typeof file?.content !== 'string') {
    return {
      name, exists: null,
      error: 'the agent returned no content for this file and did not say it was missing',
      raw: file ? Object.keys(file) : null,
    };
  }

  const parsed = parsePlaylistFile(file.content);

  // Does every file it names actually exist? A playlist entry pointing at a
  // missing file plays silence, and today the only way to find that out is to
  // watch the stream.
  let media = null;
  if (parsed.ok && parsed.sources.length) {
    try {
      const stat = await runTask(req.srv, 'POST /media/stat', {
        body: { paths: parsed.sources }, createdBy: req.user?.username,
      });
      // "Missing" and "could not look" are different facts, and this reported
      // both as missing. A playlist pointing at /srv/nimble/video — outside
      // the media root the agent will read — showed as two broken entries on a
      // server where both files exist. An alarm that is wrong is an alarm that
      // gets ignored.
      const failed = (stat.results || []).filter(r => !r.ok);
      const missing = failed.filter(r => r.reason === 'missing');
      const unverifiable = failed.filter(r => r.reason !== 'missing');
      media = {
        root: stat.root,
        checked: parsed.sources.length,
        missing: missing.map(r => ({ path: r.path, reason: r.reason })),
        unverifiable: unverifiable.map(r => ({ path: r.path, reason: r.reason })),
        bytes: (stat.results || []).reduce((a, r) => a + (r.size || 0), 0),
      };
    } catch (e) {
      // Worth saying which half failed rather than reporting the playlist as
      // unreadable when it read perfectly well.
      media = { error: String(e.message || e).slice(0, 200) };
    }
  }

  const stored = req.query.playlistId ? await Playlist.findById(req.query.playlistId) : null;
  return {
    name,
    exists: true,
    updatedAt: file?.mtime ?? null,
    parsed,
    media,
    compare: stored ? { playlist: stored.name, ...comparePlaylists(file?.content, stored.model) } : null,
  };
}));

// iter19 m4 — put a playlist on a server, and be able to take it back.
//
// The file is a live broadcast config and takes effect the moment it lands:
// Nimble watches the directory, there is no staging step, and nothing reports
// back that what it read was what was meant. So everything checkable is
// checked before the write, and the version being replaced is kept.
// The body of a deploy, named so that rolling back can call it rather than
// reimplement it. A second implementation would be one that drifts from the
// first, and the drift would show up as a rollback that skipped a check.
async function deployHandler(req) {
  const filename = String(req.body?.filename || 'server-playlist.json');
  const force = req.body?.force === true;

  let content = typeof req.body?.content === 'string' ? req.body.content : null;
  let playlist = null;
  if (req.body?.playlistId) {
    playlist = await Playlist.findById(req.body.playlistId);
    if (!playlist) throw Object.assign(new Error('Playlist not found'), { status: 404 });
    if (content == null) content = JSON.stringify(playlist.model, null, 2);
  }
  if (content == null) throw Object.assign(new Error('nothing to deploy'), { status: 400 });

  // What the server holds, so a path that is not there can be named before it
  // becomes silence rather than after.
  let present = null;
  try {
    const listing = await runTask(req.srv, 'GET /media', { createdBy: req.user?.username });
    const dir = String(listing?.dir || '').replace(/\/+$/, '');
    present = new Set((listing?.files || []).map(f => `${dir}/${f.name}`));
  } catch { /* checked below: an unknown media list is not a licence to skip */ }

  const check = inspect(content, present);
  if (check.fatal) throw Object.assign(new Error(check.fatal), { status: 400 });

  // A malformed file is always refused. A missing media file is refused unless
  // someone says otherwise in as many words — it is recoverable, and an
  // operator may know the file is arriving in a minute.
  if (!force) {
    if (check.missing.length) {
      throw Object.assign(new Error(
        `${check.missing.length} of ${check.parsed.sources.length} sources are not on this server; `
        + `those entries would play silence. First: ${check.missing.slice(0, 3).join(', ')}. `
        + 'Upload them, or repeat with force.'), { status: 409, missing: check.missing });
    }
    if (present === null) {
      throw Object.assign(new Error(
        'the media list could not be read from this server, so the sources could not be checked. '
        + 'Repeat with force to deploy without checking.'), { status: 409 });
    }
    if (check.empty) {
      // Legal JSON that stops every stream on the server, and a plausible
      // accident: deleting the last task.
      throw Object.assign(new Error(
        'this playlist has no entries — deploying it would stop every stream on this server. '
        + 'Repeat with force if that is intended.'), { status: 409 });
    }
  }

  // Record what is being replaced, before replacing it.
  try {
    const before = await runTask(req.srv, 'GET /config', { query: { name: filename }, createdBy: req.user?.username });
    await captureCurrent({ serverId: req.srv._id, filename, content: before?.content || '' });
  } catch { /* no previous file is the normal first case */ }

  const r = await runTask(req.srv, 'PUT /config', {
    query: { name: filename }, body: { content }, createdBy: req.user?.username,
  });

  await PlaylistDeploy.create({
    serverId: req.srv._id, filename, content, sha256: sha256(content), bytes: content.length,
    origin: 'panel', by: req.user?.username || '', playlistId: playlist?._id || null,
    // Kept because it explains an outage nobody could otherwise account for.
    missingAtDeploy: check.missing, forced: force,
    note: String(req.body?.note || '').slice(0, 200),
  });

  logEvent({
    req, action: 'playlist:deploy',
    target: `${playlist?.name || filename} → ${req.srv.name}${force ? ' (forced)' : ''}`,
    outcome: 'ok', status: 200,
  });
  return { ...r, entries: check.entries, missing: check.missing, forced: force };
}

agentRouter.post('/:id/agent/deploy-playlist', requirePerm('playlist.manage'), loadServer,
  wrap(req => deployHandler(req)));

// iter19 m5 — stop and start one output stream.
//
// Both are deploys. A second way to change a live config would be a second way
// that skips the checks, and this is the path most likely to be taken in a
// hurry.
agentRouter.post('/:id/agent/playlist-stop', requirePerm('playlist.manage'), loadServer, wrap(async (req) => {
  const filename = String(req.body?.filename || 'server-playlist.json');
  const stream = String(req.body?.stream || '');
  if (!stream) throw Object.assign(new Error('which stream to stop?'), { status: 400 });

  const cur = await runTask(req.srv, 'GET /config', { query: { name: filename }, createdBy: req.user?.username });
  const next = withoutTask(cur?.content || '', stream);
  if (next === null) {
    throw Object.assign(new Error(`"${stream}" is not in the playlist on this server`), { status: 409 });
  }

  // Forced past the empty-playlist refusal only when stopping the last task is
  // what was actually asked for — the operator named a stream, so the
  // consequence is not a surprise.
  req.body = { content: next, filename, force: true, note: `stopped ${stream}` };
  const r = await deployHandler(req);
  logEvent({ req, action: 'playlist:stop', target: `${stream} on ${req.srv.name}`, outcome: 'ok', status: 200 });
  return { ...r, stopped: stream };
}));

agentRouter.post('/:id/agent/playlist-start', requirePerm('playlist.manage'), loadServer, wrap(async (req) => {
  const filename = String(req.body?.filename || 'server-playlist.json');
  const stream = String(req.body?.stream || '');
  if (!stream) throw Object.assign(new Error('which stream to start?'), { status: 400 });

  // Recovered from the version history rather than from a copy kept for the
  // purpose: there is nothing extra to store and no chance of a stored copy
  // drifting from what was really running.
  const versions = await PlaylistDeploy.find({ serverId: req.srv._id, filename })
    .sort({ createdAt: -1 }).limit(50).lean();
  const found = findTaskInVersions(versions, stream);
  if (!found) {
    // Say where it WAS seen. The stopped-streams list is built from history,
    // so a stream offered here and not found came from a different file — and
    // "there is nothing to restore" sends the operator to rebuild something
    // that already exists a few lines away.
    const elsewhere = await PlaylistDeploy.find({ serverId: req.srv._id, filename: { $ne: filename } })
      .sort({ createdAt: -1 }).limit(50).lean();
    const other = findTaskInVersions(elsewhere, stream);
    throw Object.assign(new Error(other
      ? `"${stream}" is not in any version of ${filename}, but it is in ${other.from.filename}. `
        + 'Switch to that file to start it.'
      : `no version this panel holds contains "${stream}", so there is nothing to restore. `
        + 'Add the task in the editor and deploy it.'), { status: 404 });
  }

  const cur = await runTask(req.srv, 'GET /config', { query: { name: filename }, createdBy: req.user?.username });

  // iter19 m6 — resume rather than restart, when asked and when possible.
  //
  // Opt-in: a Play button that silently jumps an hour forward is as wrong as
  // one that silently rewinds. The operator says which they meant.
  let task = found.task;
  let resume = null;
  if (req.body?.resume === true) {
    const stoppedAt = new Date(found.from.createdAt).getTime();
    // How long it had been playing when it was stopped: from the deploy that
    // started it to the deploy that removed it.
    const startedDoc = await PlaylistDeploy
      .find({ serverId: req.srv._id, filename, createdAt: { $lt: found.from.createdAt } })
      .sort({ createdAt: -1 }).limit(50).lean();
    const startedFrom = findTaskInVersions(startedDoc, stream);
    // The run began at the FIRST version that had it, not the most recent one
    // — a later version might be an edit made while it kept playing.
    const runStart = startedFrom ? new Date(startedFrom.from.createdAt).getTime() : stoppedAt;

    const durations = await mediaDurations(req.srv, found.task, req.user?.username);
    const r = resumeTask(found.task, durations, stoppedAt - runStart);
    if (r.ok) { task = r.task; resume = { ...r.at, estimated: true, rewoundMs: r.rewoundMs }; }
    else resume = { failed: r.reason };
  }

  const next = withTask(cur?.content || '', task, found.index);
  if (next === null) {
    throw Object.assign(new Error(`"${stream}" is already in the playlist on this server`), { status: 409 });
  }

  req.body = { content: next, filename, force: req.body?.force === true, note: `started ${stream}` };
  const r = await deployHandler(req);
  logEvent({ req, action: 'playlist:start', target: `${stream} on ${req.srv.name}`, outcome: 'ok', status: 200 });
  // Said in the response, not only in the UI: a restored task begins at the
  // top of its block. The format carries no playback position, so there is
  // nothing to resume from.
  return {
    ...r, started: stream, restoredFrom: found.from.createdAt,
    // Only true when nothing was resumed: saying it unconditionally was fine
    // when resuming did not exist and would be a lie now.
    resumesFromStart: !resume || Boolean(resume.failed),
    resume,
  };
}));

// iter19 m7 — everything the panel can say about a playlist without watching
// the stream. Read-only, and one request, because these questions are asked
// together and each one alone costs an agent round trip.
agentRouter.get('/:id/agent/playlist-advice', requirePerm('playlist.view'), loadServer, wrap(async (req) => {
  const filename = String(req.query.filename || 'server-playlist.json');

  let content = '';
  try {
    const f = await runTask(req.srv, 'GET /config', { query: { name: filename }, createdBy: req.user?.username });
    content = f?.content || '';
  } catch { /* no file is a state the caller renders, not an error */ }

  const parsed = parsePlaylistFile(content);
  const last = await PlaylistDeploy.findOne({ serverId: req.srv._id, filename })
    .sort({ createdAt: -1 }).select('sha256 createdAt by').lean();
  const drift = detectDrift({ serverSha: content ? sha256(content) : null, lastDeploy: last });

  if (!parsed.ok) return { filename, drift, parsed, joins: null, timings: null, endingSoon: [] };

  const probes = await mediaProbes(req.srv, parsed.sources, req.user?.username);
  const durations = new Map([...probes].map(([k, v]) => [k, v.durationMs]));

  // When each task's current run began, so an end time can be a clock time
  // rather than a duration the operator has to add to now.
  const started = await PlaylistDeploy.find({ serverId: req.srv._id, filename })
    .sort({ createdAt: 1 }).limit(50).lean();

  const timed = timings(parsed, durations, {
    startedAt: started.length ? started[started.length - 1].createdAt : null,
  });

  return {
    filename,
    drift,
    parsed,
    probed: probes.size,
    joins: parsed.tasks.map(t => ({
      stream: t.stream,
      ...checkJoins(t.items.map(i => i.source), probes),
    })),
    timings: timed,
    endingSoon: endingSoon(timed),
  };
}));

agentRouter.get('/:id/agent/playlist-history', requirePerm('playlist.view'), loadServer, wrap(async (req) => ({
  versions: await history(req.srv._id, String(req.query.filename || ''), Number(req.query.limit) || 30),
})));

agentRouter.get('/:id/agent/playlist-history/:vid', requirePerm('playlist.view'), loadServer, wrap(async (req) => {
  const v = await PlaylistDeploy.findOne({ _id: req.params.vid, serverId: req.srv._id }).lean();
  if (!v) throw Object.assign(new Error('version not found'), { status: 404 });
  return v;
}));

// Rolling back is deploying an older version, deliberately taking the same
// path: a separate route would be one that skips the checks at the exact
// moment they matter most, which is when something has already gone wrong.
agentRouter.post('/:id/agent/rollback-playlist', requirePerm('playlist.manage'), loadServer, wrap(async (req) => {
  const v = await PlaylistDeploy.findOne({ _id: req.body?.versionId, serverId: req.srv._id }).lean();
  if (!v) throw Object.assign(new Error('version not found'), { status: 404 });
  req.body = {
    content: v.content, filename: v.filename, force: req.body?.force === true,
    note: `rollback to the version of ${new Date(v.createdAt).toISOString()}`,
  };
  return deployHandler(req);
}));


// --- media ---
agentRouter.get('/:id/agent/media', requirePerm('playlist.view'), loadServer,
  wrap(req => runTask(req.srv, 'GET /media', { createdBy: req.user?.username })));

agentRouter.delete('/:id/agent/media', requirePerm('playlist.manage'), loadServer, wrap(async (req) => {
  const name = String(req.query.name || '');

  // Refuse to delete a file the live playlist still names.
  //
  // Tidying up media is a housekeeping action taken between events, and the
  // consequence lands hours later in the middle of one: the entry stays in the
  // playlist and plays silence. Nothing else in the system would report it,
  // which is what makes it worth a hard stop rather than a warning.
  //
  // Overridable with ?force=1, because an operator who knows the file is
  // orphaned should not be stuck — but the default is refusal, and the
  // override is an explicit act.
  if (req.query.force !== '1') {
    try {
      const file = await runTask(req.srv, 'GET /config', {
        query: { name: 'server-playlist.json' }, createdBy: req.user?.username,
      });
      const parsed = parsePlaylistFile(file?.content ?? '');
      if (parsed.ok) {
        // The full path, not the file name.
        //
        // Matching on the tail over-refuses: this fleet's playlist contains
        // two different `match_1.mp4` in different directories, and a name
        // match would block deleting either because of the other. The
        // question is whether THIS file is referenced.
        const listing = await runTask(req.srv, 'GET /media', { createdBy: req.user?.username });
        const full = `${String(listing?.dir || '').replace(/\/+$/, '')}/${name}`;
        const used = parsed.sources.filter(src => src === full);
        if (used.length) {
          throw Object.assign(
            new Error(`"${name}" is used by the playlist on this server (${used.length} entr`
              + `${used.length === 1 ? 'y' : 'ies'}); deleting it would make those entries play silence. `
              + 'Remove them from the playlist first, or repeat with force=1.'),
            { status: 409 },
          );
        }
      }
    } catch (e) {
      // A playlist that cannot be read is not permission to delete: if the
      // check itself failed, say so rather than proceeding as though the file
      // were unused.
      if (e.status === 409) throw e;
      throw Object.assign(
        new Error(`could not check the playlist before deleting: ${String(e.message || e).slice(0, 160)}`),
        { status: 409 },
      );
    }
  }
  const r = await runTask(req.srv, 'DELETE /media', { query: { name }, createdBy: req.user?.username });
  logEvent({ req, action: 'agent:media_delete', target: `${req.srv.name}:${name}`, outcome: 'ok', status: 200 });
  return r;
}));

// iter12 m3 — the operator hands the file to the panel; the agent collects it.
//
// The browser's upload is streamed to the panel's spool and the response comes
// back as soon as it is safely on disk — it deliberately does NOT wait for the
// agent. A 2 GB file over a slow link would otherwise hold an HTTP request
// open for minutes and fail the whole upload if the server happened to be
// offline, which is precisely the case this design exists to handle.
agentRouter.put('/:id/agent/media', requirePerm('playlist.manage'), loadServer, wrap(async (req) => {
  const name = String(req.query.name || '');
  if (!name) throw Object.assign(new Error('name is required'), { status: 400 });

  // Asked before a byte is written. At a hundred gigabytes the answer "no"
  // arriving at the end is the expensive one: the bandwidth is spent, there is
  // a half-file to clean up, and the disk it was going to fill is shared with
  // the database.
  const room = await canAccept(req.headers['content-length']);
  if (!room.ok) throw Object.assign(new Error(`this upload cannot be accepted: ${room.reason}`), { status: room.status });

  const doc = await spoolUpload(req.srv, name, req, { createdBy: req.user?.username });
  await enqueueTask(req.srv, 'POST /media/fetch', {
    body: { transferId: String(doc._id), name: doc.name, sha256: doc.sha256, size: doc.size },
    // The agent has to pull the whole file from the panel before it can
    // report success, and at this size that is hours. A task that expires
    // mid-transfer is a transfer thrown away.
    timeoutMs: 12 * 60 * 60_000,
    createdBy: req.user?.username,
  });
  logEvent({ req, action: 'agent:media_upload', target: `${req.srv.name}:${name} (${doc.size} B)`, outcome: 'ok', status: 200 });
  return { queued: true, transferId: String(doc._id), name: doc.name, size: doc.size, sha256: doc.sha256 };
}));

// What is still in flight, and what the spool is costing in disk.
agentRouter.get('/:id/agent/transfers', requirePerm('playlist.view'), loadServer, wrap(async (req) => {
  const items = await MediaTransfer.find({ serverId: req.srv._id }).sort({ createdAt: -1 }).limit(50).lean();
  return {
    spool: await spoolUsage(),
    transfers: items.map(t => ({
      id: String(t._id), name: t.name, size: t.size, status: t.status, error: t.error,
      attempts: t.attempts, createdAt: t.createdAt, confirmedAt: t.confirmedAt, expiresAt: t.expiresAt,
    })),
  };
}));

// Re-queue a transfer whose file is still on the panel.
agentRouter.post('/:id/agent/transfers/:tid/retry', requirePerm('playlist.manage'), loadServer, wrap(async (req) => {
  const doc = await MediaTransfer.findOne({ _id: req.params.tid, serverId: req.srv._id });
  if (!doc) throw Object.assign(new Error('no such transfer'), { status: 404 });
  if (!doc.spoolPath) throw Object.assign(new Error('the file is no longer held by the panel — upload it again'), { status: 410 });
  doc.status = 'queued';
  doc.error = '';
  await doc.save();
  await enqueueTask(req.srv, 'POST /media/fetch', {
    body: { transferId: String(doc._id), name: doc.name, sha256: doc.sha256, size: doc.size },
    timeoutMs: 30 * 60_000,
    createdBy: req.user?.username,
  });
  return { ok: true, status: doc.status };
}));
