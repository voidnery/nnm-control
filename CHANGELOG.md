# Changelog

## iter3 (v0.4.x) — UX & design overhaul
### v0.4.0 (m1) — design foundation
- Theme system: dark / light / system (auto), via `data-theme` and CSS
  variables; light palette added; persisted in a cookie (no localStorage)
- Custom `Modal` component with SAFE close: a drag that starts inside the
  dialog and releases on the backdrop no longer closes it — only a genuine
  press-and-release on the backdrop (or Esc) closes; open animation; width
  variants (narrow/default/wide/xwide) for later per-user preference
- Custom themed `Select` component (button + popover, optional search) — base
  for migrating all dropdowns next
- App version shown above the profile box in the sidebar
- Server tabs renamed to operator-friendly labels: Republish→RTMP Push,
  MPEGTS In→SRT In, UDP/SRT→SRT Out, Outgoing→SRT in Nimble, Live Pull→RTMP
  Pull (Streams unchanged; keys/permissions unchanged)
- Native caret styling unified for remaining native selects across themes

Iteration ↔ version mapping: new iteration = minor bump, fixes inside an
iteration = patch bump.

## iter2 (v0.3.x) — engineering functions & WMSPanel control plane
### v0.3.19 (m11.2) — CRUD parity across all entity tabs
- FIX during release validation: the first cut of this version shipped a
  corrupted WmsObjectsTabs (inverted slice duplicated a file section; the
  build failure was hidden by a truncated log). File rebuilt from the last
  good commit with corrected patch boundaries; build validation now checks
  the full build log and exit code instead of a tail
- UDP/SRT: create output (name/protocol/ip/port/ttl/parameters; source set
  afterwards via Edit source), Settings edit for the same fields, Delete
- Interfaces: full CRUD (create/edit/delete RTMP listeners with disconnect
  warning on delete)
- Republish: full-rule Edit modal (source + destination + description +
  paused) alongside the quick inline Switch source
- Hotswap: prompt-based editing replaced with a full modal (original pair,
  substitute pair, paused/disarmed)
- Transcoders: Edit (name/description/tags) and Delete (with permanent-
  pipelines warning)
- Note: Outgoing already had full CRUD since v0.3.12; live Streams has no
  create by nature (streams appear by publishing)

### v0.3.18 (m11.1) — FIX: UDP/SRT source editing covers both modes
- Live data showed 604 of 755 UDP/SRT outputs set their source via
  `source_id` (a reference to an MPEGTS incoming stream = raw passthrough),
  not `source_streams` — the tab could neither display nor edit those, and
  could not ADD app/stream entries either ("no source_streams entries" dead
  end)
- Edit source now mirrors WMSPanel: mode switch between "MPEGTS incoming
  stream" (dropdown of incoming streams by name) and "application/stream
  entries" (rows with add/remove; existing entries keep their PIDs, new ones
  get PIDs from WMSPanel); the table shows the source for both modes with
  incoming names resolved instead of raw ids

### v0.3.17 (m11) — backups & panel monitoring; ITER2 CLOSED
- MongoDB backups: `nnm-control backup` (mongodump --archive --gzip of the
  panel DB into /var/lib/nnm-control/backups, 0600, retention
  NNM_BACKUP_KEEP, default 14), `nnm-control backups` (list),
  `nnm-control restore <file>` (typed-yes confirmation, --drop, panel
  restart); nightly systemd timer 03:30 (+ up to 15 min jitter), enabled by
  the deb automatically
- Zabbix: new /api/zabbix/panel item — version, control plane, mongo state,
  fleet sync age (alert if > 900s in WMSPanel mode), servers total/mapped,
  functions and 24h run outcomes; URL shown on the Zabbix page
- iter2 epic closed: WMSPanel control plane (m1), strict mode separation
  (m1.2), transactional functions engine with preflight (m2), object tabs +
  hotswap (m3), live streams (m4/m7), audit log (m5), MPEGTS editors (m6),
  distribution ops + at-rest encryption (m8), transcoders (m9),
  ABR/aliases/origins (m10), backups & monitoring (m11)

### v0.3.16 (m10) — distribution: ABR / aliases / origin apps
- New account-level Distribution page (WMSPanel mode): ABR ladders (output
  app/stream + rendition rows editor, order preserved), application aliases
  (aliases one per line, protocols, pause/resume, description) and origin
  apps — full CRUD for all three; server_ids everywhere edited as checkboxes
  of mapped panel servers and displayed as names (empty = all servers)
