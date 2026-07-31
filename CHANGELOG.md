# Changelog

### v0.21.5 — the variant picker stopped blinking
- Switching variants cleared the preview before fetching the next one, so the
  table emptied, the dialog collapsed and then re-expanded a moment later —
  read as the whole window blinking
- The previous answer stays on screen until the new one arrives, the same
  approach the log views use, and each variant's preview is kept so flipping
  between two of them is instant after the first look
- **Keeping the old table is only honest if it says so.** While a different
  variant is loading it is dimmed and labelled, and staleness is derived from
  comparing the preview's own variant id against the selected one rather than
  from a flag someone has to remember to set
- A floor under the table height, so the first load does not resize the dialog
  either


### v0.21.4 — release pipeline hardened against a Docker Hub blip
- **The v0.21.3 tag failed in CI, and not because of anything in the code.**
  `docker/setup-buildx-action` starts a BuildKit container which it pulls from
  Docker Hub, and the runner could not reach `registry-1.docker.io`. No build
  step ran at all
- The dependency cannot simply be dropped: the plain `docker` driver cannot
  export the GitHub Actions layer cache this build relies on, and losing that
  turns every release into a full `npm install`
- So the exposure is reduced rather than removed. The buildx step is attempted
  twice, which costs nothing and covers a blip. An actual Hub outage still
  fails the release, and should
- Optional Docker Hub credentials (`DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`)
  are used before the pull when present, because anonymous pulls are
  rate-limited per source IP and GitHub's runners share theirs — the other
  common way "Booting builder" fails with nothing wrong
- A 30-minute job timeout, so a hung network step costs minutes rather than the
  six hours a job is allowed by default


### v0.21.3 — the run preview names its sources
- The variant picker showed the raw patch, so the last thing read before a
  function touches live streams was a wall of 24-character ids. The panel
  already resolves these everywhere else; the preview was the one place that
  did not
- Source ids are resolved server-side, where the WMSPanel credentials are. One
  upstream call per distinct server, only for steps that actually reference a
  source, cached for a minute — the picker is switched between variants
  repeatedly and each switch re-renders this
- **A failed lookup does not stop the preview**, and an id that cannot be named
  degrades to a short id rather than a blank: an id can still be matched
  against the server's incoming list, a blank cannot
- Fields the preview cannot name stay visible exactly as they will be sent.
  Hiding part of a patch is how one comes to carry something nobody meant


### v0.21.2 — audio follows video in variants too
- The rule added in v0.21.0 lived only in the step editor, so picking a video
  source **inside a variant** left the audio behind. It is one exported
  function used by both editors now — written once rather than written twice
  and remembered once
- The follow compares against the values **in force for that variant** — the
  step's patch with the variant's own overrides on top — not the step's patch
  alone. Comparing against the step would have stopped audio following after
  the first pick
- Four cases pinned, including the two that are easy to get wrong: an audio set
  apart inside a variant survives a change of video, and returning video to the
  step's own value makes audio return with it, which leaves the variant
  overriding nothing and drops the entry entirely


### v0.21.1 — variants are picked, not typed
- **The variant editor asked for hand-typed JSON**, which is exactly the
  mistake the step editor exists to prevent: an id typed wrong points a stream
  at nothing and still verifies as applied. Each overridable field now gets the
  control its type deserves — sources come from a searchable dropdown of the
  server's SRT In / MPEG-TS In objects, scalars get an input, and only nested
  shapes with no honest control keep a raw form rather than one that would
  silently mangle them
- A value set back to the step's own **stops being an override**, and a variant
  with nothing left carries no entry at all. A variant that claims to change
  something it does not is one that confuses whoever reads it next
- **The first variant is seeded from what is already configured.** An operator
  who has set the function up for input A gets A as variant 1 instead of an
  empty variant that runs the base steps and looks identical until it is not.
  Deep-copied, or editing the variant would edit the step. Later variants start
  empty and inherit
- Both editors load the source list through one hook, because two loaders would
  eventually offer different lists for the same server
- 7 new checks on the override semantics and the seeding rule


### v0.21.0 — step editor polish, and a legible transport error
- **"fetch failed" now names its cause.** Node reports every transport failure
  as `TypeError: fetch failed` and hides the reason in `cause`, so the panel
  showed a string that points at nothing — DNS, a firewall, an unreachable
  route and a timeout all look identical and have different fixes. The message
  carries the code and the path now, and a timeout says so in its own words
- **Descriptions are dimmed in dropdowns.** `Select` takes an optional `hint`
  rendered in muted text after the label; run together in one colour, a name
  and a description read as one long name. Search still covers both
- **The audio source follows the video source** when it is empty or was
  tracking the previous video value. An audio deliberately pointed elsewhere
  survives a change of video — the convenience must not overwrite a decision
- **Steps can be duplicated**, inserted next to the original and marked
  `(copy)`. Deep-copied: a shallow copy would share the patch object and
  editing one step would silently edit its twin
- **The step palette moved back below the list.** It is nine rows of buttons,
  and above the steps it pushed the thing being edited off the screen
- Confirmed that running a function still asks first whether or not it has
  variants — the variant picker comes first, the confirmation always follows
- 5 new checks


### v0.20.2 — three source fields where there should have been one
- **The step editor offered every field pair for every object kind**, so a
  "switch the source" step ended up with `"application":"Sport_tv_obs",
  "stream":"feed1"` in its patch alongside the source ids. On an outgoing
  stream those two fields are the stream's **own** name — that patch would have
  renamed it rather than repointed it
- Pairs are now declared per kind: republish has `src_app`/`src_strm`, SRT/UDP
  has `source_streams`, hot swap has the substitute and original pairs,
  outgoing and live pull have `application`/`stream`. A source switch offers no
  generic inserter at all, because there is nothing it could insert that would
  not be wrong
- **`live_pull` was checked, not assumed.** It genuinely does carry
  `application`/`stream` — confirmed against the tab that edits them — so it
  was left alone rather than "fixed"
- **The two questions are labelled apart**: what is being changed, and what to
  set on it. Running them together is why three fields looked like three ways
  to answer the same thing
- **Object labels lead with the name**, then what the object does, then its
  description — the order every tab in the panel already uses. The picker led
  with routing detail and dropped the name entirely for republish rules and hot
  swaps, so a rule an operator had named could not be found by that name
- 5 new checks pinning which fields belong to which kind


### v0.20.1 — a shadowed route and a guessed field name
- **Clearing old runs returned 500.** `DELETE /:id` was declared before
  `DELETE /runs`, and Express matches in declaration order — so the request was
  handled as "delete the function whose id is `runs`", which casts badly. The
  servers router carries a comment warning about exactly this for `/order`; the
  functions router was written anyway
- New `npm run audit:routes`, which runs before the test suite. It reads every
  router and fails when a literal path is declared after a same-method
  parameter route that would match it first. Order is not something to
  remember; it is something to check. Verified against the real defect
- **The source dropdown showed a list of `?/?`.** An incoming object is named,
  not addressed by app/stream — `srcLabel` guessed `application`/`stream` when
  the outgoing tab three files away already resolved these by `name`. It uses
  the name now, with the description as context and the id as a last resort,
  because a truncated id can at least be matched against the server's incoming
  list where question marks cannot


### v0.20.0 — functions: the broken source picker and four rough edges
- **The source pickers were empty, and the SRT In steps had never been
  saveable.** The list of object kinds existed in three copies — the runner's
  `KIND_OPS`, the object browser's if-chain, and the model's enum — and they
  had drifted. `incoming` was in the runner and in the UI's presets but in
  neither of the others, so a step of that kind could be built, could not be
  browsed ("Unknown kind"), and failed to save with a mongoose enum violation
  that surfaced as **HTTP 500**
- One canonical list now, in `src/objectKinds.js`. The model derives its enum
  from it, the browser serves every per-server kind in it, and a test asserts
  the runner implements exactly it and that every kind a preset can produce is
  one the model accepts
- **"Internal server error" for a rejected shape is gone.** A validation
  failure returns 400 naming the field. Saving a function with no steps asks
  first — it is legal, someone may be building it over two sittings, but it is
  almost always a slip
- **The step palette and the variants moved up**, beside the name and
  description. They are what the function *is*, and having them below the step
  list meant scrolling past everything to add the next one
