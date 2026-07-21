# Changelog

Iteration ↔ version mapping: new iteration = minor bump, fixes inside an
iteration = patch bump.

## iter2 (v0.3.x) — engineering functions & WMSPanel control plane
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