- Functions engine: account-level kinds generalized (ACCOUNT_KINDS) — `abr`
  and `alias` join `transcoder` as patchable object kinds with the full
  preflight/snapshot/verify/rollback cycle (e.g. alias pause via patch);
  builder Browse works for them without selecting a server

### v0.3.15 (m9) — transcoders
- New account-level Transcoders page (WMSPanel mode, wmsobjects perms):
  list with server names resolved via mapping, tag/server filters, running/
  paused lamps, Pause/Resume/Clone (clone confirmed), Details modal with raw
  transcoder JSON incl. pipelines (editing arrives after schemas are pinned
  from live use)
- Transcoder licenses panel with expiry warnings (<30 days highlighted,
  expired flagged)
- Functions engine: object kind `transcoder` (account-level — no server
  mapping needed): pause/resume actions with paused-state verification and
  inverse rollback, generic patch steps; presets «Подмена: pause/resume
  transcoder» — the third substitution mechanism alongside republish source
  switching and hotswap emergency
- Route-order runtime assert (licenses before :objId) added to validation

### v0.3.14 (m8) — distribution operations layer + at-rest encryption
- Live Pull tab: RTMP pull feeds with fallback_urls (the built-in feed
  reserve) — create/edit/delete, pause/resume, Restart; fallbacks edited one
  per line
- Apps tab: live applications CRUD — protocols, chunking, push credentials
  (masked in the table with per-row reveal); Interfaces tab (view)
- Functions engine: new object kind `live_pull` — patch steps (e.g. switch
  source URL with snapshot/rollback/preflight) and `restart` action; builder
  presets "Live pull: switch source URL" / "Restart live pull"; action steps
  can now target outgoing or live_pull
- At-rest encryption (AES-256-GCM) for the WMSPanel API key and server
  management tokens in MongoDB; key derived from the panel JWT secret
  (persisted in /etc/nnm-control/nnm-control.env — must stay stable); legacy
  plaintext values are read transparently and encrypted on next save;
  roundtrip covered by a build-time self-test

### v0.3.13 (m7) — real Live Streams + full API inventory tooling
- Streams tab now uses the CONFIRMED endpoint /server/{id}/live/streams —
  the same data as WMSPanel "Живые потоки": all protocols with status lamps,
  video/audio codecs, resolution, bitrate, publisher IP, uptime, tags;
  grouped by application, filter, optional 30s auto-refresh (1 call/load),
  per-stream Delete (wmsobjects.manage). Deep-stats path removed
- Function builder source picker now feeds from live streams (fallback:
  aggregation from configured objects)
- tools/wmspanel-api-inventory.sh: downloads the official API reference,
  extracts EVERY "METHOD /v1/..." endpoint into api-inventory.txt, then
  live-dumps every GET against your account (placeholders auto-filled;
  unresolved ones listed in _skipped.txt; mutating methods never called) —
  the complete no-guessing map of the WMSPanel API

### v0.3.12 (m6) — MPEGTS In editor, outgoing CRUD, streams diagnostics
- New MPEGTS In tab: settings editor for incoming streams (create/edit/delete
  with protocol/mode selects and parameters JSON) plus telemetry — status
  lamps, bitrate, codecs parsed from PMT/PIDs. Positioned honestly as the
  settings view, NOT the full "Живые потоки" aggregate (that covers RTMP/HLS/
  encoder inputs with codecs and uptime and lives in a different API section)
- Outgoing tab: create/edit/delete with video/audio source pickers fed from
  the incoming list (source names shown inline instead of raw ids)
- Streams tab: when deep-stats returns 0, automatically retries without the
  kind filter and offers a Debug expander with the queries tried + raw sample
- Dump script v2: probes candidate live-streams endpoints (read-only; 404s
  are recorded as useful signal) and /streams kind variants — to pin the true
  full live view API

### v0.3.11 (m5.1) — FIX: missing wmspanel object routes
- FIX (critical): backend routes for the UDP/SRT, Outgoing, Hotswap and
  Streams tabs were silently missing in v0.3.8–v0.3.10 — the code insertion
  anchored on a comment removed earlier and no-opped without failing, so the
  tabs shipped frontend-only and returned HTTP 404. Routes are now present
  and verified at runtime (express route-table introspection is part of the
  build validation), covering: udp list/update, outgoing list/update/pause/
  resume/restart, hotswap full CRUD, active streams via Deep stats