- **The variant picker is a real modal.** It was hand-rolled backdrop markup
  rendered wherever it sat in the tree, which put it at the bottom of the page
  under the run history; `Modal` portals to `document.body`, which is the whole
  reason it exists
- **Run history can be pruned**: one button clears runs older than three days.
  The minimum age is enforced on the server, so a mistyped zero cannot wipe the
  trace of what happened this morning, and a run still in flight is not history
- The undefined-reference audit earned its keep, catching a missing `logEvent`
  import in this change before it shipped — the same class that returned 502
  and restarted the panel in v0.16.1


### v0.19.1 — the log cache never hit once
- **The cache added in v0.18.2 never worked.** Its key was built from the query
  string, and the query string contains `from` as an absolute timestamp derived
  from `Date.now()`. Two visits a second apart produced two different keys, so
  every lookup missed and every return to a log page waited for the aggregation
  exactly as before
- The key is built from what the operator **chose** now, never from what that
  choice resolved to: "last hour" is the same request whichever second it is
  opened in, and the resolved instant belongs in the query rather than in the
  key. Fixed in all three places — the Logs page, every log window, and the
  categorical page
- The key is also order-insensitive across multi-select filters, so the same
  filter reached two ways is one entry rather than two
- The cache audit gained five checks it should have had from the start,
  including that no absolute time or epoch millisecond appears in a key.
  Verified against the real defect: putting a timestamp back makes it fail


## iter14 — agent lifecycle
### v0.19.0 — updates, watchdog, notifications, recovery
- **The panel never uploads code.** An update queues a task asking the agent to
  run its own verified update: the agent downloads the panel's copy, checks it
  against a digest that travelled with the request, keeps the old file, swaps
  atomically and exits non-zero so systemd starts the new code. A bad download
  is discarded and the agent keeps running what it has — the failure mode is
  "nothing happened", not "the server lost its agent". The mechanism is
  borrowed from NET-Control, where it has already survived production
- **Versions are compared by exact match, not by ordering** — the other lesson
  from that work. `ahead` is its own state rather than being flattened into
  "current": it means the panel was rolled back while its agents were not, and
  reporting that as current would be untrue
- The agent now installs into its systemd `StateDirectory`, which is the only
  place the service user can rewrite. An agent installed the old way keeps
  working and reports that it cannot update itself, rather than trying and
  failing halfway
- **Watchdog with debounce.** A verdict must repeat three times before it is
  recorded, and any change of verdict restarts the count. So a single missed
  poll during a panel restart raises nothing, an agent down for an hour is one
  entry rather than a hundred and twenty, and a flapping agent produces nothing
  at all. A notification channel that cries wolf is worse than none
- **The watchdog never acts.** Detection and action are separate on purpose:
  an automatic restart triggered by a false positive would be the panel
  reaching into a live broadcast server on the strength of a late heartbeat.
  This is the rule ServerMonitor arrived at, and it is asserted by a test
- **Recovery is a button**, staged and over SSH on the same terms as the SSH
  install: host key confirmed before a credential is typed, credential used
  once and never stored, and a fixed list of commands — restart the unit, then
  read its status, its journal and its environment without the token. Whether
  it worked is decided by the agent calling in, not by a restart command
  returning zero
- **Agent centre**: one button on the Agents page opening fleet state, versions,
  update-one and update-all, the event log, and recovery — because an operator
  thinks "which of them are broken and which are behind", not "this server's
  agent" thirteen times. Bulk update skips agents that are not polling and ones
  that cannot rewrite themselves, rather than queueing tasks that expire
- **A latent inconsistency fixed and caught by a test:** health reported a
  hardcoded version 2 while the poll reported `AGENT_VERSION` — one agent
  describing itself with two different numbers, both of which the update logic
  reads. The agent suite now asserts they agree rather than checking a magic
  number
- New `npm run test:lifecycle`: 20 checks, most of them on the debounce and on
  the safety properties of the mechanism. Agent protocol version 7


### v0.18.2 — logs are there when you come back, and the scrollbars match
- **Leaving a log page and returning meant waiting for the aggregation again**,
  with an empty table in the meantime. During an incident an operator flips
  between the logs, a server and back several times a minute, and each hop cost
  seconds of blank screen
- Results are now kept for a minute and shown in the first frame while a fresh
  query runs behind them, with a quiet note giving the age of what is on
  screen. A failed refresh leaves the readable answer where it is instead of
  wiping it
- The same applies to every log window, which is what the categorical page and
  each dashboard render — a dashboard of seven windows used to mean seven blank
  panes on every visit
- Filters are remembered per page too: coming back to a page that has forgotten
  which server and level you chose is the same annoyance in a different place
- The cache is in memory, bounded to 40 entries, and least-recently-used — an
  operator tuning filters produces a new key per keystroke, and the query being
  looked at must not be pushed out by its own refinements
- **Scrollbars follow the theme.** Driven by the same variables as everything
  else, so the light theme gets a light scrollbar without a second set of
  rules; both the Firefox and the WebKit forms are kept, because dropping
  either leaves one browser with a stock grey bar in the middle of a dark panel
- New `npm run audit:cache`. It found an off-by-one on the first run: the age
  check was strict, so `maxAgeMs: 0` — the natural way to say "do not use the
  cache" — served the entry anyway


### v0.18.1 — the 504, and a quieter bug behind it
- **`$limit` with no `$sort` in front of it.** A capped collection returns
  insertion order, so the cap was selecting the **oldest** matching records:
  the grouped view had been summarising the start of the window rather than the
  present, and nothing said so — it just looked like a quiet server. Every
  capped pipeline sorts newest-first now, which is both the correct end and the
  index-backed one
- **Five aggregations per page load, each up to 200,000 records.** At the
  measured 98 records/second per server, an hour of one server is ~350,000
  records, so a fleet view hit the cap on every one of them. The three facet
  pipelines are one `$facet` pass now, the cap is 60,000, and every pipeline
  carries `maxTimeMS`
- A query that runs out of time is reported as **too wide a filter**, with the
  numbers and the three ways to narrow it, instead of a gateway timeout that
  says nothing. Both are configurable: `NNM_LOG_SCAN_CAP`,
  `NNM_LOG_MAX_TIME_MS`
- Raw rows order by byte offset within a server and by time across the fleet.
  Offsets are positions in one server's file and are not comparable between
  them; timestamps cannot order 98 lines a second within one
- **Dashboard list:** the name opens the dashboard, and Open/Delete are no
  longer touching — one of them deletes a dashboard
- **Dashboard toolbar** was a pile of controls in one corner. Three jobs, three
  places now: leave on the left beside the title, add and layout labelled in
  the middle, save on the right


### v0.18.0 — server filter, server labels, window types, link port
- **Picking a server emptied every log view.** Mongoose casts a string to
  ObjectId inside `find()`, but **not** inside an aggregation pipeline — and the
  grouped view, the facet counts and the category counts are all aggregations,
  so `$match: { serverId: '65f…' }` compared a string against an ObjectId and
  matched nothing. "All servers" worked because that filter has no serverId in
  it at all. Cast once, where every query gets its filter; an id that is not an
  ObjectId now matches nothing rather than silently widening to the fleet
- **Records say which server they came from.** Names are resolved on the
  backend, so every view labels them identically, and shown as a quiet chip
  only when the view spans more than one server — on a single-server view it
  would be noise on every row. A template seen fleet-wide says "13 servers"
  rather than printing thirteen names into a row
- **Adding a dashboard window always produced "Everything"**, leaving the
  operator to find the edit control inside a window showing the whole firehose.
  The type is chosen as part of the add action now
- **Share links pointed at the wrong port.** They were built from
  `req.get('host')`, which carries a port only if the client sent one *and* the
  proxy passed it through — nginx's common `proxy_set_header Host $host` drops
  it, where `$http_host` would have kept it. A panel published on :8095 handed
  out links to :443, where a different application answers
- Fixed both ways, as asked. There is now a **public address** setting, used
  for every link the panel hands out; and when it is empty the address is
  derived far more carefully — `X-Forwarded-Host` and `X-Forwarded-Proto` ahead
  of `Host`, a port from `X-Forwarded-Port` re-attached when the proxy dropped
  it, and default ports never appended
