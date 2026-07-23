# Changelog

## iter6 follow-up
### v0.6.11 — create forms as modals + translation pass
- RTMP Push and Hotswap opened their create form as a panel below the list;
  both are modals now, consistent with every other tab
- Translation pass: ~240 hardcoded strings moved into the dictionaries
  (EN/RU) — table headers, form labels, empty states, confirmations, hints and
  buttons across servers, streams, transcoders, distribution, functions,
  users, roles, audit, dashboard, setup and login. Left in English on purpose:
  tab names, the NNM CONTROL wordmark, Settings page fields, and protocol
  identifiers (SSL, TTL, RTT, JSONPath, X-Zabbix-Token, GMT, date formats)
- Two new gates, both of which caught real defects while writing this:
  - `npm run audit:i18n` — every t('key') must exist in BOTH dictionaries,
    otherwise the raw key leaks to the UI (caught a missing wo.port)
  - hook audit now also flags `t()` used where `t` is shadowed by a map
    variable (t = transcoder), which would call an object as a function
- FIX: the hook audit had been silently checking zero files since it moved to
  scripts/ (relative globs). After fixing the paths it flagged 20 components
  calling t() without binding useI18n — all latent blank screens, all bound

## iter6 follow-up
### v0.6.10 — fix CI image build (icons were never committed)
- The web image build failed with `"/public": not found`: .gitignore carried a
  bare `public/` rule (added back when the APT repo started publishing the
  repo-root ./public to gh-pages), so frontend/public/ was silently skipped by
  `git add` and never reached the CI checkout, even though `COPY public` was
  correct and the local build was green
- Anchored the rule to `/public/` so the generated APT output stays ignored
  while frontend/public/ is committed; added the 10 icon files
- Hardened `npm run audit:docker`: it now also verifies that every Dockerfile
  COPY source is tracked by git, which is the difference between the working
  tree and a CI checkout. Confirmed it reproduces the exact CI failure before
  the fix and passes after

## iter6 follow-up
### v0.6.9 — favicon actually ships; tag management reworked to full CRUD
- FIX icon: the Dockerfile never copied `public/`, so the container built a
  dist with no icons and the <link> tags 404'd — the local build I verified
  last time was not the build that ships. Added `COPY public ./public` and a
  new audit (`npm run audit:docker`) that rebuilds using ONLY what the
  Dockerfile copies and asserts every asset referenced by index.html exists;
  verified it fails when the COPY is removed
- FIX tag removal: clicking a chip's × never reached the server. The inline
  editor's outside-click handler fired on mousedown and unmounted the × before
  the click landed. Reproduced first, then fixed by design
- Tag management reworked into a single picker popover (the pattern issue
  trackers use for labels): search, a checklist where clicking a row assigns
  or unassigns, and a "Create <tag>" row for new values — add and remove now
  live in one place. Chips also keep a hover × for quick removal, and the
  popover treats the whole cell as "inside" so chip clicks can't dismiss it
- Tag vocabulary CRUD: "Manage tags" mode renames a tag across every object of
  that tab, or deletes it everywhere (confirmed). Backend:
  POST /stream-tags/:serverId/vocab/:kind/rename and .../delete, both audited
  (streamtag:rename / streamtag:delete), kept under /vocab/ so a tag name can
  never collide with an object id
- Tests: tag add/remove/assign regressions added to `npm run audit:ui`

## iter6 follow-up
### v0.6.8 — radio redesign + app icon
- Radio buttons were collapsing into blobs: a global `input { width: 100% }`
  rule combined with inline `width:auto` hacks overrode their size. Fixed the
  base style (crisp 16px ring, accent fill + focus ring, hover and disabled
  states) and removed the inline hacks
- Mode selectors are now selectable cards with a title and per-option
  description: Settings → Control plane (WMSPanel / Native, each with its own
  explanation instead of one dense paragraph) and SRT Out → source mode.
  Interactive controls stay outside the <label> so clicking them can't
  re-trigger the radio
