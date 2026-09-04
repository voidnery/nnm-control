# The failures this project makes

Short on purpose. Every entry cost a release, an outage, or a day, and every
one of them recurred after being written down somewhere else. This file exists
so the next session reads them before writing anything.

They are sorted by how often they came back, not by how bad each one was.

---

## 1. A value used against a shape it does not have

**Five instances, all silent.** `undefined` is a value; code carries on with it
and nothing throws.

| where | what happened |
|---|---|
| `agent` read from `/servers` | the field is not on that object |
| `gateway` from the networks list | same |
| `host` from a network node | same |
| `server.agent.privileged` | **no schema has this field.** Every machine read as "helper never reported"; installing one by hand changed nothing the panel could see. The correct rule was already written one file away, in `routes/servers.js` |
| `probeTls({ host, port })` | the function is `probeTls(host, port)`. The whole object went into `options.host`, so **every HTTP/2 probe threw before opening a socket** — on every machine, for four versions, while the screen showed first `?` and then `✗` |

Each was written from the shape of a neighbouring call rather than from the
thing being called.

**Open the signature, not the call site next to it.**

---

## 2. Something succeeded and did nothing

- `postinst` printed two warnings and then "NNM Control installed" with a setup
  token, exited 0, while the panel was down. **Fifty-five minutes of production
  outage**, and apt reported success.
- A caught exception rendered as absence: a missing button, "could not
  compact", a size of `?`, metrics reading zero.
- A helper installed and never reported, because nothing read the record it
  writes.

**An operation that leaves the system broken must fail loudly, not report and
move on.**

---

## 3. Measuring something other than the thing in question

- `llhls-check` asked for `_HLS_msn = MEDIA-SEQUENCE + segment count`, part 0.
  With parts, that segment is already in progress and part 0 usually exists, so
  a correct server answers instantly. **Two runs against one server gave
  opposite verdicts**, and the container question was blamed. Fixed by
  following `PRELOAD-HINT`, which is the server naming the part that does not
  exist yet.
- The same tool then took the longest segment for the configured chunk. On this
  fleet's output that is exactly two keyframe intervals, so it declared a
  perfect fit about a stream whose segments were visibly wandering.
- "The image is not published in GHCR" — concluded from its absence on disk.
  The pull had been killed mid-download by a start timeout.
- "The WMSPanel API has no live-applications family" — concluded from fifteen
  spellings that did not include `app`, the singular. **The route was already
  in this codebase**, with a comment naming it.

**Ask the thing you mean to ask, and check that the probe can distinguish the
two answers.**

---

## 4. Work measured in minutes inside a held-open HTTP request

**Four times.** The last one returned `504` from the proxy while the work
carried on underneath and vanished from the screen. The gateway preparation had
already solved it with a job store, one file away, and the new route did not
use it.

**Start a job, return an id, let the browser follow it.**

---

## 5. Checks that cannot fail

Seven found, and only by running diversions.

- Three sat after `process.exit` in a test file and never ran. Two diversions
  aimed at them changed nothing, which read as "the checks hold".
- One diversion was a syntax error, which proves nothing.
- One `str_replace` did not match the string it meant to patch, so the file was
  unchanged and the run looked like a pass.
- A masking check ran without `--full`, so the data it was checking was never
  printed.
- Fixture sets that exercised only one branch: every fixture carried both an
  `EXT-X-MAP` **and** an `.fmp4` extension, so dropping either detection
  changed no answer.
- Twice a diversion changed no test because the tests covered the logic and not
  the wiring.

**Run the diversion always. When it changes nothing, suspect the diversion
first.**

---

## 6. A check that fires on correct code

Seven times, five of them the same shape: the pattern matched a **comment**
explaining the very rule — a file that documents "do not call
`navigator.clipboard` directly" was reported as calling it.

Others: a gate hard-coded to one script's flag name; a gate that required the
string `250` and so would have preserved a wrong figure; a test whose "expires
soon" case used the real clock and a one-day certificate, so it passed for
exactly twenty-four hours after the fixtures were generated.

**Narrow the check to what it is about. Strip comments before matching. Never
reword the code to appease a check.**

---

## 7. Concluding from data that describes another moment

The claim "enabling LL-HLS switches the container by itself" was built on
protocols read from the details window **before** the write and applied to the
state after it — and the operator had ticked the container switch in the same
action, so **two things changed at once** and a conclusion was drawn anyway.
Withdrawn the same day; the opposite turned out to be true.

**After a write, read it back. Change one thing at a time.**

---

## 8. One rule, two consumers, two different strings

Newest, and the most expensive so far: **23.8 GB of a 96 GB disk, twice**.

`MACHINE_ROUTES` was shared deliberately, with a comment saying the skip and
the sweep "cannot drift into two different answers". They did not drift on the
list. They drifted on **what the list was applied to**: the middleware matched
a URL carrying `/api`, the filter matched a stored `action` that does not. The
sweep worked; the skip had never fired once since it was written.

The same fault a second time in the same file, found by two counters agreeing
to the unit: `auth:login` 39, `POST auth/login` 39.

**Sharing a value is not sharing a decision. Derive the string once and use
that.**


---

## 9. A route the panel declares and no button calls

**Five instances before anything checked for it**, each a feature the operator
could not reach:

| route | what was missing |
|---|---|
| `/server/{s}/live/app` | full CRUD in `wmspanelClient.js`, with a comment naming the path, while an investigation concluded the API had no live-applications family |
| `/llhls/channels/:id/plan` and `/apply` | the channel half of LL-HLS, written, never wired |
| `/cdn/networks/:id/applications` | the declaration this milestone is about |
| `/agent-fleet/recheck`, `/servers/:id/readiness`, `/auth/me/2fa/backup-codes`, the transfer list and retry, `PUT .../agent/config` | found by the check once it existed |

Nothing caught these: unit tests import the service, the render smoke test
mocks `fetch`, and a route with no caller is valid JavaScript that passes
everything. The forward check — does a button reach a route — had been in
`route-audit.mjs` for months; the reverse was never asked.

**Both directions, or the wiring is only half checked.**

And the check itself failed twice before it worked, both times found by a
diversion that passed: it ignored the HTTP method, so a `GET` vouched for a
`PUT` on the same path; and it reused the forward direction's loose matching,
so a shallow call vouched for every deeper route beneath it.


---

## What actually worked

Worth recording too, because it is the only part that consistently did:

- **Tools that measure instead of arguing.** Every question settled in this
  branch was settled by a script against the real system, and every question
  answered by reasoning was answered wrong at least once.
- **Gates proven by contradiction.** They caught real regressions repeatedly —
  and the diversions caught the gates themselves.
- **Writing the source of every number beside it.** `llhls.js` says which
  figures are measured, which are quoted, and which are derived, and that is
  why the stale `250` in the vendor's own reference never made it into the
  code twice.