- New `npm run test:publicurl`: 7 checks over the forwarded-header shapes,
  plus 4 on the server filter


### v0.17.1 — log collection had no switch to turn on
- **`Settings.logs.enabled` has existed since iter10 m1, the gateway has always
  sent it to agents, and the agents have always acted on it — but it was never
  given a control.** The settings route neither returned it nor accepted it, and
  the Settings page had no mention of logs at all. The Logs page told operators
  to "turn it on in Settings", where there was nothing to turn on
- New **Nimble log collection** section in Settings: the switch, the list of
  files to follow, and a live status panel showing what is actually arriving —
  records held against the cap, and per-server cursors with any gap or error.
  "Is it on" and "is anything arriving" are different questions, and after
  switching it on only the second one is useful
- The Logs page banner now offers to switch collection on in place for anyone
  holding `settings.manage`. Sending someone to another page to flip one switch
  is poor when the panel already knows they may flip it
- `settings.logs.intervalSec` removed. The push model made it vestigial — the
  agent batches on its own timer and the gateway never sent it — and a setting
  that does nothing is worse than no setting
- **Two defects found by the gates while doing this.** The i18n audit caught the
  Russian block being written into the English dictionary, where ten keys
  silently shadowed their English counterparts. The click gate caught a crash on
  the Settings page: `usage.docs.toLocaleString()` with no guard, latent until
  the new fixture made the metrics section render under test


### v0.17.0 — sidebar grouping, active-link fix, control placement
- **The sidebar is grouped** instead of being seventeen entries in one list:
  Broadcast, Logs, Infrastructure, Access & audit, System, with the dashboard
  alone above them. Driven by data, so a group whose items are all hidden by
  permissions disappears with them — a limited role must never be shown the
  heading of a section it has nothing in
- **Two navigation entries lit up at once.** React Router marks a `NavLink`
  active for descendant routes too, so `/logs/dashboards` matched `/logs` as
  well. `/logs` is `end`-anchored now. `/servers` deliberately is not: a
  server's detail page should keep its section highlighted
- **Controls no longer float in the middle of a row.** A flex row with
  `space-between` and three children spreads all three evenly, which is how the
  Agents page ended up with its "agent configured" checkbox stranded in empty
  space. The convention is now explicit — identity on the left, every control
  grouped in a nested row on the right
- The same defect was found and fixed in the Functions step editor, where the
  type badge floated between the label field and the Remove button
- New `npm run audit:layout` refuses a `space-between` row with three or more
  direct children, across all 49 components. It found the Functions case on its
  first run — the user had reported it only on the Agents page
- Building that audit surfaced a defect in the audit: counting JSX children by
  scanning for tags does not survive this codebase, because arrow functions in
  attributes (`n => ...`) contain `>` and break any "find the next angle
  bracket" logic. The first version reported the correctly-built rows as
  broken. It counts by indentation now


### v0.16.1 — hotfix: issuing an install ticket took the panel down
- **`POST /servers/:id/agent/enrollment` returned 502 and restarted the
  backend.** `scriptFor` and `sha256` were deleted during the iter12 m5 cleanup
  of the pull path, while their three call sites stayed. Syntax was valid, so
  `node --check` passed and nothing noticed until the route ran — and a
  `ReferenceError` in an async Express 4 handler is an unhandled rejection,
  which Node 22 answers by terminating the process. Hence the 502, the restart,
  and having to log in again
- Both helpers restored; the served script and its published digest are stable
  again
- **This is the second time this exact class has reached production** — the
  first was `move` on the Servers page. The frontend gained a gate then
  (`audit:pages` clicks every button). The backend had none, so it gets one:
  `npm run audit:undef` flags any identifier called but declared nowhere in its
  file, across all 65 backend modules, and runs before the test suite. Verified
  against the real defect
- Building that audit surfaced a defect in the audit itself: an apostrophe
  inside a regex literal — this codebase has several — desynchronised the
  naive string stripper, which then swallowed the rest of the file. Regex
  literals are now stripped first, and that ordering is load-bearing
- **Defence in depth: a route defect now costs one request, not the panel.**
  `src/asyncGuard.js` patches Express's router prototype so a throwing or
  rejecting handler goes to the error middleware as a 500. It is imported
  first in `index.js`, and that ordering matters — ES modules evaluate imports
  before the importing module's body, and route modules create their routers at
  module scope. Anything that still escapes is logged instead of exiting
- Two regression checks: that the enrollment routes' helpers exist, and that a
  throwing async route answers 500 and leaves the process serving


## iter13 — functions: sources and execution variants
### v0.16.0 — the original epic's remaining half
- **2a: switching the sources of an "SRT in Nimble" stream.** Three presets for
  video, audio, or both. The source is **picked, not typed** — it is a nested
  reference to an `incoming` object, and an id typed wrong switches the stream
  to nothing while still verifying as applied
- **Verification defect fixed, and it would have broken 2a outright.** The
  runner compared patched values by stringifying whole objects. A patch sends
  `video_source: { id: 'X' }`; WMSPanel answers with
  `{ id: 'X', application: '…', stream: '…' }`. Byte equality could never hold,
  so a correctly applied source switch would have failed verification and
  rolled itself back. Objects are now compared as a **subset** of the wanted
  keys, recursively; arrays and scalars keep exact comparison, because there an
  extra element really does mean the patch did not take
- **2b: execution variants.** One skeleton of steps, several sets of values —
  the same streams switched to different inputs, without a copy of the whole
  function per input that then drifts. `overrides` is keyed by step index and
  merged over that step's own patch, so a variant names only what it differs in
  and adding a stream adds it to every variant at once
- A function with no variants runs exactly as before. The empty list is the
  implicit single variant: no migration, nothing existing changes shape
- **A function that HAS variants refuses to run without one being chosen** —
  in the backend, not just the UI. Silently falling back to the base steps
  would switch streams to inputs nobody picked, which is the failure the
  feature exists to prevent
- The run picker previews what will actually be sent, resolved by the **same**
  function the executor uses. A preview computed a second way would eventually
  disagree with the run, and the operator would be reading a reassurance rather
  than a fact
- `FunctionRun` records which variant ran: "the function ran" is not the
  interesting fact when the same function can switch to four different inputs
- Stored variants are clamped on the way in — ids deduplicated (two variants
  sharing an id would run the wrong one), overrides keyed only by step index,
  non-object values discarded
- New `npm run test:variants`: 18 checks. The resolver is pure and covered
  exhaustively, including that it does not mutate the stored definition — a
  resolver that wrote through would make the second run inherit the first one's
  variant


## iter10 — Nimble log system
### v0.15.0 (m5) — dashboards and links. The epic is complete
- Any number of dashboards, each an arrangement of log windows: category,
  server, levels, range, search, size and column span, all saved. Full CRUD,
  reorder, and a live preview that is the real window rather than a mockup
- **Links that open without a panel login**, for a wall display or a second
  screen. Off until someone turns it on, optional expiry, revocable, and
  reissued rather than recovered — only the hash is stored
- **The security property that shapes the whole feature: a link cannot be
  edited into a query for something else.** The public route reads every
  filter from the stored window and ignores the query string entirely. A test
  asserts there is no `req.query` anywhere in the public half
- Stream keys are masked on the public path, including raw rows, which are not
  masked inside the panel because an operator needs the exact line. The warning
  beside the button says plainly what is *not* masked — addresses, stream names
  and error text
- **New `logs.manage` permission.** Issuing a link makes production logs
  readable without a password, which is a different act from being allowed to
  read them inside the panel, and it should not ride on the same key
- Stored windows are clamped on the way in — bounded height and span, an
  allow-list for ranges, validated level letters, a cap on window count —
  because what can be stored is what the public route will later trust
- The shared page is answered before the login gate and uses its own fetch, not
  the shared `api()` helper: that one clears the token and redirects to /login,
  which is the wrong thing to do to someone with no account watching a display
- **Two defects the click gate found in this milestone's own code:**
  `window.prompt` for the dashboard name, and a page that crashed when a
  response arrived without a `windows` array. The gate now also fails on
  "Cannot read properties of undefined" — it watched that crash happen and
  stayed green, which was too narrow a definition of a broken click