- FIX: the permission catalog was missing six keys added since m1
  (settings.manage, wmsobjects.view/manage, functions.manage/execute,
  audit.view) — same silent-patch class; invisible to superadmin/admin
  (implicit all) but custom roles could not be granted these. Catalog is now
  rewritten wholesale and runtime-asserted
- Process hardening: patch steps are now verified with grep + runtime checks
  instead of unconditional success messages

### v0.3.10 (m5) — audit log
- Every mutating API request (POST/PUT/DELETE) is audited: who, when, from
  which IP, what action, sanitized payload (passwords/tokens/API keys are
  masked recursively), HTTP outcome; plus explicit events for logins
  (success/fail with reason) and function run completions (with run status)
- Audit page (permission `audit.view`): filters by user / action substring /
  outcome, expandable detail JSON, cursor-based "Load older"
- Retention 90 days via Mongo TTL index; audit writes never break the main
  request flow

### v0.3.9 (m4) — active Streams tab (Deep stats)
- Server page (WMSPanel mode): Streams tab with active streams via WMSPanel
  Streams API — grouped by application, filter, counts; clear error text if
  Deep stats / data slices are unavailable on the account
- API-budget-aware: manual Refresh by default, optional Auto (30s); each load
  costs 2 upstream calls (data slice + streams) against the 15k/day limit

### v0.3.8 (m3) — WMSPanel object tabs & hotswap substitution
- Server page (WMSPanel mode) gains three tabs on canonical schemas:
  UDP/SRT outputs (view; edit source_streams with PIDs preserved — full
  entries are sent back with only application/stream changed; pause/resume),
  MPEGTS Outgoing (view with native delivery status lamp; pause/resume/
  restart), Hot swap (full CRUD, EMERGENCY toggle = picture substitution,
  edit substitute pair; created disarmed)
- Functions: outgoing patch/action steps now additionally require the native
  `status: synced` confirmation during verification — proof of delivery to
  the Nimble instance, stronger than field comparison
- Builder presets: «Подмена картинкой ON/OFF» via hotswap emergency
- New permissions: `wmsobjects.view` / `wmsobjects.manage`

### v0.3.7 (m2.4)
- Preflight now suggests canonical twins for unknown patch keys
  ("'src_stream' → did you mean 'src_strm'?") — saved functions are data and
  are never rewritten by panel upgrades, so legacy keys in old functions get
  an actionable hint instead of just a field list

### v0.3.6 (m2.3) — canonical WMSPanel schemas (pinned from live dump)
- Field names pinned from a live-account dump (13 servers, 3295 objects):
  republish uses `src_app`/`src_strm` and `dest_strm` (NOT src_stream);
  SRT/UDP output source lives in `source_streams: [{application, stream,
  pmt/video/audio pids}]`; outgoing uses `application`/`stream` and exposes
  `status: synced`; hotswap fields confirmed and WORKING on the account
- All presets, key-pair picker, object browser, stream aggregation and the
  WMSPanel Republish tab now use canonical names; new preset "Switch SRT/UDP
  output source" (inserts source_streams; PIDs omitted — WMSPanel reassigns
  them, copy the full array from Browse tooltip if fixed PIDs matter)
- FIX: verification deep-compares object/array patch values (source_streams
  would previously false-match via '[object Object]')
- tools/ now ships in the deb at /usr/share/nnm-control/tools/

### v0.3.5 (m2.2) — preflight: doomed transactions touch nothing
- New phase 0 for every run: all steps are validated BEFORE any mutation —
  server mapping, object existence, and (for patch steps) that every patch
  key exists in the object's real WMSPanel schema. Any problem →
  PREFLIGHT_FAILED with per-step reasons + the list of actually available
  fields; zero changes are sent (production streams are never touched by a
  predictably failing function)
- Honest limit: mid-run environment failures (network/WMSPanel outage between
  steps) are still handled by snapshot rollback — full two-phase commit is
  not possible over the WMSPanel API
- tools/wmspanel-api-dump.sh: dumps raw JSON of servers, data slices and all
  per-server object kinds (republish, mpegts/udp, mpegts/outgoing,
  mpegts/incoming, hotswap) via your API key — for pinning exact field names
  from the live account instead of docs; output contains no credentials

### v0.3.4 (m2.1) — transactional integrity fixes
- FIX (critical): the failed step itself is now rolled back when its mutation
  was actually sent — a PUT that applied but whose verification timed out no
  longer leaves the change silently in place (`applied` flag per step)