- Added the app icon set: favicon.svg (primary, scalable), multi-size
  favicon.ico, 16/32 PNGs, apple-touch-icon (180) and 192/512 icons with a
  site.webmanifest. Teal (#3fb6a8) rounded badge with the NNM "N" monogram,
  matching the panel's palette; verified they land in dist/ and are served
  ahead of the SPA fallback

## iter6 follow-up
### v0.6.7 — per-tab tag vocabulary, search clear, themed tag dropdown
- Tags are now scoped per tab: the filter chips and the entry dropdown only
  offer tags actually used by that tab's objects on that server (RTMP Push and
  RTMP Pull keep separate vocabularies). The catalog is derived from the tag
  map filtered by kind, so it stays correct as tags are added/removed; filter
  chips that no longer exist in the tab are dropped automatically
- Every search/filter field is now a shared SearchInput with a clear (×)
  button (Streams, SRT In, Transcoders, Functions object picker, and the
  search inside Select). Escape also clears; focus returns to the field
- Tag entry replaced the unstylable native <datalist> with our own dropdown:
  themed, filtered as you type, shows a "Create <tag>" row for new values, and
  renders through a portal so it is never clipped by a scroll container
- Tag writes now roll back the optimistic update if the request fails
- Tests: per-kind catalog unit test; new `npm run audit:ui` covering the clear
  button and per-tab tag suggestions in a real DOM

## iter6 follow-up
### v0.6.6 — UI bug fixes
- Select dropdowns no longer break modal forms: the popup now renders in a
  portal with fixed positioning (modals are overflow:auto scroll containers,
  which clipped the absolutely-positioned popup — visible on "SRT in Nimble"
  create/edit). It also flips upward when there's no room below and follows
  scroll/resize. Fix applies to every Select in the app
- RTMP Push: moved Refresh / + New rule above the list in both variants
  (wmspanel rules and native rules) — the last tabs still having them below
- Server title: replaced the full-size Edit button with a compact inline
  pencil icon button (muted by default, accent on hover, tooltip + aria-label)
- Functions: "Browse objects…" now toggles the picker closed on a second click
  (label switches to "Hide objects"); the selected object line is now a
  highlighted row with an accent bar instead of a muted hint
- Functions: object labels can no longer render the literal "undefined" —
  kinds whose schema isn't pinned (e.g. ABR settings, which carry
  source_streams but no name/protocol) fall back to a short id
- Hardening: render smoke now mocks auth so RepublishTab renders its real
  table, and asserts the "action buttons above the table" invariant on all 9
  tabs; added a Select portal test (`npm run audit:select`)

## iter6 follow-up
### v0.6.5 — tags on the remaining stream tabs
- Extended panel-side tags (no reload) to the tabs that were missing them:
  Streams, Apps, Interfaces, RTMP Push (both wmspanel + native rule variants),
  and Hotswap. Same inline chip editor + OR/AND filter bar as the other tabs
- Tag keys: object id for Apps/Interfaces/Hotswap/RTMP Push; for live Streams
  the stable app/stream path (live ids are ephemeral). kind namespaces:
  streams, apps, interfaces, republish, hotswap