- 18 new checks


## iter10 — Nimble log system
### v0.14.1 (m4) — one window per part of Nimble
- Eight functional windows — transcoder, SRT, RTMP, playback/HTTP, pull ingest,
  DVR, core, other — each with its own level filter, time range, search and
  grouped/chronological toggle
- **The mapping was checked against the real dump before it was written into
  code**: these categories cover 100% of 163,628 records with nothing left
  over. A test re-runs that check and fails if anything falls through
- **`other` is defined by exclusion, not by a list.** The sample has no WebRTC,
  no DVR variants and one transcoder mode, so a subsystem the list has never
  met still has to appear somewhere — a log that belongs to no window is a log
  nobody ever reads
- An overview strip leads, with per-window totals and error counts. With SRT at
  74% of everything and every error in the sample living in two windows, "which
  part of Nimble is unhappy" is answerable before a line is read
- Clicking a window's name focuses it full height; empty windows collapse into
  a line that still names them, so a missing transcoder window is never a
  mystery
- **`LogWindow` is a self-contained component** that owns its filters, polling
  and state and takes only a scope and a size. That is deliberate: m5 is
  "place any number of these where you choose", and it will not have to teach
  this component anything about dashboards
- 9 new checks, including that no subsystem belongs to two windows and that an
  explicit subsystem choice inside a window is not widened back to the whole
  category


## iter10 — Nimble log system
### v0.14.0 (m3) — the general log view
- **Grouped by default, and that is the design.** In the measured sample one
  message is 93% of a server's output — 15,237 identical SRT errors in 31
  minutes — so a chronological list is one line repeated eight times a second.
  Grouped, the same 163,628 records are 142 rows
- **How a message becomes a template was measured, not guessed.** Collapsing
  every bracketed span gave 2 error templates on the real file; collapsing only
  spans that contain a digit gave 4 — and the extra two are the difference
  between "SRT closed 15,237 connections" and knowing it was `Connection does
  not exist` (8,661), `Invalid socket ID` (5,432) and `Connection was broken`
  (1,144). Addresses and socket numbers are noise; the reason in the same
  brackets is the diagnosis. Digits collapse, words survive
- Filters on server, level, subsystem, time range, and free text over both the
  message and its attached HTTP dump. Everything but the text lands on an
  index; search metacharacters are escaped, so a stream path cannot become a
  regex by accident
- Facet counts by level and subsystem sit above the results, because with one
  template accounting for most of a box's output, "what is the mix" is a better
  first question than "what is newest"
- A group expands to the records behind it, copyable as text
- **Stream keys are masked in the group view.** Nimble logs publish URLs and a
  publish URL carries the key. The warehouse still stores what the server
  wrote — rewriting that would be lying about the log — but a summary shown
  wide is not where keys belong
- Scans are capped at 200,000 records and the answer says when it was capped: a
  truncated count that admits it beats an exact one arriving after the incident
- New `npm run test:logquery`: 18 checks, the last of which runs the templating
  over the full 184,481-line file and fails if compression drops below 500×
  or the result exceeds 400 templates


## iter11 — agent installation
### v0.13.0 (m2) — install over SSH
- The panel can now connect over SSH and run the install itself. It is the same
  enrollment as the copy-and-paste path — same ticket, same checksum-verified
  command — with the panel doing the typing
- **The cost, stated rather than hidden:** installing requires root, so a panel
  that can do this can become root on every server it is given credentials for.
  Three things keep that bounded, and all three are enforced in code
- **Nothing is stored.** The credential lives in one closure for the length of
  one install: not in the database, not on disk, not in the audit log, and the
  form is cleared the moment the request is away. A stolen panel database still
  yields no way into a server
- **The host key is checked, and a mismatch aborts before the credential is
  offered.** The fingerprint is read during the handshake without
  authenticating, shown to the operator, and required on the install call. If
  the key later differs, ssh2 stops the handshake — so a password is never sent
  to whoever happened to answer on that port
- **The command is fixed.** This is not a remote shell: the only thing that can
  run is the installer for one freshly issued ticket, built by the panel, in
  its checksum-verified form. `sudo -n` so a password prompt fails fast instead
  of hanging, and the command is quoted, not concatenated
- Output streams back into the dialog and the exit code is reported, so a
  failed install says so instead of looking like a silent success
- **Security defect found before the feature existed:** the audit middleware
  persists request bodies and its secret mask covered `password` but not
  `privateKey`, `private_key`, `passphrase` or `credential`. Adding this route
  would have written operators' private keys into the audit log in clear text.
  The mask now covers them, verified by a check that also asserts non-secrets
  stay readable
- New `npm run test:ssh`: 15 checks against a **real ssh2 server in-process**,
  not a mock — the ordering being tested is precisely the one a mock would have
  to assume. Includes that a mismatched fingerprint produces zero
  authentication attempts, and that a quote in the command cannot break out of
  the sudo wrapper
- First native-capable dependency in the project: `ssh2`


## iter12 — inverted transport: the agent calls the panel
### v0.12.0 (m5) — the pull path is gone
- `agentClient.js` deleted. It had no callers left after m3; every operation
  now travels the other way
- **`agent.baseUrl` removed from the server record.** The panel does not need
  an address for a machine it never dials, and storing one was an invitation to
  start dialling again
- The reachability probe, the RFC1918 classifier and the "this address is
  private, no installer can fix that" warning are all gone — they existed to
  describe a direction that no longer exists
- The install dialog asks for one address instead of two: how the **server**
  reaches the panel. How the panel would reach the server is no longer a
  question anyone has to answer
- **The agent binds to loopback by default.** Nothing connects to it, so a
  socket on the network was attack surface on a broadcast server with no
  purpose. What is left is a local diagnostic surface — the installer uses it
  to check the agent came up, and so can an operator with a shell
- The installer no longer guesses the server's own address with `hostname -I`,
  and no longer sends one at enrollment
- Five gates against the old direction returning: no client for dialling
  agents, no address field on the server record, nothing in the backend
  reaching for one, the agent bound to loopback, and an installer that carries
  no address. Verified against a reintroduced field
- Agent protocol version 6


## iter12 — inverted transport: the agent calls the panel
### v0.11.3 (m4) — telling apart the ways an agent can fail
- "The agent isn't working" covered six situations with six different fixes.
  They are now distinguished the way NET-Control's were: by comparing when the
  agent last called in against when the task was created
- Codes: `not-configured`, `no-contact`, `stopped-polling`, `restart-loop`,
  `claimed-no-answer`, `polling-not-claimed`, `healthy`. Each carries the
  evidence it was decided on and a hint naming the command to run next
- **`polling-not-claimed` is the one that was invisible before.** A task still
  queued although the agent polled *after* it was created cannot be the agent's
  fault — every poll claims the oldest live task — so it is the panel that
  failed to hand it over. That case used to be reported as a broken agent
- `restart-loop`: an agent that keeps dying still polls, so it looked healthy.
  Identity changes are counted in a rolling ten-minute window, which separates
  an ordinary restart from a loop and stops one bad hour marking a server for
  ever
- Precedence is decided, not incidental: an absent agent outranks any stuck
  task, because sending an operator to investigate a claim bug while the agent
  is not running is sending them to the wrong place
- The classifier is a **pure function** over facts — no database, no clock of
  its own, no network — because an inverted comparison here would tell someone
  to restart a healthy agent. 23 checks cover every state, both directions of
  every timestamp comparison, and every precedence pair
- **Defect found while building it:** `runTask` expires its own task on
  timeout, but `enqueueTask` has nobody waiting, so a media transfer whose
  agent never appeared stayed `queued` for ever — and the classifier would have
  read that as a panel-side claim bug. A reaper now marks anything past its
  deadline, and the diagnosis endpoint runs it first. A diagnosis is only worth
  having if the states it reads are true
- The Agents page loads the diagnosis with the list rather than on demand: an
  operator opening it is usually there because something is wrong, and making
  them click to find out which kind of wrong is the problem it exists to solve
- Timeout messages now point at where to look instead of just saying "timed out"


## iter12 — inverted transport: the agent calls the panel
### v0.11.2 (m3) — media is collected, not pushed
- Media was the last operation still running panel → agent: the browser's bytes
  were streamed straight through to the server, so the server had to be
  reachable. On a machine behind NAT everything worked except this one button