- Verify loop is tolerant to transient GET errors (only the deadline aborts),
  window raised to 180s; step detail now says "Applied; verifying…" to match
  reality (the ~30s figure is WMSPanel's delivery cycle, not our window)
- Verify-timeout errors now include LAST SEEN values of the patched fields vs
  expected — field-name mismatches with WMSPanel become self-evident in trace
- Builder: app/stream source picker — active streams via WMSPanel Streams API
  (Deep stats) with fallback aggregation from configured republish/outgoing/
  udp objects; insert as src_app/src_stream, application/stream or hot-swap
  key pairs

### v0.3.3 (m2) — engineering functions engine
- Functions: ordered transactional macros over WMSPanel-managed objects.
  Step types: `patch` (republish rule / UDP+SRT output / MPEGTS outgoing /
  hot swap setting — arbitrary fields), `action` (pause/resume/restart of
  outgoing stream), `delay`
- Transactional semantics: pre-change GET snapshot of patched fields → PUT →
  verification by polling until fields reflect (window 120s, accounts for the
  ~30s WMSPanel→Nimble sync cycle) → on any failure automatic reverse-order
  rollback from snapshots; every transition persisted for live UI trace
- Builder UI with presets ("Switch republish source", hot swap, pause/resume,
  delay…) and a WMSPanel object browser per server/kind
- Live run view: per-step animation (applying/verifying/done/error/rollback),
  run history with full traces and cancellation reason
- Permissions: `functions.manage`, `functions.execute`; custom roles get a
  per-function allow-list (checkboxes in Roles) enforced on execute
- WMSPanel client: udp/outgoing/hotswap families added

### v0.3.2 (m1.2)
- Strict control-plane separation: while control plane is WMSPanel API the
  native Nimble API is fully disabled — backend rejects all /api/nimble calls
  and the native connectivity test (409), no native requests leave the panel
- UI is gated by the same flag: Dashboard shows WMSPanel fleet status (no
  native polling); server pages show only WMSPanel-backed tabs (Republish);
  Servers page hides native-only fields/columns (management port/token/SSL,
  Test, Auth); backup mode restores everything as before
- Control plane is now provided app-wide via auth context and refreshes
  immediately after saving Settings

### v0.3.1 (m1.1)
- WMSPanel control plane now auto-manages the fleet: servers are pulled from
  WMSPanel and materialized in the panel automatically (on enabling the mode,
  every 10 minutes, and via "Sync now" on the Servers page)
- Non-destructive sync: upsert by WMSPanel id, Nimble-kind only; name/tags/
  status refreshed; operator-set host never overwritten; local servers absent
  in WMSPanel are kept. Native management port/token are unknown to WMSPanel:
  port defaults to 8082, token is filled in by the operator once
- Servers page: WMSPanel-mode banner, per-server sync badge with panel status
- Native control plane behaviour unchanged (manual fleet management)
### v0.3.0 (m1)
- System Settings page (superadmin/admin or `settings.manage`):
  - WMSPanel API credentials (Client ID + API key) manageable in the panel
  - Manageable API base URL: api.wmspanel.com/v1, api.wmspanel.ru/v1 or custom
  - Control plane switch: WMSPanel API (primary, persistent) / Native API
    (backup mode for WMSPanel outages; ephemeral rules, documented limits)
  - Live "Test connection" (lists WMSPanel servers)
- Server ↔ WMSPanel server id mapping (auto-picker when API creds are set)
- Republish tab is dual-mode:
  - WMSPanel mode: PERSISTENT rules — list, create, delete, restart and
    "Switch source" (edit src app/stream — the placeholder-swap primitive)
  - Native mode: iter1 ephemeral rules with explicit collision warning
- New permission: `settings.manage`
- Planned next (m2/m3): functions engine with transactional steps & rollback,
  live step animation, per-function role permissions, SRT/UDP-output source
  switching (pending WMSPanel API coverage confirmation)

## iter1 (v0.2.x) — foundation
- v0.2.x: auth/roles, servers CRUD, native Nimble API client, per-server
  views (Streams/Sessions/SRT/Republish/MPEG-TS/Playout/Control), Zabbix
  endpoints, APT distribution (deb + signed repo on gh-pages, debconf
  domain/port, ghcr images, systemd + CLI, web first-run superadmin setup)