- Bound useI18n t in Apps/Interfaces/Hotswap (they didn't use t before); used a
  distinct hook alias (tg) to avoid shadowing the `st` row variable in Streams
  and the per-rule status `st` in native RTMP Push
- Verified: hook-binding audit + headless render smoke (now 9 tabs incl. RTMP
  Push, with sample data) both green

## iter6 hotfix
### v0.6.4 — fix blank screen on RTMP Pull / SRT tabs
- Root cause: UdpTab, OutgoingTab, LivePullTab and MpegtsInTab used t() in JSX
  (added with the tags column in m3) but never bound `const { t } = useI18n()`,
  so `t` was undefined and those tabs threw at render → blank screen. This is
  a runtime error esbuild can't catch, which is why the build was green
- Fix: bound t in all four components
- Hardening: added a per-component hook-binding static audit
  (scripts/hook-binding-audit.py, `npm run audit:hooks`) that flags any
  component using t/can/push/confirm without declaring it, and a headless
  render smoke test (scripts/render-smoke.mjs, `npm run audit:render`) that
  mounts every stream tab with sample data and asserts no crash. Both pass;
  the earlier file-level i18n check that missed this is superseded

## iter6 — server functionality in the panel (in progress)
### v0.6.3 (m4) — copy streams between servers
- Multi-select streams in SRT Out / SRT in Nimble / RTMP Pull / SRT In (leading
  checkbox column + "select all visible"), then "Copy to server…" to another
  mapped server. Created stopped (paused) by default
- Backend POST /wmspanel/copy-streams: lists authoritative source objects,
  maps ONLY portable fields per kind, POSTs on the target, then pauses
  (field or action per kind), and copies udp source_streams. Per-item result
  with warnings; audited streams:copy
- Honest portability handling: udp source_id and outgoing video/audio_source
  reference server-local objects and are NOT copied — each such item is flagged
  "re-link source on target". livepull and incoming copy fully
- NOTE: create-response id extraction and paused-on-create are built to the
  documented shapes but validated only against fixtures — verify one copy on a
  non-critical target live (flagged per our deferred-validation rule); EN/RU

### v0.6.2 (m3) — stream tags with OR/AND filtering
- Panel-side tags for WMSPanel stream objects (SRT Out, SRT in Nimble, RTMP
  Pull, SRT In). Tags live in the panel DB keyed by (serverId, kind, objId),
  so assigning a tag is a panel-only write — the stream is NEVER reloaded
- Inline chip editor per row (add via autocomplete from the server's tag
  catalog, remove); a filter bar of catalog chips with an OR/AND mode switch
  (OR = any selected tag, AND = all selected tags), matching WMSPanel behaviour
- Backend: StreamTag model (unique on serverId+kind+objId) + routes
  GET /stream-tags/:serverId (map + catalog) and PUT /:serverId/:kind/:objId
  (audited streamtag:set); view=wmsobjects.view, edit=wmsobjects.manage
- OR/AND matcher unit-tested; EN/RU

### v0.6.1 (m2) — edit server (WMSPanel "Server" object)
- "Edit" button in the server detail header (right of the name) opens a modal
  editing the WMSPanel server object per the API "Server" tag: display name,
  custom IPs/domains (add/remove list), and tags. Shows reported IPs/status/
  kind read-only. Applies on the next WMSPanel sync
- Backend: wmspanelClient.serverUpdate (PUT /server/{id}); proxy GET/PUT
  /server/:id/wmsinfo (view=servers.view, edit=servers.manage) resolving the
  mapped wmspanelServerId; body whitelisted to name/custom_ips/tags
- Button shown only in wmspanel plane for mapped servers with servers.manage;
  parses the documented GET /server response; EN/RU

### v0.6.0 (m1) — button placement + tab grouping
- Moved Refresh/New buttons above the list on the tabs where they were below
  (SRT Out, SRT in Nimble, Hotswap, Interfaces); the rest already had them on
  top. Consistent with the RTMP Pull layout
- Grouped server tabs by category with visual separators: General (leftmost) →
  RTMP (Push, Pull) → SRT (SRT/SRT In/SRT Out/SRT in Nimble/MPEG-TS) → Other
  (Hotswap, Playout) → System (Control). Works in both control planes; EN/RU
  group labels on hover

## iter5 (v0.5.x) — continued
### v0.5.2 (m3) — transcoder pipeline editor
- Built from the real WMSPanel schema captured via ?details=true (8 video +
  8 audio pipelines dumped): editor for video/audio pipelines with correct,
  differing field sets — inputs (app/stream/main + forward flags: video has
  sei_timecodes/dvb_teletext, audio has metadata), outputs (codec/encoder/
  key-value params/key_frame_alignment + forward flags), filters (video
  type/name/params incl. picture overlay filename/width/x/y; audio type/
  outputs_number)
- Backend: GET /transcoder/{id} now requests details=true so pipelines come
  through; proxy routes for pipeline sub-object GET/PUT/DELETE and pipeline
  DELETE; client methods pipelineGet/Delete/IoUpdate/IoDelete
- Frontend: "Pipelines" button on each transcoder opens an editor modal;
  per-input/filter/output Save (PUT) and Delete, per-pipeline delete; EN/RU
- Editor logic verified against the real dumped scenario (fields/params parse
  correctly). NOTE: write paths (PUT/DELETE) are built to the documented
  endpoints but not yet exercised against the live API — validate on one
  non-critical transcoder first (flagged, per our deferred-validation rule)

## iter5 (v0.5.x) — transcoder pipelines, playlists, SRT helper
### v0.5.x (m3 prep) — transcoder pipeline schema probe
- FIX dump script: `GET /transcoder/{id}` needs `?details=true` to return
  `video_pipelines[]`/`audio_pipelines[]` (each with inputs/filters/outputs;
  inputs have a `main` flag). Earlier empty results were the missing param,
  not passthrough transcoders. Script now requests details and parses the
  real field names; verified against a details=true fixture
- Dump of 5 production transcoders showed all are passthrough — `GET
  /transcoder/{id}` returns metadata only, no pipelines; WMSPanel exposes
  pipeline ids only via the scenario response and has no list-pipelines
  endpoint. Pipeline editor forms need a populated transcoder to pin the
  input/filter/output schema (won't guess from docs)
- `wmspanel-transcoder-dump.sh` gained TRANSCODER_ID targeting and an explicit
  per-transcoder pipeline-count report so the next sample is decisive
- Transcoder metadata editing (name/description/tags) already shipped earlier;
  no fabricated pipeline UI added

### v0.5.1 (m2) — Playlist Builder (Nimble Playout)
- Ported the Playout playlist engine to JS (playlist_engine.py): model
  Tasks → Blocks → Sources, clean JSON build (drops empty/default fields;
  VOD-only fields excluded for live sources), parse/round-trip and validation.
  Output verified byte-for-byte identical to the Python original, round-trip
  stable
- New Playlists page: full CRUD stored in the panel DB (no WMSPanel API exists
  for playlists — native Nimble feature). Nested editor for tasks/blocks/
  sources with add/duplicate/remove, seconds↔ms time fields, "GMT now" and
  "new block Id" helpers, live JSON preview, import existing JSON, copy and
  download, and live validation with human-readable notes (EN/RU)
- Backend: Playlist model + CRUD routes (audited: playlist:create/update/
  delete), new `playlist.manage` permission; `playlist.view` grants read
- EN/RU strings throughout

### v0.5.0 (m1) — SRT settings helper + transcoder scenario probe
- New tool `tools/wmspanel-transcoder-dump.sh`: walks the full transcoder
  "Scenario" API subtree (list → scenario → video/audio pipeline →
  input/filter/output) and the transcoder license view; emits raw JSON plus a
  redacted `_schema.txt` (field names + types, values masked) to design the
  pipeline editor from the real schema. Prep for m3.
- Ported the SRT Settings Helper engine to JS (faithful to the desktop tool;
  outputs verified equal to the Python original across scenarios): given a
  bitrate, channel scenario (local/russia/inter) and a drops flag, it computes
  latency, maxbw (bytes/s), snd/rcv buffers, fc and a sysctl block, with URL
  query and localized guidance notes
- SRT helper widget on the SRT In and SRT Out tabs (collapsible, copy buttons)
- Toggle in system Settings (srtHelperEnabled, default on) to show/hide it
- Full EN/RU strings; notes preserved from the original tool

## iter4 (v0.4.x) — UX refinement round 2
### v0.4.6 (iter4) — styled confirms, pinned sidebar, toast fix, more i18n
- All confirmation dialogs are now in-app styled modals (promise-based
  useConfirm) instead of the browser's native confirm() — 23 call sites
  converted across every page; safe-close behaviour applies to them too
- Sidebar (version + profile + logout) is pinned to the viewport: it no
  longer scrolls out of sight on tall pages; the nav scrolls internally
- FIX: the "Settings saved" toast fired on entering the Settings page — the
  notification was wired to the initial load call instead of the save; moved
  to the actual save
- i18n: server control-plane banners and the RTMP Push (republish) tab —
  buttons and notices — now translate with the RU locale
- Validation: reran the runtime i18n-hook audit; confirmed every t() caller
  imports the hook

### v0.4.5 (iter4) — function builder pickers & wider i18n
- Function builder: the Browse-objects list now collapses after you pick an
  object (was staying open), and gained a filter box for long lists
- Source picker "app/stream" dropdown replaced the native datalist with the
  themed searchable Select (was rendering as a browser-default popup)
- Both function pickers are now searchable
- i18n coverage widened: page titles/subtitles and common actions across
  Dashboard, Servers, Settings, Users, Roles, Transcoders, Distribution,
  Zabbix, Functions, Audit now translate with the RU locale (full string
  coverage of every page is still in progress)
- Validation hardened: added a runtime-safety audit that every component
  calling t() actually imports the i18n hook (esbuild does not catch missing
  identifiers) — caught before shipping

### v0.4.4 (iter4) — checkboxes, toasts, JSON→fields, streams & notes
- Custom-designed checkboxes and radios across the whole app (themed, replace
  native controls everywhere automatically)
- Toast notifications (bottom-right) for system events: login/2FA success,
  preferences saved, settings saved — non-blocking, auto-dismiss, click to
  close
- No more raw JSON dumps in the UI: transcoder Details now shows structured
  fields + pipelines; the native raw panels, republish raw and audit detail
  render via a reusable DataView (key/value fields, nested objects, arrays)
  with a "Copy JSON" affordance kept for diagnostics
- Streams tab: per-stream Delete removed (a running stream can't be deleted,
  matching WMSPanel); added "Delete all down streams" that clears only
  offline entries; top control row aligned, counts pushed to the right
- ABR rendition editor: numbered rows, aligned inputs, clearer remove/add
  ("+ Add rendition")
- Notes/textarea fields can no longer be dragged wider — vertical resize only
- Confirmed shipping since v0.4.3 (sidebar in the reported screenshots showed
  v0.4.2): safe modal close on outside-release, and the function builder
  showing the picked app/stream under the id + per-user dialog width


### v0.4.3 (m4) — UX polish; ITER3 CLOSED
- All 18 modals across the app now close safely: a text-selection drag that
  starts inside and releases on the backdrop no longer closes them (only a
  genuine backdrop press-release, or Esc). Retrofit via a shared
  `backdropClose` helper; no native browser confirm-on-drag behaviour left
- All 16 native <select> dropdowns replaced with the themed custom Select
  (searchable where the list is long: server/incoming pickers); consistent
  look in both dark and light themes, including the option list
- Function builder clarity (5a): after picking an object via Browse, the
  chosen app/stream is shown under the id ("Selected: app/stream") and stored
  on the step, so the meaning of the inserted id is never ambiguous
- Admin can reset another user's 2FA (recovery for lost device/backup codes):
  button in Users (hidden unless that user has 2FA on), superadmin protected,
  audited as users:reset_2fa
- iter3 epic closed: theme system (m1), profile settings + i18n (m2), TOTP
  2FA (m3), UX polish (m4)

### v0.4.2 (m3) — two-factor authentication (TOTP)
- Optional TOTP 2FA (RFC 6238, dependency-free implementation with a
  build-time check against the RFC test vectors): setup with QR code +
  manual key, enable after verifying a code, one-time backup codes (bcrypt-
  hashed, single-use), disable requiring password + a valid code, backup-code
  regeneration
- Login is now two-step when 2FA is on: password returns a short-lived signed
  ticket that grants nothing but step 2; step 2 accepts a TOTP or a backup
  code and only then issues the session token
- Secret and pending secret encrypted at rest (fieldCrypto); backup codes
  stored hashed; audit events for enable/disable/verify/backup-code use;
  audit sanitizer widened to mask ticket/code/backup fields
- Profile page 2FA section (QR via bundled qrcode lib) and login second-step
  screen; EN/RU strings

### v0.4.1 (m2) — profile settings & i18n
- New Profile page: theme (system/dark/light, instant preview + persisted),
  language EN/RU, function-dialog width preference, self-service password
  change (verifies current password, min 8 chars, audited); 2FA placeholder
- Per-user preferences persisted server-side (User.preferences); `/auth/me`
  returns them; PUT /auth/me/preferences and POST /auth/me/password added
- i18n scaffold: flat EN/RU dictionary with {var} interpolation, English
  fallback; sidebar navigation and Profile page translated; language follows
  the saved preference and applies app-wide
- Saved theme is applied on login/app load; function builder dialog uses the
  user's chosen width; password change events recorded in the audit log

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