- The operator hands the file to the panel; the agent collects it on its next
  poll, verifies it, writes it, and reports. Nothing needs to reach the server
- The upload response returns as soon as the file is safely on the panel's
  disk and does **not** wait for the agent. A 2 GB file over a slow link would
  otherwise hold an HTTP request open for minutes and fail outright if the
  server happened to be offline — precisely the case this design exists for
- **Integrity end to end.** The panel hashes the upload as it streams to disk;
  the agent hashes what it downloads, checks the digest and the byte count, and
  only then renames the file into place. A transfer cut short is refused and
  leaves nothing behind — not under the final name, not under the temporary one
- **The panel's copy is dropped on confirmation, not on download.** Deleting
  when the transfer finished would throw away the only copy while the write on
  the far side could still fail. A failed write keeps the file, so a retry
  costs nothing instead of another upload of gigabytes
- Retention: three days for a file nobody collected, immediate deletion once
  the agent confirms it is on disk. A sweeper reaps both directions — expired
  records lose their file, and files with no record lose themselves, with an
  hour's grace so an upload still streaming is not deleted mid-flight
- The spool gets its own docker volume. A 2 GB upload landing on the same
  filesystem as the database is how a panel takes its own Mongo down, and a
  separate volume is the one place an operator can look, measure and cap
- Media list and delete moved onto the task bus at the same time; `agentClient`
  now has no callers left outside the log path, and goes in m5
- New `npm run test:media`: 9 checks, including a real collect-verify-commit
  round trip over HTTP with a deliberately corrupted digest
- Agent protocol version 5


## iter12 — inverted transport: the agent calls the panel
### v0.11.1 (m2) — logs are pushed; the cursor and rotation move to the agent
- The agent follows `nimble.log` itself and pushes batches. The panel no longer
  walks 13 servers on a timer asking each what is new — at the measured
  ~13 KB/s per server that walk was the whole reason log collection needed the
  fleet to be reachable
- **The cursor lives on the agent**, in `$STATE_DIRECTORY/logcursor.json`, and
  survives a restart. Where that directory is not writable the agent still
  ships and says so once, resuming at the end of the file instead of pretending
  it knows where it was
- **The cursor only advances after a batch is accepted.** A panel that is down
  costs nothing: the log file is the buffer, and the agent re-reads rather than
  buffering in memory
- **Rotation is detected on the agent** — inode change, or the file shrinking
  below the cursor — which is far more reliable than the panel inferring it
  from what it could see between two polls
- Framing stayed on the panel deliberately. 11.3% of Nimble's lines are
  continuation text with no header, and `frameRecords` was verified byte-exact
  against a real 184,481-line file; reimplementing that inside a
  dependency-free agent would have been the wrong kind of duplication. The
  agent ships raw bytes, the parser stays in one place
- A replayed batch is dropped rather than stored twice, and a gap — bytes lost
  to a rotation the agent could not drain, or a restart with no persisted
  cursor — is counted in `bytesMissed` rather than smoothed over
- Whether to ship and which files ride on the poll response, so there is
  nothing to configure on the server and no second channel to keep alive
- 7 new checks, the central one being that a stream of pushed batches
  reconstructs byte-for-byte the records that parsing the whole file produces,
  across four batch sizes
- Agent protocol version 4


## iter12 — inverted transport: the agent calls the panel
### v0.11.0 (m1) — task queue, long-poll, claim
- **The direction is reversed.** The panel used to open a connection to every
  agent, which meant every agent needed a routable address — impossible for a
  machine on a local network behind NAT, and the reason the install dialog
  spent most of its space asking the operator to describe their network. The
  panel now writes a task and waits; the agent, which only ever makes outbound
  connections, picks it up and reports back. Nothing has to be reachable except
  the panel
- Modelled on what NET-Control's agent already does in production: outbound
  poll, authenticate, claim a task bound to one server, report a result — the
  shape its `stopped-polling` / `polling-not-claimed` diagnosis was built
  around
- **A task names the agent's own route key** (`GET /health`, `PUT /config`).
  The agent already dispatches on that string, so a task cannot ask for
  anything the agent could not already do and there is no second surface to
  keep in step
- Long-poll: the agent parks for up to 25s and is released the instant work
  appears for it. A panel request still answers in its own response — it
  enqueues and awaits — so the round trip is one hop each way, not one poll
  interval
- Every poll is a heartbeat. `lastContactAt` is written before the park begins,
  so a long wait is not mistaken for silence, and `instanceId` changes on
  restart, which is what separates a crash-looping agent from a wedged one
- Claiming uses `findOneAndUpdate`, so two agents for one server — what happens
  when an operator installs on a cloned VM — cannot both take the same task
- A timeout distinguishes *nobody claimed it* from *claimed and never answered*
  and says which, rather than flattening both into "agent unreachable"
- Enrollment now returns the server id and the installer writes it plus the
  panel URL, then restarts the service: from that point the agent connects out
  and needs no address of its own
- `health` and config read/write moved onto the bus. Media, playlist deploy and
  log tailing still use the old path and move in m2–m3; it is deleted in m5
- New `npm run test:transport`: 10 checks, including a real outbound poller
  against a real gateway over real HTTP with **no listening socket on the agent
  side at all** — the property the whole change exists for
- Agent protocol version 3


## iter11 — agent installation
### v0.10.2 — the install link could not actually be used
- **The panel did not know it was behind TLS.** `trust proxy` was never set, so
  `req.protocol` was always `http` regardless of how the browser reached the
  panel. The generated command therefore said `http://`, and curl followed the
  proxy's redirect to `https://`, where the certificate did not cover the
  hostname — `curl: (60)`, before the request ever reached us. The same blind
  spot made the "this panel is on plain HTTP" warning fire on a panel that was
  not. `TRUST_PROXY` (default 1 hop) now controls this
- **The panel URL is editable.** The address the browser used is only a guess
  at what a server can use: it may not resolve inside the fleet, and its
  certificate may not cover it. The operator sets it, and the installer is
  built from the stored value rather than from the request
- **The command can now be verified.** The dialog offers a two-step form that
  downloads the script, checks it against a SHA-256 published by the panel, and
  only then runs it as root. The digest travels through the browser rather than
  through the download, so a tampered script fails the check. The one-liner is
  still there, and is now labelled for what it is
- **Copy buttons never worked outside a secure context — in six places.**
  `navigator.clipboard?.writeText(...)` is a silent no-op when the API is
  absent, and every call site paired it with an unconditional "copied" toast,
  so the failure was not just silent, it lied. There is one helper now with an
  `execCommand` fallback that reports whether it actually worked, and the toast
  follows the result
- New `npm run audit:clipboard` refuses any direct `navigator.clipboard` use
  outside the helper and requires the helper to keep its fallback and its
  return value. Verified against the pattern it replaced
- Three checksum-stability checks: the same ticket must yield a byte-identical
  script, the script must depend on the operator's panel URL, and any change
  must change the digest


## iter11 — agent installation
### v0.10.1 — hotfix: v0.10.0 could not be built or deployed
- **v0.10.0 changed the api image so it built only from the repository root.**
  To serve the agent to a server being enrolled, `agentEnroll.js` read
  `../../../agent/nnm-agent.mjs`, which sits outside the backend directory, so
  the Dockerfile was rewritten around a wider context and the release workflow
  with it. Every other build path — `docker build ./backend`, any local script,
  any pipeline not edited in that commit — started failing on
  `COPY backend/package.json`. Nothing in the repo caught it: the code was
  correct, the tests passed, and the defect lived entirely in packaging
- Fixed by removing the need for the wider context. The agent is vendored at
  `backend/src/assets/nnm-agent.mjs`; `backend/Dockerfile` and the release
  workflow are byte-for-byte what they were in v0.9.1, and the root
  `.dockerignore` v0.10.0 added is gone
- Two gates so this class cannot return: one refuses an `AGENT_SRC` that
  reaches outside the build context, one asserts the vendored copy is
  byte-identical to `agent/nnm-agent.mjs`. Both verified against the real
  defect
- **Second defect, found while diagnosing:** the enrollment router mounted its
  authenticated half as a sub-router with `use(requireAuth)` at `/`. Mounted at
  `/api`, that put `requireAuth` — and an extra user lookup — in front of every
  request falling through to routers registered after it, and answered 401 for
  paths that belong to them. Each route now names its own middleware
- New mount-isolation check isolates that: it mounts the router at `/api`,
  registers two routers after it, and fails if either stops receiving requests


## iter11 — agent installation
### v0.10.0 (m1) — install by one-time ticket
- **Finding first:** `agentClient` only ever calls panel → agent. An install
  link fixes installation behind NAT and nothing else — once installed, the
  panel still has to open a connection to the agent. Real NAT support needs the
  agent to dial out, which is a transport change, not an installer. Scoped out
  and written up in `docs/iter11-agent-install.md`
- **Agents → Install agent** issues a ticket bound to one server: 32 random
  bytes, single-use, 30-minute expiry, stored only as a SHA-256
- The operator runs one command. The installer is plain POSIX sh, generated per
  ticket, and linked in the dialog so it can be read before it is run as root
- **The agent's token is generated on the server**, written to a mode-600 env
  file, and reported back. The panel never sends a credential to a machine and
  never holds an SSH key, so the two unauthenticated routes have nothing to
  leak
- The installer refuses without root / curl / Node 18+, never touches Nimble,
  keeps an existing token unless `NNM_FORCE=1`, installs a unit with
  `ProtectSystem=strict`, `NoNewPrivileges` and read-only logs, and verifies the
  agent on loopback before reporting success
- **Two directions reported separately:** enrollment proves the server reached
  the panel; `POST /servers/:id/agent/verify` proves the panel reached the
  agent. When the second fails on a private address the dialog explains that no
  installer can fix it
- Warns when the panel is on plain HTTP — the agent's token crosses the wire
  during enrollment — and when the panel's own address is private
- **Packaging defect fixed:** the api image copied only `backend/src`, so
  `agent/nnm-agent.mjs` was absent and the install route would have returned
  500 in production while working in the repo. The api build context is the
  repository root now, with a root `.dockerignore`
- New `npm run test:enroll`: 18 checks covering ticket properties, RFC1918
  classification (including the 172.16/12 boundary), POSIX validity, absence of
  any panel secret in the script, token never passed through argv, and shell
  metacharacters in operator input failing to break out of the quoting


## iter10 — Nimble log system
### v0.9.1 — version display and a home for server agents
- **The panel kept reporting v0.8.3 after two releases had shipped.** The
  number in the footer was a second copy of the one in package.json, kept in
  step by a comment reading "keep in sync with package.json". It wasn't. The
  backend never had this problem — it reads its own package.json — so only the
  UI drifted, which is why the features arrived and the number did not
- Fixed at the class level rather than the value: Vite now injects the version
  from package.json at build time, and there is exactly one source of truth
- New `npm run audit:version` refuses a hardcoded literal on the APP_VERSION
  line, checks both packages agree, and confirms the built bundle carries the
  current number with no placeholder left over. Verified against the real
  defect: restoring the old hardcoded line makes it exit 1
- **Server agents moved out of Playlists into their own section.** An agent is
  server infrastructure — a per-server token, config writes, media uploads,
  and since m1 the log source the collector tails — so living behind a button
  on the Playlists page was backwards. Deploying a playlist through an agent
  stayed on the Playlists page, since that genuinely is a playlist action
- The new page also reports whether an agent can serve logs at all, so an
  agent installed before m1, or one started with `NNM_AGENT_LOGS=0`, is
  visible as such instead of leaving the log collector mysteriously idle
- **Permission change:** the section is gated on `servers.manage` rather than
  `playlist.manage`. A custom role that managed agents purely through the
  playlist permission needs `servers.manage` added

### v0.9.0 (m1) — transport: agent reads logs, panel tails them
- Agent gains a third root, read-only: `GET /logs` and `GET /logs/read`. No
  write route exists, only `.log`/`.txt` are served, and the systemd unit adds
  `ReadOnlyPaths=/var/log/nimble` so a bug in the agent still cannot damage a
  log. Agent protocol version 2
- A read is always trimmed to a whole number of lines, because Nimble writes
  multi-line records and a range split mid-line would corrupt framing
- `ino` identifies the file generation; an offset past the end reports
  `truncated` instead of returning data from the middle of a fresh file
- Panel-side collector with a per-server, per-file cursor: rotation detected by
  inode change, in-place truncation by size below the cursor, and the bytes a
  rotation outran are counted in `bytesMissed` rather than quietly skipped
- Framing built from a real 184,481-line dump, not from documentation
  (Softvelum publishes no format spec). Verified against the whole file:
  163,628 records, 1,066 HTTP dumps totalling 20,853 lines absorbed into their
  parent record, zero orphans, and chunked reads at 64 KB and 1 MB produce
  results identical to parsing the file in one piece
- Records are ordered by byte offset, never by timestamp: the stamp has
  one-second resolution and the server emits 98 lines/s
- Subsystem tags are normalised (`srtpull0` → `srtpull`), collapsing 15 raw
  tags to 13 real subsystems
- Storage is a **capped** collection (`NNM_LOG_CAP_MB`, 512 MB default). The
  fleet produces ~14.3 GB/day, so m1 takes a hard disk bound rather than a
  retention job that could fall behind. Tiering is m2
- Ingestion is **off by default** and starts at the end of the file on first
  contact — m1 is a tail, not a historical import
- New `npm run test:logs`: 21 checks against verbatim lines from the dump.
  Agent suite grew by 12, covering traversal, extension confinement, line
  trimming, truncation reporting and the absence of any write path


## iter9 — playback links and fleet ordering
### v0.8.5 (m2) — playback links the panel works out for itself
- The Streams tab offered no links on an auto-synced fleet, because it read
  addresses off `playbackEndpoints` and nothing ever filled that in — `host`
  was set on sync, endpoints never were. On 13 synced servers the watch button
  simply never rendered
- Addresses are now resolved from data instead of typed in: hostnames come from
  the WMSPanel server record (operator-declared `custom_ips` first, detected
  `ip[]` after, IPv4 before IPv6), and the RTMP port from the server's real
  listening interfaces (`GET /server/{sid}/rtmp/interface`)
- The one number nothing reports is the HTTP port serving HLS/DASH/SLDP/
  Icecast/WHEP — it lives in nimble.conf. It is a per-server field, and when it
  is left blank the playback dialog says the port is Nimble's default rather
  than presenting 8081 as fact. Same for an RTMP port that had to be defaulted
- Hand-entered endpoints still win outright and cost no API call
- Full protocol set, matching what WMSPanel offers next to a stream: HLS,
  MPEG-DASH, SLDP, WebRTC WHEP, Icecast, RTMP — plus a copyable embed snippet.
  RTSP is deliberately absent: Softvelum's own examples use a port that depends
  on instance settings and no endpoint reports it, so it could only be guessed
- The native-plane Streams tab had no playback UI at all; it now has the same
  one, degrading to the panel's own server record when WMSPanel is unavailable
- Quota-aware: 2 upstream calls per server, cached 10 minutes, `?fresh=1` to
  re-read. A failure of either call degrades that half only
- New `npm run test:playback`: 18 backend checks, most of them asserting that a
  defaulted value is reported as defaulted. Frontend URL audit grew by 13

### v0.8.4 (m1) — server reordering actually reorders
- The move up/down buttons on the Servers page threw `move is not defined` on
  every click: v0.7.8 shipped the buttons, the i18n keys, the CSS and the
  `PUT /servers/order` endpoint, but not the handler
- Reordering is optimistic so the row follows the cursor, and reloads from the
  server if the write fails rather than showing an order that was never stored
- `audit:pages` now clicks every enabled button on every page and fails on any
  `is not defined` / `is not a function`. Rendering a page never exercised its
  handlers, which is why this shipped. Verified against the bug: with the
  handler removed the gate reports `4 unbound handler(s)` and exits 1
- The smoke fixture returned a single server, which left both reorder buttons
  disabled and invisible to that gate; it returns two now


### v0.8.3 (m4) — guarded scenario editing
- The Edit tab is now a guarded editor: decoder and encoder application/stream
  and existing filter parameters are editable — the two areas Softvelum
  documents as changeable. Codecs, encoders, forwarding flags and keyframe
  alignment are shown for reference only; the API refuses them unless a caller
  explicitly opts in, because offering an undocumented field as supported invites
  trusting a change that silently does nothing
- Nothing is applied blind: a diff lists every field with its before and after
  value, and the operator confirms it
- Each change is snapshot -> write -> read back -> verify, and the snapshot is
  restored if the API stored something else. A failure stops the batch rather
  than leaving a scenario half-applied, and the report says exactly which step
  stopped it and whether it was rolled back
- The write path is proven on the scenario itself before the first change, using
  the same no-op preflight the template wizard introduced — so this works
  whether or not the live verdict has come back yet
- 7 more backend checks pin the documented/undocumented classification

### v0.8.2 (m3) — transcoder fleet
- The transcoders page became a fleet console: every scenario across every
  server with its state, server, tags and a health column
- Health answers the question the state field cannot: are the encoder outputs
  actually carrying data? Derived from the panel's own metrics — flowing /
  partial / no output / paused. When the panel genuinely cannot know (metrics
  off, scenario shape not cached, server unmapped) it says "unknown" rather than
  dressing ignorance up as health
- Quota-aware by design: the transcoder list is one API call, but each scenario's
  pipelines are one call each, so scenario shape is cached and refreshed on
  demand. The button states the cost in API calls before it is pressed, and the
  result reports how many were spent
- Bulk pause/resume over selected scenarios, audited. Bulk restart is
  deliberately not offered: transcoders have no restart endpoint, so it would be
  pause + hold + resume — minutes of dead air en masse with no per-step trace.
  Functions already do that with stepping and rollback
- New backend test (`npm run test:fleet`): 8 checks over health classification,
  half of them asserting that unknowable cases stay "unknown"

### v0.8.1 (m2) — build a scenario from a template
- New "From template" wizard: clone an existing scenario, retarget each decoder
  and encoder to different app/stream, name it, and optionally push it to more
  servers via servers_to_apply. The copy is created paused
- The wizard proves the write path before using it. Element writes had never
  been exercised against the live API, so right after cloning it reads one
  element, writes it back unchanged, reads it again and compares — a no-op on a
  fresh paused copy. It distinguishes accepted / rejected / silently altered
  (drift) / element lost, and aborts before any real change if it is not clean
- Every step is reported (clone, verify, each retarget, apply, final read-back),
  so a run that stops halfway is inspectable instead of guessed at. A failed run
  deliberately leaves the paused clone in place rather than deleting the evidence
- Only elements the operator actually edited are sent; the preview lists exactly
  which streams will be retargeted and how many servers are affected
- The wizard states plainly that creating new pipelines is not possible through
  the API and stays in WMSPanel, instead of offering controls that cannot persist
- New backend test (`npm run test:template`): 8 checks over the preflight,
  including silent drift and a vanishing element

## iter8 — transcoders as an operator console
### v0.8.0 (m1) — scenario graph with live state
- New read-only scenario view: per pipeline, source -> processing -> encoders,
  video and audio separated, matching how the scenario is actually operated
- Live figures on the graph: measured bitrate on both the decoder input and each
  encoder output, taken from the panel's own collector and marked stale after a
  minute. This is the part WMSPanel's scenario view has no equivalent of; when
  collection is off or the server is unmapped the graph says so instead of
  showing an all-grey diagram that looks like an outage
- Encoder nodes also show the configured bitrate from the element's params next
  to the measured one, so drift is visible at a glance
- Honest about what the data does not contain: the API exposes no edges between
  elements, and after a split it does not say which filter belongs to which
  branch (a real scenario has three filters feeding two encoders). Those are
  grouped with an explicit note rather than distributed by guesswork
- Backend joins the account-level transcoder to a panel server via its WMSPanel
  server id so metrics can be matched at all
- The Pipelines dialog now has Scenario / Edit modes; the existing editor is
  untouched
- New `npm run audit:graph`: 17 checks against the shape captured from the real
  account dump, including the ambiguous split case and missing-field labels

### v0.7.8 — server ordering, remaining translations, filter dropdown fix
- Servers can be arranged in the operator's own order (move up/down on the
  Servers page); the order is stored per server and used everywhere the list is
  shown. Chose buttons over drag-and-drop: no dependency, works from the
  keyboard, and the boundary cases are obvious
- Transcoders "all servers" dropdown was collapsing to a sliver: its wrapper was
  a flex item with no width basis around a width:100% control, so it shrank to
  min-content and the portalled popup inherited that width. The wrapper now has
  a basis, and a dropdown never renders narrower than 180px regardless of its
  trigger
- Finished the translation pass where it had been missed: every "+ New …" button
  (interfaces, outputs, incoming, pull, applications, ABR, aliases, origin apps,
  functions, roles, users), the Functions steps hint, and all 24 Functions step
  presets — those were module-level constants with hardcoded (and partly mixed
  Russian/English) labels, so they now carry i18n keys with the English label as
  fallback

### v0.7.7 — missing SRT subjects, and charts that made sense of their data
- SRT In / SRT Out / SRT in Nimble never appeared in the charts because the
  collector only asked the srt_sender/receiver endpoints. In this panel those
  tabs are MPEG-TS objects, so their runtime lives in /manage/mpeg2ts_status,
  which was not polled at all. It is now sampled (incoming and outgoing), which
  is the bulk of what was "missing"
- Charts stopped being meaningless for RTMP Push:
  * identifiers (owner, dest_port, *_id) are numbers but not measurements —
    they are no longer chartable and are listed as such instead
  * cumulative totals (bytes_sent, retry_count, packet counters) are converted
    to per-second rates; drawn raw they climbed to ~10 Gb and flattened every
    other series to zero. A counter reset now produces a gap, not a cliff
  * each selected counter gets its own chart and Y axis, so a 0/1 connection
    state and a 10 Mbps line can be read side by side
- New `npm run audit:stats`: 17 checks over the classification and the rate
  conversion, including counter resets and missing samples
- Collector tests now also cover the MPEG-TS subjects (22 -> 25 checks)

### v0.7.6 — make metric collection explain itself
- Collection looked randomly partial because the collector swallowed failures:
  `Promise.allSettled` plus a `.catch(() => [])` per server meant "this box has
  no incoming SRT right now" and "the panel could not reach this box at all"
  produced exactly the same result — nothing
- Each endpoint now reports its outcome: ok (with a subject count), empty (with
  a plain-language reason, e.g. no live streams are being published) or error
  (with the message). A whole-server failure — normally an unreachable
  management address or a missing token — is recorded instead of vanishing
- New "Why is data missing?" panel on the Charts tab, opened automatically when
  a server has no subjects, showing the last run per endpoint
- Collector tests grew to 22 checks covering the ok / empty / error distinction
  and that an error message survives to the report
- Note on the WMSPanel alternative: its streams API is per-server and needs Deep
  stats, so at 13 servers the 15 000 calls/day budget allows roughly one sample
  every 2 minutes (5 minutes if half the budget is kept for interactive work) —
  against 10s on the native API. Diagnosing the native path first is the cheaper
  and far more useful route

### v0.7.5 (m5) — server agent: config files and media uploads
- New `agent/` component: a dependency-free (node:http + node:fs) service that
  runs on a Nimble box and is the only thing in the project allowed to touch its
  filesystem. It reads/writes files in the config directory, lists/uploads/
  deletes media, and reports health — nothing else. No shell, no arbitrary path
- Confinement is enforced, not assumed: a name must be a single filename, so
  `..`, nested paths, absolute paths and NUL bytes are refused; the resolved
  path is re-checked against the root afterwards. Token comparison is constant
  time and the agent refuses to start without a token of at least 24 chars
- Config writes are atomic (temp + rename) so Nimble never reads a half-written
  playlist, and the previous version is kept as `<name>.bak`. Uploads stream to
  a `.part` file, are capped by size and an extension allow-list, and leave
  nothing behind when refused
- Panel: per-server agent settings (URL + token, token encrypted at rest) with a
  health check, managed from Playlists → Server agents, and one-click deploy of
  a stored playlist into the server's config directory. Uploads stream straight
  through — the panel never buffers a media file; the global JSON body parser is
  bypassed for that route
- Agents are optional: servers without one keep working exactly as before
- `agent/README.md` ships an install recipe with a hardened systemd unit
  (ProtectSystem=strict, ReadWritePaths limited to the two directories) and is
  explicit that plain HTTP must not be exposed publicly
- 21 agent checks run against a real agent process: auth, five traversal
  attempts, atomic write, .bak generation, extension and size limits, and that a
  refused upload leaves no partial file

### v0.7.4 (m4) — metric collection and charts
- Collector samples every server every 10s (configurable) and keeps 3 days of
  history, enforced by a Mongo TTL index that is reconciled with the setting
- Sampling goes through the NATIVE Nimble API by design: WMSPanel allows 15 000
  calls/day per account and a 10s poll of a single server would spend 8 640 of
  them. The native API is local to each box and has no such budget
- RTMP is covered where WMSPanel leaves a gap: RTMP Push rules are sampled from
  /manage/rtmp/republish/stats (bandwidth plus connection state as a 0/1 series,
  so drops are visible on the chart), and live streams contribute per app/stream
  bandwidth
- SRT counters are harvested generically rather than from a hardcoded field
  list: the panel flattens whatever numeric fields the server reports, so RTT,
  loss and buffer counters appear under their real names and nothing silently
  goes missing when a Nimble build changes them
- Collection is off by default and per-group; interval, retention and current
  storage usage are shown in Settings, because this is real disk
- New Charts tab per server: subjects grouped by kind, counter picker, ranges up
  to the retention window, live refresh, and server-side bucketing so long
  ranges stay light. Chart is a hand-written SVG component — no chart library
- Tests: 16 collector checks covering flattening, per-group collection, readable
  RTMP Push labels, and that one dead endpoint does not lose the other samples

### v0.7.3 (m3) — playback links and an in-browser player
- Servers now carry a list of playback endpoints (label, host, HLS port, RTMP
  port, SSL). A box usually answers on its IP plus one or more domain names and
  each protocol may sit on its own port, so the operator picks the address —
  the panel never guesses it from the management address
- Streams tab: every live stream offers HLS and RTMP links for the chosen
  endpoint with copy buttons, and plays HLS right in the page. The endpoint can
  be switched inside the player dialog without leaving the tab
- The player uses native HLS on Safari and loads hls.js on demand elsewhere, so
  the library is not pulled into the initial bundle. RTMP is shown as a link
  with a note that browsers cannot play it — it is meant for VLC/OBS
- Playback failures surface the hls.js error plus a hint to check reachability
  of the chosen address, instead of an empty black frame
- Tests: 8 URL-construction checks (default ports, custom ports, HTTPS, missing
  endpoint) and a smoke assertion that the watch action appears once endpoints
  are configured

### v0.7.2 (m2) — cross-server categories
- New Categories page: group streams of any protocol from any server and drive
  them together. Membership is label-style — an object can belong to several
  categories (folders are the special case of using one), which is the cheaper
  direction to change later
- Live state per member, batched per (server, kind) so a category costs a few
  API calls rather than one per stream; members whose object disappeared or
  whose server lost its WMSPanel mapping are shown as such instead of silently
  looking healthy
- Bulk start/stop/restart over the whole category or a selection, reusing the
  per-kind action rules exported from the Functions engine so the two cannot
  drift apart. Restart is offered only where the API has an endpoint; kinds that
  need the composite stop/hold/start are refused here and pointed at Functions,
  where the run is traceable and reversible
- Backend: Category model, CRUD, membership replace, /state and /action, all
  audited; new category.view / category.manage permissions (admins unaffected)
- Page added to the render smoke; EN/RU

## iter7 — new epic (in progress)
### v0.7.1 (m1) — composite restart for kinds the API can't restart
- SRT Out, SRT In and Hot swap now support restart too: the panel performs it
  as stop -> hold -> start, since WMSPanel exposes no restart endpoint for them
- The hold is the point, not padding: WMSPanel delivers changes to Nimble on a
  ~30s sync cycle, so a stop immediately followed by a start would be batched
  into a no-op and the stream would never go down. Default hold is 40s and is
  editable per step; the UI explains why when the field appears
- Restart on an already stopped object is refused with a clear message instead
  of silently turning into a start
- Rollback covers a composite that failed between stop and start — the object
  is put back to its pre-run state rather than left stopped
- Regression test grew to 17 checks, including stop/start ordering, the refusal
  case and composite rollback (dwell forced to 0 so tests stay fast)

### v0.7.0 (m1) — Functions: start/stop/restart for more object kinds
- Actions are now declared per object kind (ACTION_OPS) instead of the action
  branch being hardcoded to MPEGTS outgoing. Added: RTMP Push (republish)
  start/stop/restart, RTMP Pull start/stop (restart already worked), SRT Out
  and Hot swap start/stop, SRT In start/stop; SRT In also became a patchable
  kind. Transcoder pause/resume unchanged
- Start/stop is expressed the way each API actually supports it: a dedicated
  endpoint for MPEGTS outgoing, PUT { paused } for the rest; restart only where
  the API has an endpoint for it
- FIXED a latent defect: an action step with any other objectKind silently fell
  through to the outgoing endpoint, i.e. it would have called the wrong URL with
  a foreign object id. Unsupported combinations (e.g. udp restart) now fail with
  a clear message instead
- Backward compatibility is explicit: steps saved before this change carry no
  objectKind and always meant outgoing — that default is preserved, including
  for rollback snapshots that have no kind recorded
- New regression test (`npm run test:functions` in backend): 13 checks over the
  real runner with a stateful fake of the WMSPanel API, covering legacy steps,
  every new kind, rollback inversion and the rejection of unsupported actions
- UI: action kind picker lists what each kind supports, an explicit action
  selector, and presets for RTMP Push/Pull, SRT Out and SRT In (EN/RU)

### v0.6.14 — fix Russian strings silently overridden by English duplicates
- Playlists rendered in English under the Russian locale. Root cause was wider
  than one page: an English block had been pasted a second time INSIDE the ru
  dictionary, and since a JS object literal keeps the LAST value for a repeated
  key, 113 Russian strings were silently overwritten (Playlists, the SRT helper
  and the transcoder pipeline editor among them). Removed the 70 duplicated
  lines; verified every key in them already had a Russian value earlier, so
  nothing was lost
- Verified by rendering the page under lang=ru: only legitimate latin text is
  left (Nimble Playout, JSON, SyncInterval)
- `npm run audit:i18n` now fails on duplicate keys within a dictionary — the
  exact defect above produced no error before — and reports keys whose EN and
  RU text is identical (likely untranslated). Validated by reintroducing a
  duplicate. Translated one leftover it found (sd.userAgent); Icecast field
  names and "Control plane:" stay as product terms

### v0.6.13 — fix blank screen when editing a Function
- StepEditor called t() without binding useI18n (missed in the v0.6.11
  translation pass), so opening a function for editing threw and blanked the
  page. Bound it
- Why the audit missed it: the "t is bound as a parameter" rule was matched
  against the whole component body, so any inner `.map(t => …)` counted as a
  binding — the opposite of the truth. Parameter binding is now only accepted
  from the component signature; the rule now flags exactly this case and
  nothing else across the tree
- The page smoke only covered first paint, so crashes inside modals/editors
  survived it. It now also opens a function for editing and asserts the
  builder and its step editor render. Both gates were verified against the
  reintroduced bug

## iter6 follow-up
### v0.6.12 — fix blank screen on Servers (and other pages)
- Root cause: ServersPage binds `const t = testResults[s.id]` inside the server
  row map, shadowing the i18n `t`. The v0.6.11 translation pass put
  {t('action.edit')} into that block, so the test-result object was invoked as
  a function -> the whole page threw. Renamed the local to `tr`
- The tab-level render smoke never mounted top-level pages, so it passed while
  Servers crashed. Added `npm run audit:pages`: mounts all 13 pages with
  providers, router and sample data, and fails on a crash or an empty render
- The shadowed-`t` static check added in v0.6.11 was ineffective (it only
  matched `.map(t =>`, and an earlier version was never actually installed).
  Rewrote it to scan the block owning any `const/let/var t = <value>`
  declaration; verified both ways — clean on the current tree, and it flags
  the exact ServersPage regression when reintroduced

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
