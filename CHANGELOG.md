# Changelog

### v1.10.0 — asking the edge as well as asking about it
The agents were there all along. A note in `docs/STATE.md` said several edges
had none, it stopped being true without the line changing, and I repeated it as
fact for several sessions — including in a list of what to build next. It is
corrected and dated now, because a claim about the fleet goes stale exactly
like any other reading from a machine.

So the edges can be asked directly, and agent v29 does two things over loopback
that no external check can:

**It reads the playlist where nothing can intervene.** A failure seen from the
panel could be Nimble, the machine's firewall, the route between, or the
panel's own network. Loopback crosses none of those, so the pair separates "not
serving" from "not reachable" — and those are different repairs. A combination
that cannot happen, the panel served and the machine not, is reported as the
checks disagreeing rather than as a verdict about the machine.

**It reads the playlist twice.** 200 on a frozen playlist is the most
convincing wrong answer this check could give: the file exists, the request
succeeds, the stream is dead.

**And it reads the cache from the management API on 127.0.0.1** — no WMSPanel
mapping to be right about, no sync to be stale. The figure is amplification,
bytes out over bytes in, because Nimble exposes no hit counters at all. An idle
edge measures nothing and is healthy, which the panel says rather than calling
it a cache failure.

Fifteen checks, four proven by contradiction — including the two that matter
most: an idle edge declared broken, and a playlist that has stopped moving
declared fine.

### v1.9.8 — 10.5 million rows gone, and the disk did not notice
The sweep worked. The compaction did not, and the size came back as "? MB" —
both for the same reason, and neither said what it was.

**`Model.db` is a Mongoose Connection and has no `.command()`.** Every call went
straight to a TypeError that a `catch` turned into "could not compact" and a
null size. Commands now go through `db.getClient().db(name)`, and the size is
read with the `$collStats` aggregation — the supported route in MongoDB 7,
needing no admin rights.

**The check found the same fault in a second file.** `stats.js` has been
reporting zero storage for the metrics collection for as long as Mongoose 8 has
been installed, with the TypeError tucked into a field nobody reads. Fixed
there too — that is what a check binding to the installed driver is for, rather
than to the file I happened to be editing.

Its own first version flagged the comment explaining the fault as if it were
the fault. Comments are stripped now: a check that fires on the documentation
written to prevent something is a check that gets switched off.

**And the sweep moved into a window of its own**, behind a button in the top
right. It is occasional and irreversible, and inline it pushed the log — what
the page is actually for — down the screen for everybody who never sweeps.

### v1.9.7 — HTTP 504 where a number belonged
The error message worked: instead of an absent button with no explanation, the
page said 504. That is what it was added for, one release ago.

The 504 was mine. `countDocuments` with a regular expression walks the
collection — 8.6 million documents, minutes of work — and whatever proxies the
panel gave up long before it finished. **Third time this shape has cost a
release**, after the gateway apply and the initial audit query: work measured
in minutes does not belong in a held-open request.

- **The count is an estimate.** The total is metadata and free; the machine
  share is sampled from the newest few thousand rows and scaled. The page says
  it is approximate, because a number shown to somebody about to delete
  millions of rows should not pretend to a precision it does not have.
- **The sweep is a job.** Deleting the rows and compacting the file takes
  minutes too. It answers 202 and the page polls, showing the output — including
  the line about compaction holding a lock, since a page that looks frozen is
  one somebody reloads during a delete.
- **Confirmation compares magnitudes**, not exact figures: it exists so nobody
  agrees to sweep ten times what they were shown, and an estimate serves that.

### v1.9.6 — the sweep button was absent, and said nothing about why
`collection.stats()` was removed from the driver Mongoose 8 carries. The count
endpoint called it, threw, and the panel's `catch` turned that into
`setSweep(null)` — so the button simply was not there, indistinguishable from
"nothing to sweep". Finding out took reading the code.

Two fixes, and the second matters more:

- the size comes from a `collStats` command, isolated so that a number the
  panel cannot read is a null rather than a failed request;
- **the failure is shown.** Catching an error and rendering nothing is how a
  feature disappears without a trace, and it is the same conflation this
  project keeps refusing everywhere else.

A check now walks the backend and refuses any `collection.<method>()` the
installed driver does not actually provide — tested against the driver rather
than a list of names, so it stays true across upgrades. It first confirms those
methods really are gone, since a check whose subject no longer exists passes by
being empty.

### v1.9.5 — sweeping the audit log from the panel
Machine polling was audited until v0.99.20 and left 8.6 million rows behind —
50 GB on the disk the panel runs on, which it twice filled. The source is
closed; the history is not, and the TTL takes thirty days to reach it.

The audit page now offers to remove it, and every part of that is a safeguard:

- **The count comes first**, with what survives named beside it. Deleting
  millions of rows from a log people rely on is not something to learn the size
  of afterwards.
- **The operator confirms the number they were shown.** Agreeing to "delete
  8,598,036 rows" is a different act from clicking a button that happened to be
  under the cursor, and a count that moved meanwhile is refused rather than
  applied.
- **The filter is built from the same list the middleware skips**, so "what we
  no longer record" and "what may be removed" cannot drift into two answers.
- **Sweeping is its own permission.** Reading an audit trail and deleting part
  of it are different rights.
- **It compacts**, because deleting rows returns no disk — and says so, along
  with the lock that takes.

**And the CI change I proposed is not needed.** I said the release tag is
created before publishing and that a failed run leaves it behind. The workflow
tags in its final step, after the apt repository is published, with a comment
saying exactly why. Nothing else creates tags. So the dead `v1.0.0` and
`v1.8.7` are still unexplained, and `docs/STATE.md` now says that rather than
carrying my wrong model.

Two of this release's own checks passed against `if (false)`: they matched the
error strings, which stay in the file when the branch becomes unreachable.
Bound to the conditions.

### v1.9.4 — the redirect pointed at https on a plain-HTTP port

    location: https://200.165.225.191:8081/test2/test_stream/playlist.m3u8

`$scheme` inherits how the viewer arrived. A viewer on https was therefore sent
to `https://<edge>:8081` — and 8081 speaks plain HTTP, so the connection died
at the handshake and the player said only that it could not open the source.

**A redirect is an address somebody else will dial**, so every part of it has to
be true of the machine at the other end. The scheme now comes from that edge:
https when the panel's own TLS probe got a handshake, http otherwise, with a
non-standard TLS port named and 443 left off.

**And it comes from the handshake, not from a port being filled in.**
`httpsPort` is where the operator says TLS would be; `tls.tls` is whether the
panel found any. Trusting the first alone sends viewers to a port nothing
listens on.

Proxy mode hid this class of fault completely — it dials the edge itself, over
HTTP, so how the viewer arrived never mattered. Recorded in `docs/STATE.md`,
because the next thing that hands out an address will have the same problem.

### v1.9.3 — the redirect config had never been valid

    return 302 $scheme://$nnm_edge$request_uri;

`$nnm_edge` was read once and defined nowhere. nginx refuses a configuration
that reads an unknown variable, so redirect mode could never have loaded — and
nobody found out, because until yesterday nothing ever applied it. The resync
learned to write redirect, and `nginx -t` refused it one step before the reload.

Which is the system working: the machine stayed on the proxy config it was
already serving rather than going down. The edge address is written in now,
exactly as proxy mode does it, and a check refuses any variable the file reads
without defining — nginx's own are known, anything invented here must be
declared here.

**And a failure names its reason.** The panel said "test-conf" — which step
refused, and nothing about why, while nginx had put the reason in the message
that was being discarded. It shows the output first and the step second.

### v1.9.2 — redirect mode was proxy mode wearing its name
Selecting redirect kept the stream working, which is why nobody questioned it.
The machine was serving proxy.

    /etc/nginx/sites-enabled/nnm-cdn-test-1.bbesport.com.conf
        proxy_pass http://$edge;        ← with "redirect" selected in the panel

Two faults, both mine, in the resync I wrote yesterday:

- **The mode was hard-coded to `proxy`.** Whatever the operator chose, a proxy
  config was written.
- **Redirect was refused outright**, on the reasoning — written in that file, by
  me — that a redirect config names no edges and so cannot go stale. It names
  them in the map it redirects into, and refusing to resync meant switching the
  mode left the machine serving the previous one.

**A player follows a 302 without saying so**, so the two modes look identical on
screen. `curl -sI` on the viewer URL is the only honest check: 200 and a
playlist is proxy, 302 with a `Location` is redirect. Recorded in
`docs/STATE.md`, because "the stream plays" answered the wrong question for a
day.

The plan itself was right the whole time — it produces `return 302` for
redirect and `proxy_pass` for proxy. Only the resync, standing between the
operator's choice and the machine, replaced one with the other.

### v1.9.1 — same release, a version the tags do not block
`v1.8.7` was tagged and never published: the workflow tags before it builds, so
a run that stopped after the tag left it behind, and every run since read it as
"already released" and skipped everything in thirteen seconds under a green
tick. Same for `v1.0.0`.

The contents are v1.8.7's, unchanged. The number moves because deleting a tag
is not available here, and a version nothing has claimed is the cheapest way
past it.

`docs/STATE.md` now records the trap: a release finishing in seconds instead of
minutes did not run, dead tags do not mean published versions, and
`apt-cache policy nnm-control` is the authority on what exists. Tagging after
publishing is the actual fix and is still not made.

### v1.8.7 — "edge in the config — 0"
The rewrite worked, reported success, and wrote a proxy configuration
forwarding to nothing. The number was in the message the whole time.

**A network node holds a reference to a machine and nothing else** — no host,
no port, no name. `resyncGateway` read `n.host` off the node, got undefined for
every edge, and its own filter dropped them all. The panel then said "edge in
the config — 0", which was true, cheerful, and exactly the state the resync
exists to prevent.

Addresses are resolved from the machines now, in the same order the delivery
page uses — the Host field the operator typed, then a playback endpoint, then a
name from WMSPanel — so one machine does not resolve to two different addresses
depending on which page asked.

**And a rewrite with no usable address is refused rather than written.** A
proxy config that forwards nowhere looks configured and serves nothing, which
is worse than not writing it. The panel names the edges whose address it could
not find and points at the Host field.

Third time this shape has cost a release: reading a field off an object that
does not carry it. The checks now bind to where the value actually lives.

### v1.8.6 — continuing above the stray package
There is a `1.8.5` in the apt pool, published before this scheme and not
removable from a repository people have already added. Every release since has
carried a Debian epoch so that `1:0.x` outranks it.

That worked and it hid something: **1.0.0 sits below 1.8.5.** Numbering the last
release 1.0.0 put it in the range the epoch had been quietly covering — safe
only for as long as nobody decides the epoch is noise now that the versions
look like 1.x.

So the numbering continues from 1.8.6, which is above the stray package on its
own merits. There is no 1.1 through 1.8 and nothing was skipped; the epoch stays
as a second line rather than the only one. The reasoning is in `docs/STATE.md`
so the next person meets it before the pool does.

### v1.0.0 — the panel configures the machines it configured
The previous release detected that an edge-proxy's nginx did not know about the
network's edges, said so clearly, and asked the operator to go and press a
button on another page. That was wrong, and the objection was right: a fact the
panel holds, a change only the panel can make, and a person sent to do it by
hand.

**Changing a network now rewrites the edge-proxy that serves it.** Adding an
edge, removing one, or saving the gateway settings brings the machine into step
in the same request, and the answer arrives with the save.

**It needs no credentials.** The offer to store SSH passwords was not necessary:
the privileged helper installed nginx on that machine and issued its
certificate, so rewriting a file it owns and reloading a service it manages is
less than it has already done. No new secret buys no new capability.

The steps come from the same plan that prepares a machine, filtered to
`write-conf`, `enable-site`, `test-conf`, `reload` — one description of what an
edge-proxy's nginx looks like, not two that can drift. It installs nothing,
touches only machines already prepared (adding an edge must not quietly turn an
untouched machine into a gateway), leaves redirect gateways alone (their config
names no edges — the arbiter reads the network live), and an unreachable
machine is reported rather than failing the operator's edit.

Called it 1.0.0: a delivery network can now be built, and the machines carrying
it stay correct without anybody remembering to make them so.

### v0.99.26 — the form was empty because the field was never sent
The gateway settings still did not survive a reload. I had fixed the form
twice — once with `useEffect`, once with a key — before checking whether the
value ever arrived.

**The networks list never sent `gateway` at all.** The panel initialises from
`network.gateway`, so the form was empty whatever had been saved. Second time
in two days, after `/servers` and `agent`: a field nobody sends looks exactly
like a field nobody set, and the screen cannot tell them apart either. `node`
is stringified too, since an ObjectId never equals the option value a select
renders.

**And a proxy gateway prepared before its network had edges forwards viewers
nowhere.** The nginx config is written once, during preparation — and a machine
is prepared *before* it joins a network, so it points at `edge.invalid`. Saving
the network changes the panel's model and nothing on the machine.

The panel now says so, naming the machine and the edges it does not know about,
and points at "Configure again". It does **not** rewrite nginx from a settings
save: that would be a config change nobody asked for at a moment nobody expects
it, and the preparation flow shows its plan before running.

**Each machine gets its own address selector.** The previous one rendered above
the label it belonged to, so it read as belonging to the edge before it — a
control next to the wrong name is worse than no control. It now sits beside its
own link.

One check greped the whole file for `staleConfig` and passed when the value was
computed and not sent. Bound to the response.

### v0.99.25 — the panel was handing out a name nobody had corrected
Two edges changed address, their DNS had not caught up, and the stream stopped.
The operator had already fixed the Host field on both servers — and the panel
never looked at it.

`publicHost` was `playbackEndpoints[0] || wmspanelDomains[0]`, with the Host
field nowhere in the chain. **WMSPanel's domains are a fact about WMSPanel; the
Host field is a person saying where the machine is**, and between the two the
person wins. The order is fixed and a check binds it.

**Every address a machine answers on is now offered.** One name was baked into
each test link, so when its DNS was stale there was nothing to switch to —
though the machine answered on its address the whole time. The panel cannot
know which name resolves correctly today; the operator can. The choice is not
remembered, because tomorrow the stale name may be the working one.

**The gateway form was displaying a stale copy.** `useState` runs once: the
parent reloaded after a save and passed the new network down, but the component
was already mounted, so it kept showing what had been typed and reopening the
page showed something else again. Saved correctly, displayed wrongly — which is
the shape that makes people save twice.

**And choosing a prepared machine fills in the domain it was prepared with**,
rather than leaving it to be retyped from another page.

### v0.99.24 — the machine list was empty on every fleet
"Choose a server with an agent" offered nothing, on a fleet with seven agents
and a gateway prepared and proved that morning.

The dropdown filters on `s.agent?.enabled`. **`/servers` never sent `agent` at
all** — not `enabled`, not `hasAgent`, nothing. So it was empty everywhere and
always had been: a field nobody sends is indistinguishable from a fleet with no
agents, and the screen had no way to tell them apart either.

A check now binds the two files together, reading every `s.<field>` the panel
touches and requiring the response builder to send it. Its own first version
searched the whole file and reported `name` as missing while it was plainly
there — a check finding a fault in correct code, which is how checks get
switched off.

**And the two kinds of machine are now named and listed apart.** A machine that
carries delivery without Nimble is an **edge-proxy**: it terminates TLS on one
name and hands viewers on. A Nimble edge serves video from those same ports and
is a different thing. They appear under separate headings wherever a machine is
chosen, because one list invites putting a gateway on a media server without
noticing — and an edge-proxy shows the domain it already serves.

An empty list now says why it is empty.

### v0.99.23 — a halted run left a configuration the next run tripped over
`reload-for-acme` failed with "Job for nginx.service failed", and the config it
choked on was not one this run had written. The previous run halted at
`nginx -t` over `http2 on;` — which is *after* `enable-site`, so the broken
production config was left written and enabled. Every subsequent run then
failed at its first reload, pointing at a file it had not touched.

**A run now unlinks any previous configuration for this domain before the ACME
phase**, since it is about to write a new one anyway. Unlinked rather than
deleted: the file stays in sites-available for anyone who wants to see what
failed, and the undo puts the link back.

**And every reload is preceded by a test.** There was one before the final
reload and none before the first, so the first failed as "Job for
nginx.service failed" with the reason in the journal — on a machine nobody is
sitting at. nginx says what is wrong when you ask it and not when you reload
it, which is the same lesson as `nginx -t` being in the plan at all.

A check enforces the rule generally: any step whose id contains `reload` must
have `nginx -t` between it and the previous reload. Both proven by
contradiction.

### v0.99.22 — nine steps, a certificate, and one directive too new

    unknown directive "http2" in nnm-cdn-test-1.bbesport.com.conf:26

Nine of ten steps passed and the certificate was issued. `nginx -t` refused the
configuration one step before a reload would have taken the machine off the
air — which is why that step is in the plan and why it halts everything after
it.

`http2 on;` on its own line is nginx 1.25.1 and later. Ubuntu 24.04 ships 1.24.
The `listen 443 ssl http2;` form works on both — newer nginx warns that it is
deprecated and accepts it, and a warning on a working server beats an error on
half the machines this runs on. The plan cannot read the version before nginx
is installed, so the compatible spelling is the only one that is right
everywhere.

**And the backtick gate had a list of three filenames.** `gatewayPlan.js` was
not among them, so a backtick in one of its comments closed the template for
the fourth time. It now finds config-bearing modules by looking for template
literals containing `#`-commented lines, rather than by naming files.

Its own first two attempts are worth recording: one filtered the router walk
and found zero modules, then said it had lost its subject — which was the one
thing it got right. The next flagged seventeen backticks in ordinary
JavaScript comments, where they are harmless. It now tracks whether a line is
inside a template literal, and fires only there.

### v0.99.21 — the log cap stopped the panel from starting

    validating docker-compose.yml: volumes.geoip_db additional properties
    'logging' not allowed

The script that added `max-size` to every service matched two-space
indentation, which is also how volume names are written. So `logging` landed on
`geoip_db`, `mongo_data` and `media_spool` — and compose validates its schema,
so it refused the whole file. The package installed, the images published, and
the panel could not start at all.

I checked the result with a YAML parser. It was valid YAML and invalid compose,
and the difference is the entire fault.

**That is the lesson from the day before, unapplied.** `test:shell` exists
because generated code has to be run through the thing that will run it, and
reading it is not that. One day later I generated a compose file and validated
it with something else.

`test:retention` now refuses service-only keys — `logging`, `image`, `ports`,
`depends_on` and the rest — anywhere in `volumes`, `networks`, `configs` or
`secrets`. Docker is not available in the test environment, so the check
asserts the schema rule directly rather than pretending to be compose.

### v0.99.20 — the panel filled its own disk
96 GB full, three projects down, a Redis journal truncated mid-write. The panel
did this to the machine it runs on, and the cause was four limits that all
existed and none of which held.

    auditlogs    50 GB    8,598,050 rows
      POST agent-gw/logs      101,819
      POST agent-gw/poll       45,286
      streamtag:set                14   ← a person

**Every agent poll was being audited.** The rule was "record every mutating
request", which is right for people and wrong for machines: agents post their
logs, tasks and metrics continuously, and each was a row. Fourteen entries in
the last two hundred thousand were somebody deciding something. Audit answers
"who did what", and a polling loop is not a who.

Machine-facing routes are excluded by prefix — a short list, so that a new
operator action is audited by default rather than by somebody remembering. And
the window drops from ninety days to thirty: ninety was chosen when this held
operator actions alone.

**Backups counted files while the database grew thirtyfold.** 228 MB on the
2nd, 7 GB on the 14th; fourteen of those is 98 GB on a 96 GB disk. The count
was never the binding constraint. There is a size cap now, the dump refuses
when the free space is under twice the last archive rather than writing until
the disk ends, and a failed dump deletes its partial file — which is worse than
no backup, because it would be restored.

**Container logs had no ceiling**: 4 GB. Both compose files cap them.

`test:retention` checks all of it, and one of its own checks needed the same
lesson: requiring `NNM_BACKUP_MAX_GB` to exist passed against a cap of 999999.
A limit that does not bind is a variable. It asserts the default is a number
that fits on a disk.

### v0.99.19 — the domain was checked before anything served it
    Connection refused
    nginx: inactive
    /etc/nginx/sites-enabled/: No such file or directory

The precheck sat ahead of every step, so on a clean machine it asked a domain
that nothing was serving yet. "Connection refused" was a correct answer to a
question asked too early — and it only ever passed on machines where an earlier
attempt had left nginx behind, which is why it looked right for days.

The steps are split at the certificate now. Everything before it puts a web
server on the machine that answers this domain; the check runs between the two,
where the question means something; the certificate follows.

**A stop there does not undo what worked.** nginx is installed and serving the
challenge, so fixing a DNS record and running again resumes from that point
rather than starting from nothing — and the job says so, because otherwise the
sensible assumption is that a failure left the machine as it was found.

Each fault keeps its own sentence: the name does not resolve; it points
somewhere else, with both addresses; nginx cannot enter a named directory; it
answered here but not from the panel. And a helper too old to run the check at
all is announced **before** the steps, while there is still time to update it —
a fact about the fleet, not about the domain.

`audit:undef` earned its keep during this edit: moving the block left three
references to a variable that no longer existed, and it named all three with
line numbers.

### v0.99.18 — the helper script did not parse

    /tmp/helper.sh: 140: Syntax error: ")" unexpected

Two edits to the same subshell each added a closing bracket. `sh` refused the
whole file, so nothing in it ran — not the unit, not the echo that would have
named the problem, not the journal dump added specifically to explain failures.
The install log showed the block starting and then silence, which is why every
diagnosis pointed somewhere else.

Every other fault in this feature was a disagreement between two places and
could not be seen from either side alone. This one was one file, wrong by
itself, checkable in one command — and I read the code instead, eight times,
including the two edits that broke it.

**`test:shell` runs `sh -n` over every generated script**: the helper
installer, the agent installer in both variants, the uninstaller. The gateway
variant is the only one that embeds the helper, so a check that tried a single
script would have passed. POSIX `sh` rather than bash, since the target is
Ubuntu's dash and a construct bash forgives is one dash refuses on a real
machine.

The lesson is not about parentheses: **generated code has to be run through the
thing that will run it**, and reading it is not that. `nginx -t` is a step in
the gateway plan for exactly this reason; the shell had no equivalent until
now.

### v0.99.17 — the checksum guaranteed the script was never the same script
On a clean machine the agent installed and the helper did not, again. The cause
is one line, and it is the most ironic of the eight.

The SSH install downloads the script and verifies it with `sha256sum -c`. The
digest was computed from `scriptFor(doc, ticket)` — **without the server** —
while the URL serves `scriptFor(doc, ticket, live)`, with it. On a gateway
those differ by the whole privileged-helper block, so the check failed and the
install stopped before reaching it. A check meant to prove the script was
untampered instead proved it was never the same script.

Both digest sites now build from the same call as the download, and a check
compares the two rather than trusting them to stay aligned.

**Removing an agent reports itself.** It fired the request and said "started",
leaving a ticked "agent configured" box, no output, and no way to tell whether
the machine had been touched — the same screen as a button that does nothing.
It polls now, with a bar, the script's own "removed / left in place" output,
and a line saying the box is cleared and the server stays listed.

`docs/privileged-helper.md` gains a section on why this took eight releases.
Every one was a disagreement between two things that had to match — a path, a
variable name, a route list, a checksum — and none was visible from either side
alone. The patches were never the fix; the checks that read both sides were.

### v0.99.16 — I fixed the wrong directory, twice
    drwx------  /var/www          ← this
    drwxr-xr-x  /var/www/html     ← fixed last release, and by hand

nginx traverses every component to reach a file, so one closed link denies the
whole path however open the rest is. `/var/www` came out 0700 from the umask
and stayed there while I opened its child — and the 403 was byte-identical, so
nothing about the symptom said I had missed.

The installer walks the path now rather than naming directories: a list is a
thing to forget a component from, and I forgot one. It starts at `/var/www`,
because everything above belongs to the distribution and its modes are not ours
to have opinions about, and it fails loudly on any component it cannot open.

**And the probe stops inferring.** Agent v28 walks the same path and reports the
first directory nginx cannot enter — checking the execute bit, since a file can
be fetched by name out of a directory nobody may list. "Answered 403" sends
somebody to a config that is correct; "nginx cannot enter /var/www" sends them
to one chmod.

Reading four modes and reasoning about them is exactly what I did, and I got it
wrong both times. The machine can just be asked.

### v0.99.15 — 0700 on a parent directory, three levels up
The precheck did its job and the machine's own output settled it in one line:

    drwx------  /var/www/html
    drwxr-xr-x  /var/www/html/.well-known
    drwxr-xr-x  /var/www/html/.well-known/acme-challenge

nginx runs as `www-data` and cannot enter a directory it has no permission on,
so it answered 403 — with the config correct, the block loaded and matching,
and the challenge file present. A permission on a parent, above everything
anyone was looking at.

**`umask 077` wrapped the whole installer.** I put it there for the environment
file, which holds the token and should be tight; it then applied to every
directory created afterwards. It is a subshell around that one file now, and
the webroot's mode is set explicitly — nginx has to enter it, so it is not
something to leave to whatever umask happened to be in effect.

**And a step I added and removed in the same release.** Unlinking the
distribution's default site was my other hypothesis for the 403, and `nginx -T`
had already ruled it out: our `server_name` is exact and wins over
`default_server` regardless. Removing it would have been a change to somebody's
machine that nothing asked for, on a theory already disproved — which is the
shape of change this plan exists to avoid. The reasoning is in the file so the
next person does not re-add it.

### v0.99.14 — the precheck went to the agent that cannot do it
The check worked exactly as intended and named a precise cause:

    could not write the challenge file: ENOENT, mkdir '/var/www/html/.well-known'

Which is my fault twice over. `acme-precheck` writes into `/var/www/html`, so
it is privileged work — and it was not on the privileged list, so the ordinary
sandboxed agent claimed it and failed. A permission problem wearing a
missing-file costume.

**This is the second route to reach the wrong agent.** The first fix listed
three and stopped there, which is the shape of fix that comes back. So the list
is written out one route at a time with what each does, and a check now derives
membership from behaviour rather than from the list agreeing with itself: any
`/host/` route in the agent that writes a file or reads process ownership must
be on it. That would have caught this one before it shipped.

A check of my own measured a handler by character count, so adding four lines
to it pushed the cleanup past the boundary and it reported the probe file as
left behind. Bounded by the handler now — a slice measured in characters
measures the wrong thing.

The agent refuses the route outright when it is not the helper, rather than
attempting it and reporting a missing directory — the same guard the apply and
rollback have had since the queues were split.

### v0.99.13 — the precheck passed and certbot still failed
The helper was already v25, so the precheck did run — and said the domain was
fine while certbot said it was not. Two faults behind that.

**A probe that could not run reported as a probe that passed.**
`challengeServed` was left undefined when the fetch threw or the file could not
be written, and the guard tested `=== false`. So "the check did not happen"
read as "the check found nothing wrong", and the apply walked on to certbot.
That is the exact conflation this project refuses everywhere else, written by
me, in the code added to prevent it. Both paths set the field now, and anything
other than a clear pass stops the apply.

**And a machine cannot prove it is reachable from the internet by asking
itself.** The probe fetched the challenge from the machine, where the request
either loops back locally or leaves and returns through the same firewall that
would have let it in. Let's Encrypt arrives from outside — the one leg neither
end could see.

The panel now fetches the same file from its own network, and the agent keeps
it for thirty seconds so both can look. Neither of us is Let's Encrypt, but a
machine that answers itself and not the panel is a machine with port 80 closed
between the two, and **that has its own name** — "not served" would send
somebody to look at an nginx that is working perfectly.

### v0.99.12 — the precheck did not run, and said nothing about it
Same certbot sentence as before, which meant the check added to replace it had
not happened. The helper on that machine is v24; the endpoint arrived in v25.

**The call failed and the result was thrown away** — `catch { acme = null }`,
and then straight on to certbot. A check that quietly does not occur is worse
than none: it leaves the operator believing the domain was verified and certbot
the only thing that disagreed. That is exactly the conflation this project
keeps refusing to make, and I wrote it myself two releases ago.

The job output now says so before the steps run, while there is still time to
stop and update the helper — and it tells an **old helper** apart from a
**broken call**, because "reinstall the helper" and "the call failed" are
different instructions.

**And the agents page shows the helper's version.** An outdated one was
invisible until something it could not do failed, which is how a v24 helper let
certbot run unchecked.

One contradiction found a gap: the check required both codes to exist
somewhere in the file, which passes when the condition choosing between them is
wrong. Bound to the condition.

### v0.99.11 — "some challenges have failed" is not a reason
Five steps passed and certbot stopped with a sentence that says nothing and a
log file on a machine nobody is sitting at.

I could not check the domain from here either — this environment answers 403
for hosts outside its allow-list, so my own probe told me about my proxy rather
than about the machine. Which is the same problem the operator has: **checking
the domain from anywhere except the machine answers a different question.** A
network that reaches it is not the network Let's Encrypt uses.

So the machine checks itself, before certbot spends an attempt on a domain that
cannot be proved — Let's Encrypt rate-limits failures, and an attempt that
cannot succeed is worth not making. Agent v25 resolves the name, learns its own
public address, then **writes a real challenge file, fetches it by name over
HTTP, and deletes it**. That last part is the only check covering the whole
path: nginx config, firewall, and whatever sits in front.

Four faults, four fixes, and certbot calls all of them the same thing:

- the name does not resolve at all;
- it resolves somewhere other than this machine;
- the machine cannot reach itself by name;
- the request arrives and something answers with the wrong thing — the panel
  names what answered, because a 403 from a proxy in front is a different
  problem from a 404 from nginx.

The precheck is help, not a gate on its own behalf: an agent too old to answer
it does not block a preparation that would have worked.

### v0.99.10 — certbot was competing with the nginx we had just installed
nginx installed, certbot installed, and then:

    Could not bind TCP port 80 because it is already in use by another
    process on this system (such as a web server).

`certbot --standalone` binds port 80 itself. Three steps earlier this plan had
made sure something was already there. The previous release taught the plan
that our own nginx on 80 is fine — and this is the other half of that: if it is
fine, certbot has to work *through* it rather than against it.

Stopping nginx to issue and starting it again would take the machine down
twice per renewal, so the certificate is issued by webroot now, and the plan
grew the steps that makes possible:

1. a server block that answers the ACME challenge and returns 404 to everything
   else, written by this plan rather than borrowed from the distribution's
   default site — depending on a file nobody here controls is how something
   works on one image and not another;
2. issue the certificate through it;
3. write the real config, which names the certificate files — nginx refuses to
   load a config pointing at a file that is not there, so this could never have
   come first;
4. remove the temporary block before testing, because two server blocks for one
   name on port 80 is one too many.

**A gate caught me mid-fix.** The new reload step claimed nothing to undo, and
the rule that every step changing something must say how to reverse it is not
one to argue with — reloading again is the undo, by which point the temporary
block has been unlinked by its own step.

### v0.99.9 — the job poll went to a route that did not exist
The dialog polls `/servers/{id}/gateway/jobs/{jobId}`. The route was declared
`/gateway/jobs/:jobId` — without the server id. A 404 on the button.

**`audit:routes` had waved it past.** It excuses a call when a hole *names* the
endpoint rather than filling a parameter, and its rule was "the last segment is
a hole" — which is the shape of every call ending in an id. So it excused the
one call that was genuinely broken.

It now tries the path as written first, and only then relaxes the last hole to
a whole fragment to see whether some route covers the family. A call that
matches neither is a failure rather than a note. That found the real fault, and
one more thing worth having: a hole glued to the end of a segment with no slash
before it is a query string assembled in a variable — `…/overview${q}` — and is
dropped rather than treated as a path segment.

Proven both ways: a route missing the server id fails, and a client calling a
path nothing answers fails.

### v0.99.8 — blocked by the nginx we installed, with no way to clear it
Two faults, and the second is mine twice over.

**The ports were held by nginx — the one the previous run installed.** On a
machine being prepared *for* nginx that is not a conflict, it is what a second
run looks like. It blocks nothing now and says so; the config is rewritten and
the service reloaded. Anything else on 80 or 443 still blocks, and a mix
reports only the parts that are not ours.

**And there was no way to stop what does block.** I built `replacePlan` in
iter23 and deliberately wired no button, writing that stopping somebody else's
service should not happen behind a Next button. That was my judgement put in
place of the operator's — who had asked for exactly this choice when we
designed it, and said so again.

It is there now, and what makes it safe is that it is explicit rather than
absent:

- one checkbox per process, ticked by hand, with the pid, the port and the
  unit;
- a process with no systemd unit is marked **the panel cannot start it again**,
  before ticking rather than after;
- the list is re-read on the server before anything is stopped, because the one
  the operator saw is a minute old at best and a stale pid can name something
  that has since started;
- only confirmed pids are acted on — an empty selection stops nothing rather
  than everything;
- the audit records what was stopped and which of it cannot come back.

`kill` joins the helper's permitted binaries for the unit-less case, where
`systemctl stop` cannot reach. A blocker the panel has no way to clear is a
blocker it should not have been showing.

### v0.99.7 — 504, which means it was working
The helper ran, apt got its packages, and the browser gave up. A 504 comes from
whatever proxies the panel, not from the panel — the work carried on underneath
and finished.

**Installing nginx and issuing a certificate takes minutes, and an HTTP request
held open that long is at the mercy of the thing in front.** Raising a timeout
would have moved the number, not fixed the shape. The agent install solved this
with a job years of code ago; the gateway apply was written synchronously and
should not have been.

It answers 202 with a job id now and the dialog polls, showing each step as it
lands — an animation and nothing else for four minutes is indistinguishable
from a hang, which is what the bar was added to avoid.

The machine's state is written **inside the job**, not where the response is
built: by then the request is gone, and a preparation that outlived it would
have left the panel believing nothing happened.

One contradiction did not bite at first. Disabling the job path with
`if (false)` leaves the 202 in the file, unreachable, and the check matched the
text rather than the condition — so it passed on code that could no longer run.
Bound to the condition now.

### v0.99.6 — the new unit was written and the old one kept running
The same error, byte for byte, after the sandbox had been removed. Which was
the clue: the machine was still running the old unit.

The installer ends with `systemctl enable --now`. That starts a service which
is stopped, and **does nothing to one that is already running**. So re-running
it rewrote the unit file, reloaded it, and left the old process in place with
the old settings — the machine failing in exactly the way the new unit had been
written to fix, with an identical log. The most misleading kind of no-op: every
step reported success.

It restarts explicitly now, after the reload.

**And a third defect of one shape got a gate.** Backticks in a comment inside a
template literal end the string and turn the shell below into JavaScript. Twice
`audit:undef` caught it as an undefined identifier, once it was a bare syntax
error — all loud, all after the fact, none pointing at the cause. In the three
modules that carry shell this way, a backtick inside a comment is now a build
failure with the line number.

### v0.99.5 — a package install cannot be sandboxed by path
The helper installs, polls, claims its task, and then apt could not write
`/var/cache/debconf` — nor `/var/lib/update-notifier`, nor `/var/log/apt`.

Adding those three would have been the fifth patch of the same kind, so this
went the other way and asked what apt actually needs. The answer settles it:
`apt-get install nginx` writes `/usr/sbin`, `/usr/share` and whatever a
package's maintainer scripts touch, and **every value of `ProtectSystem` makes
`/usr` read-only** — `true` included. There is no setting that permits
installing software and also constrains where it writes.

So `ProtectSystem` and `ReadWritePaths` are gone from the unit. `ProtectHome`,
`PrivateTmp` and the kernel protections stay, being the ones that do not
conflict.

**The limits did not disappear, they moved** — or rather, they were always in
both places and systemd was the belt rather than the trousers. The helper's own
code permits six binaries and confines file writes to ten paths, and that is
what holds against a compromised panel, which is the threat this was built for.

**What is genuinely lost is defence against a malicious package**, and nothing
in this design could have offered it: root running `apt-get` does what the
package says. The honest description is no longer "root scoped to ten
directories" but "root that can run six named programs" — which is what
installing software has always meant. Claiming the stronger property was the
mistake, and it survived four releases because nothing tested it against a real
install.

A check now refuses `ReadOnlyPaths`, `InaccessiblePaths` and
`TemporaryFileSystem` too: they produce the same `226/NAMESPACE` for the same
reason, and their appearance would mean this analysis had been forgotten.

### v0.99.4 — two agents were racing for the same tasks
The helper installs now. The apply then failed with `apply-failed` and nothing
else, and the cause was the thing that made the helper work: it runs the same
binary and inherits the agent's environment, including the server id. So a
gateway has **two agents polling as the same server**.

The queue did not distinguish them. `POST /host/apply` went to whichever asked
first — about half the time the ordinary agent, which correctly refused, and
that refusal reached the screen as a code with no message.

- **Tasks are targeted.** A task records which agent may take it, derived from
  the route rather than passed by callers; the claim filters on it. An ordinary
  agent cannot *see* a system task now, rather than being bad at running one.
- **A machine with no helper is refused at once**, not after thirty seconds of
  a task nothing can claim — a timeout reads as a network problem, which is the
  wrong place to look.
- **The helper has its own record.** One `lastHealth` per server was
  overwritten by whichever polled last, so `privileged` flapped: the panel said
  "no helper", then stopped, with nothing having changed on the machine.
- **Alternating instance ids no longer count as restarts.** That counter had
  been climbing forever.
- **The reason reaches the screen.** The panel was already sending it; the
  dialog showed the code alone, which cost an afternoon of looking in the wrong
  place.

Six checks, six proven by contradiction. Two of those contradictions did not
bite on the first attempt — because the edit did not apply, not because the
check was weak, which is worth knowing the difference about.

### v0.99.4 — two agents were racing for the same tasks
The helper installs now. The apply then failed with `apply-failed` and nothing
else, and the cause was the thing that made the helper work: it runs the same
binary and inherits the agent's environment, including the server id. So a
gateway has **two agents polling as the same server**.

The queue did not distinguish them. `POST /host/apply` went to whichever asked
first — about half the time the ordinary agent, which correctly refused, and
that refusal reached the screen as a code with no message.

- **Tasks are targeted.** A task records which agent may take it, derived from
  the route rather than passed by callers; the claim filters on it. An ordinary
  agent cannot *see* a system task now, rather than being bad at running one.
- **A machine with no helper is refused at once**, not after thirty seconds of
  a task nothing can claim — a timeout reads as a network problem, which is the
  wrong place to look.
- **The helper has its own record.** One `lastHealth` per server was
  overwritten by whichever polled last, so `privileged` flapped: the panel said
  "no helper", then stopped, with nothing having changed on the machine.
- **Alternating instance ids no longer count as restarts.** That counter had
  been climbing forever.
- **The reason reaches the screen.** The panel was already sending it; the
  dialog showed the code alone, which cost an afternoon of looking in the wrong
  place.

Six checks, six proven by contradiction. Two of those contradictions did not
bite on the first attempt — because the edit did not apply, not because the
check was weak, which is worth knowing the difference about.

### v0.99.3 — the whole unit, once, instead of one layer at a time
Five releases went to the same class of fault: assuming something about the
machine that was decided elsewhere. Each fix was correct and one layer deep,
and each shipped with "it should install now". `docs/privileged-helper.md` is
the pass that should have come first — every directive against a clean Ubuntu,
with what it requires and whether that is there when it is required.

**`ReadWritePaths` requires every path to exist when the unit starts.** systemd
builds the mount namespace before the process runs, so a missing one fails the
unit outright — `226/NAMESPACE`, buried in a journal on a machine nobody was
sitting at, restarting every two seconds. The counter reached **740**.

Five of the ten paths only appear once nginx and certbot are installed — by
this helper, which could not start in order to install them.

**A `-` prefix is not the fix**, and this is the part that would have caught me
twice: it stops the crash and nothing else, because the namespace is fixed at
start. certbot runs *inside* it, so on a machine where `/etc/letsencrypt` was
absent at start it cannot create it — everything outside the allow-list is
read-only. `ExecStartPre` is no better: it also runs inside the namespace,
after it has already failed to be built.

The installer creates every path before writing the unit, while the filesystem
is still ordinary. The `-` prefixes stay as a second line for a path the list
gains and the script forgets.

**And a unit that cannot start now stops.** Ten seconds, five attempts, then it
stays down where somebody will see it — rather than spinning quietly and
filling a journal while the real fault goes unnoticed.

Four checks, four proven by contradiction, including the one that matters most
for next time: a path added to the list and not to the `mkdir`.

### v0.99.2 — it installed, and then had nowhere to write
The helper reached the machine this time: it found the agent, found node,
created its unit, enabled it — and stopped. The log said *"it did not start"*
and pointed at journalctl, on a box nobody was sitting at.

**Its unit had no `StateDirectory`.** The agent writes a log cursor into
`STATE_DIRECTORY` at startup; with none granted the helper fell back to
`/var/lib/nnm-agent`, which `ProtectSystem=strict` makes read-only. So it
started, threw, and stopped. It has its own directory now — its own, not the
agent's, because two processes sharing one cursor file would each rewind the
other.

**And a helper that will not start now prints the reason.** Twenty lines of its
journal and its unit status, in the install log. Telling somebody to run
journalctl is not something they can act on when they are not on the machine,
and it cost this release: the answer was one command away and nobody was there
to type it.

**"Missing permission: servers.manage" on removing an agent.** Both uninstall
routes named a permission and skipped `requireAuth` — and `requirePerm` reads
the user that `requireAuth` puts on the request, so with nobody there it
refuses. The message is the worst part: it tells a logged-in operator their
role is wrong when the fault is entirely ours.

`audit:routes` now catches it, in files where auth is per-route rather than
router-wide. Its first version examined the middleware with `[^)]*?`, which
stops at the first bracket — `requirePerm(` itself — so the list it searched
never contained the thing it was looking for, and it passed on every route by
seeing none of them.

### v0.99.1 — node is required and was not found
The log said it outright: the helper stopped because it could not find node —
on a machine whose agent was running on node at that moment.

The agent's installer provisions a private node into `/var/lib/nnm-agent/node`
when the system has none, and never touches `PATH`. The helper looked only at
`PATH`. So it stopped with "node is required" ten centimetres from a working
one.

It now looks in the agent's state directory, then `PATH`, then at whatever the
running `nnm-agent` unit is executing — the last being the most reliable answer
available, since a node that is running the agent is by definition a node that
works — and says which it took.

**This is the third release in a row lost to the same shape**: the helper
assuming something about the machine that the installer had decided
differently. The agent binary, then the environment variable names, then node.
Each was correct-looking in isolation and wrong only on a real machine, which
is the most expensive way to be wrong.

So the checks now bind the two files together rather than to literals: they
read `STATE_DIR` out of the installer and require the helper to contain the
paths it builds from it. A fourth divergence fails in the suite instead of on
somebody's VM. Recorded in `docs/STATE.md` as well, because the lesson is not
about node.

### v0.99.0 — the helper was writing variables the agent does not read
Third attempt at the same failure, and this time the cause is the one that
explains all three. The helper's environment file set `NNM_TOKEN`, `PORT` and
`BIND`. The agent reads `NNM_AGENT_TOKEN`, `NNM_AGENT_PORT`, `NNM_AGENT_BIND`.
So the helper started, with no token, on the default port, polled the panel,
was ignored, and never appeared. Nothing failed at any point.

**It inherits the agent's environment now instead of composing one.** Which is
not merely safer: composing could never have worked, because the agent gains
`NNM_AGENT_SERVER_ID` only when it enrols, and without that it does not poll at
all. Copying whatever the agent ended up with, overriding the port and the
privilege flag, is the only version of this that can be right.

The check that would have caught all three attempts is now there: **every
variable the helper writes must be one the agent actually reads.** A name it
never looks at is a setting that silently does nothing.

**A gateway is no longer told its Nimble log directory is missing.** Pressing
Check reported `conf: /srv/nimble/conf`, `media: …`, and `the log directory is
absent` — about a machine that has no Nimble and never will. It says what it
can reach instead, and whether the privileged helper is running.

**And the agent can be removed from the panel**, the same two ways as
installing: a script to run, or SSH credentials used once. What differs is that
there is no undo — an install that goes wrong leaves a service to look at, an
uninstall that goes wrong has already removed it. So the dialog lists what will
go and what will not **before** the choice of how, because what an uninstall
leaves behind is the part people are unsure about.

It removes the units, the token and the binary; it does not touch Nimble's
directories — the agent wrote into them, which does not make them its own — and
it keeps the state directory unless asked, so a reinstall resumes instead of
re-reading a fortnight of logs. The server stays listed in the panel, which the
script says out loud. And the panel clears its record of the agent **only when
the removal succeeded**: forgetting an agent that is still running would leave
nothing able to reach it.

### v0.98.0 — the button fetched a script and showed it nowhere
"Get the helper installer" did nothing visible. It worked: the request went
out, the script came back, and it was rendered inside the block that only
exists after an apply has been attempted. From the outside that is a button
that does nothing, pressed twice and reported broken.

It now renders beside the button that fetches it, with a copy control — a
script meant for a root shell that can only be selected by hand in a scrolling
box is a script somebody will truncate.

**A gateway install no longer asks where Nimble's logs are.** There is no
Nimble on it, and a pre-filled `/var/log/nimble` reads as a fact about the
machine. An empty directory is sent rather than a plausible one, so the agent
does not watch a path that will never exist.

**And the frontend has an undefined-reference gate now.** The backend has had
one since v0.89.0; the frontend had none, which is how `isGateway` shipped
today — used three times in a dialog, declared nowhere, every frontend gate
green. A component that throws on open is worse here than on the backend: React
takes the page with it and leaves a blank screen with no message.

It found a second one immediately. `savePaused` is declared in the WMSPanel
republish table and called from the **native** one — a pause button that threw
a ReferenceError instead of pausing anything, and which had nothing to call
regardless: the native republish API creates and deletes rules and cannot
modify one. The button is gone, with a line saying where pausing happens.

The gate's own first version stripped JSX with regular expressions and left 69
of 79 files unparseable. It refused to pass rather than report OK on an eighth
of the codebase, which was the one thing it got right; it uses a real JSX
parser now, shares the backend's scope analysis rather than duplicating it, and
still exits non-zero if a single file cannot be read. Build-time `define`s are
excused by reading them out of `vite.config.js`, so removing one stops being
excused the moment it is removed.

### v0.97.3 — the helper was looking in the wrong place
Second rebuild, same result: purpose set to gateway, install ran, no helper.
v0.97.2 fixed a real fault — the literal `$AGENT_TOKEN` reaching the helper's
env file — but it was not the one stopping it.

**The helper looked for the agent at `/usr/local/lib/nnm-agent.mjs`. The
installer writes `/var/lib/nnm-agent/nnm-agent.mjs`.** It did not find it,
exited 1 before doing anything, and the `|| echo` around it turned a hard stop
into one line a hundred lines above a summary reading "done". A default that is
wrong is worse than none: it looks like a decision somebody made.

It now tries the installer's path, then the older one, then whatever the
running unit is executing — the one place that cannot be out of date — and says
which it took. A check binds the two files together by reading `STATE_DIR` out
of the installer, so they cannot drift apart again silently.

**And a failed helper now reaches the last line**, because the last line is
what gets read. On a gateway the summary is either *"the agent and the
privileged helper are installed"* or *"done, WITH ONE FAILURE"* — never the
same sentence for both, which is what let this pass twice.

One more thing this exposed: backticks inside a template literal comment
terminated the string, so a paragraph of shell became JavaScript. `audit:undef`
caught it as an undefined `echo` — the parser-based rewrite from v0.89.0
earning its keep on a fault nobody was looking for.

### v0.97.2 — the helper was installed with the word for the token
The purpose was set to gateway, the install ran, and no helper appeared. The
install reported done, because from its point of view it was.

**A quoted heredoc expands nothing.** That is right — the helper script has `$`
signs of its own that have to survive verbatim — but it meant the literal
string `$AGENT_TOKEN` reached the helper's environment file. The helper started,
polled the panel with `$AGENT_TOKEN` as its token, was refused, and stayed
invisible. Nothing failed loudly anywhere.

The substitution happens on the machine now, after the agent has written its
real token, with a placeholder and a `sed` whose delimiter the token alphabet
cannot contain. And when there is no token yet the helper is **not installed at
all**, with a line saying so: installing it with an empty token produces a
service that runs, polls, is refused, and looks installed — the worst of the
three outcomes.

**A gateway no longer shows media-server tabs.** Opening one gave *"Server is
not mapped to a WMSPanel server id"* about a machine that will never be in
WMSPanel — a category error wearing the clothes of a fault. It now says what
the machine is, whether it has been prepared and for which domain, and where
the work actually happens.

### v0.97.1 — the order of work is no longer a trap
v0.97.0 left one: install the agent, then set the machine's purpose to gateway,
and the script had already been built without the helper. The suggested fix was
a warning. A warning about a trap is still a trap with a sign on it.

**The script now uses the purpose as it is when fetched.** The ticket
identifies the server, so looking it up at that moment is exactly as
trustworthy as the ticket itself — my earlier note claiming otherwise was
simply wrong. The ticket keeps its own copy as the fallback for a server since
deleted, and as the record of what was intended.

That leaves one real case: a machine whose agent was installed before any of
this existed. So the panel says whether the helper is there — **from the
agent's own health**, not from anything the panel remembers, because the helper
can be removed with one `systemctl` command and a panel reporting it from its
records would keep claiming it for as long as nobody looked.

**Never asked is not absent.** A machine no agent has reported from is `null`,
and the UI complains only about `false`. Otherwise every server the panel has
not heard from yet would be accused of missing something.

And the warning appears **before** the buttons that would fail rather than
after the refusal, because an apply that refuses on every attempt reads as a
broken panel until somebody says otherwise.

### v0.97.0 — the helper goes in with the install
The SSH install already runs as root, so on a gateway the privileged helper
travels with the agent instead of being a second thing somebody has to remember
on the one machine whose purpose needs it.

**On every other purpose the block is absent from the script**, not skipped at
runtime. A block that exists and is disabled is one that can be enabled by
accident; one that was never rendered cannot. The media-server script says why
it is absent rather than silently differing — a script that quietly varies
between machines is one nobody can compare.

**The purpose is captured on the enrolment ticket.** The install URL is
unauthenticated by design, which is what a single-use ticket is for, so at
fetch time there is no server to look up — and deciding a privilege level from
whatever the fetcher claims is not a decision at all.

**A helper that will not install does not fail the agent install.** The agent
is the thing that had to work: a machine the panel can see and talk to is a
much better place to debug from than a machine with nothing on it.

Five checks, three proven by contradiction — including the helper reaching a
media server's script, which is the one that would matter.

### v0.96.0 — iter23 m4: root, scoped to the job
The agent cannot install packages, and that stays. On fifteen media servers it
needs two directories, and one that could install packages would be root across
the fleet the moment the panel is compromised — over plain HTTP, with agent
tokens in a database.

So the privilege is a second unit, `nnm-agent-privileged`, and the shape is the
feature:

- **Its own service**, not a flag on the existing one. Removing it is one
  command and leaves an ordinary machine behind; the two units share no
  lifetime.
- **Installed explicitly, per machine**, by a person running a script they can
  read first — because installing something that runs as root is a decision
  made on a machine, not a consequence of pressing a button in a browser. An
  operator who dislikes what the script says can simply not run it.
- **Only where it is needed.** A media server is refused it outright; its whole
  justification is that a gateway needs system changes and a media server does
  not, and an installer offered everywhere ends up everywhere.
- **Root, scoped.** `ReadWritePaths` lists ten directories — nginx, certbot,
  apt's state. Full control of the panel then buys nginx and certbot, not
  `/etc/passwd`, not `/root/.ssh`, not a Nimble configuration on a box that
  runs both. It binds loopback only.
- **The limits exist twice**, in the panel's plan and in the helper itself,
  because the plan is composed by the panel and the panel is the thing that
  might be compromised. A lock that depends on its caller being honest is not
  one, and a check keeps the two lists equal.

**An ordinary agent now refuses the work** rather than attempting it and
failing halfway as a wall of apt complaining about read-only filesystems —
which read as a broken machine and was not.

Fifteen checks, six proven by contradiction: `/root` added to the allow-list, a
prefix match without its separator (`/etc/nginx-evil` passing as `/etc/nginx`),
the helper offered on a media server, the two lists diverging, loopback
widened, and the apply guard removed. That last contradiction did not bite at
first — the check matched the whole file and was satisfied by the rollback
handler's identical guard, which is a check about one thing passing on evidence
about another.

### v0.95.0 — the agent is not allowed to do this, and that is correct
The apply failed on a real VM with a wall of apt complaining about read-only
filesystems and dpkg locks. Not a bug in apt, and not a broken machine: the
agent runs as its own user under `ProtectSystem=strict`, `NoNewPrivileges=yes`,
with `ReadWritePaths` limited to Nimble's own directories.

That is right. On fifteen media servers the agent needs two directories and
nothing else, and one that could install packages would be root across the
fleet. **The gateway apply was designed against a capability the agent
deliberately does not have**, and loosening the unit to fix it would trade the
whole fleet's isolation for one machine's convenience.

So the panel now recognises the refusal and says it: what the sandbox is, why
it exists, and that the commands shown can be run on the machine by hand
meanwhile. The proper answer is a separate privileged helper, installed only on
gateway-purpose machines, which is the next milestone rather than a patch to
this one.

Three things the screen was missing:

- **The plan opens in its own window.** Inline it pushed the buttons off the
  bottom of an already long dialog, so the thing to read before deciding was
  the thing to scroll past to decide.
- **Running looks like running.** The button sat grey and silent for as long as
  apt took, which is indistinguishable from a hang — and the one thing anybody
  does with a hung screen is press the button again. There is a moving bar that
  claims no percentage, because apt decides how long it takes and inventing
  progress would be a lie in a bar.
- **A machine says whether it has been prepared**, on the card and not only
  inside the dialog that did it: *gateway configured · cdn-test-1.bbesport.com
  · proxy*, or *the agent may not change the system*. Recorded on failure too —
  a failed attempt is a fact about the machine, and forgetting it is how the
  same wall gets walked into twice.

### v0.94.2 — the agent was answering; the panel was asking wrong
Two faults on one screen, both mine.

**The task route had no method.** The agent bus dispatches on
`"GET /host/ports"`; five calls passed `"/host/ports"`, which matches no
handler. The task went out, came back empty, and the panel reported *"the ports
were not checked — the agent did not answer"* about an agent that was polling
every second and had answered v23 a line above.

The check that should have caught it matched the path alone and therefore
passed against all five. It matches the method now, and a new one walks every
`runTask` call in the routes: a route without a method produces a key nothing
matches and a panel blaming the wrong component.

**"Proxy mode needs an edge" was refusing the normal order of work.** A machine
is prepared and *then* joined to a network — telling somebody preparing a fresh
VM that it is misconfigured for not already being in a topology it cannot be in
yet is backwards. It is a note now, and the nginx written points at
`edge.invalid`, a reserved TLD that can never resolve: a placeholder that fails
loudly rather than one quietly pointing somewhere real.

**And "not checked" now says why.** An old agent answers promptly with "unknown
endpoint" and a dead one answers nothing; reporting both as silence sends the
operator to check a network that is fine. The reason is shown, and when the
agent is simply too old the panel says which version it has and which it needs.

### v0.94.1 — HTTP 404 on the button
Four routes shipped as `/servers/:id/gateway/plan` on a router already mounted
at `/api/servers`, so their real path was `/api/servers/servers/…` and the
dialog answered 404 the moment somebody pressed the button.

Every test passed. The plan was right, the agent was right, the button was
right, and the two halves had never been introduced: unit tests import the
service and never touch the router, the render smoke test answers whatever
fetch is asked, and `node --check` sees valid syntax. The mount prefix lives in
one file and the path in another, and only putting them together shows it.

**`audit:routes`** reads the mounts from `index.js`, the declarations from
every router — following the `const r = wmspanelRouter` aliases these files use
— and every `api()` call in the frontend, then joins them. It catches both
shapes: a path nothing answers, and a route declared with the prefix its router
already carries.

Its own first two versions were the more interesting part. The first did not
follow aliases and reported **forty working endpoints as unreachable** — a
check that fires on correct code gets switched off, and the one real fault goes
with it. The second, fixing that, excluded every call containing two template
holes and reported OK — throwing away thirty real checks to silence five, which
is the exact failure this file exists to prevent: passing by not looking. It
now tries each path as written and only sets aside the five where a hole
*names* the endpoint, listing them as unchecked rather than counting them as
fine.

And a check in the gateway suite was anchored on the old route string, so
removing the duplicated prefix left it slicing an empty span — passing against
nothing. It now refuses to run rather than pass when it cannot find its subject.

### v0.94.0 — iter23 m3: the panel changes a machine
The first thing this panel does that alters a system. Everything until now went
into somebody else's API, where a wrong call is refused; `apt-get` is not
refused, it happens. So the shape matters more than the feature.

**The operator sees the argv and the file bytes**, not a summary of them. A
description instead of the thing is how consent becomes a formality, and
somebody about to let software install packages on their server is entitled to
read what it will run.

**The agent executes steps it is sent and composes none.** Package, file or
command, from a fixed set of shapes — an agent that built its own commands from
a domain would be a remote shell with extra ceremony. What the operator
approved and what runs are the same objects.

**The plan is recomputed at apply and the ports re-read.** If the machine moved
between the preview and the press, the operator approved something else — and
port occupancy is precisely the check whose staleness breaks somebody else's
service.

**Success is a handshake.** Every step can return zero and the machine still
not serve, so the apply finishes by connecting to the domain over TLS and
reading the ALPN. The same rule as delivery, for the same reason.

**Files are copied before they are written**, never moved — a move leaves the
path missing for the moment between, and something reading it then sees nothing
rather than the old contents. The copy's path comes back in the result, and the
rollback restores from it: a rollback that cannot say what it would put back is
a promise rather than a mechanism.

**A halting failure stops everything after it.** Continuing past `nginx -t` is
how a working machine stops working.

**Stopping somebody else's service is not in the flow.** When a port is held
the install stops and names the process, the pid and the unit — a bare process
has no unit and cannot be restarted by the panel, which is said rather than
discovered. The panel does not offer a button for it: making that decision with
a Next button is the wrong way round.

Eleven checks on the executing half, six proven by contradiction — including an
agent inventing its own `apt-get`, a swallowed non-zero exit, and success
declared from an exit code.

### v0.93.0 — iter23 m2: exactly what would be done to a machine
The answer to "can the agent turn a clean VM into a gateway, or make LL-HLS
work" was no, and that made everything after it pointless: LL-HLS could be
chosen and refused forever, and two of the three gateway modes were settings
that did nothing. The core has been finished since iter20 m5 and was waiting on
about a hundred lines of execution.

This milestone builds the plan. Not the applying — the plan, with one rule
above the others: **what is shown is what will be applied.** The same objects
this produces are what the apply path will execute, because a preview computed
separately from the work drifts, and the drift is invisible until it matters.

**Ports are answered by name, not by a boolean.** "Port 80 is taken" is not
actionable; "apache2, pid 900, apache2.service" is, because it decides whether
the operator stops it or stops the install. Agent v22 reports the process, the
pid and the systemd unit where there is one — and a unit is stopped by name
while a bare process has to be killed, which is not interchangeable: stopping a
unit systemd will restart looks like it worked and is not. A process with no
unit is marked as **not reversible**, because the panel cannot start it again
and the operator is agreeing to that.

**A port that could not be read blocks, and is never treated as free.** `ss`
missing means the panel could not look, and proceeding on that is the
assumption this project keeps refusing to make.

**The domain is asked, never guessed.** A certificate is issued for one name,
and an invented one burns a rate-limited issuance to produce something nobody
can use.

Every step says why it exists and how to undo it; the two that cannot say —
issuing a certificate, and testing a configuration — are named as the
exceptions rather than left silent. The order is deliberate: nothing
irreversible happens before the things that can fail, `nginx -t` halts the plan
before a reload, and ACME is served before the redirect or renewal breaks the
moment TLS is on. Replacing somebody else's service is not part of the plan at
all — it is the one destructive thing here and gets its own consent instead of
riding along inside a longer list.

Sixteen checks, five proven by contradiction.

### v0.92.0 — a state document, and an install that reports itself

**`docs/STATE.md`.** Written after proposing to build agent installation that
had existed since iter11 — and after re-deriving WMSPanel facts that had cost
afternoons two iterations earlier. A changelog says what changed; nothing said
what *is*. This does: the facts established against live systems and their
consequences, what exists, what is deliberately absent and why, what is waiting
on a machine rather than on code, and the habits that earned their place. The
readme points at it as the first thing to read, and a check keeps both honest.

**The install stopped reporting itself as a console.** A wall of output asks
the operator to be the parser — to read apt's noise and work out how far it got
and whether that is normal. There is now a bar and six named stages, recognised
from what the installer already prints rather than from a second progress
channel, because a separate reporting path is a second thing that can disagree
with the log underneath it.

The log is a fold below it, not gone: it is the only thing that answers "why"
when a stage fails. The failing line is lifted out beside the bar, so nobody
has to scroll to find it. And a failed install never shows a full bar — a bar
that fills to the end and then says it went wrong contradicts itself, and
people believe the bar.

One contradiction did not bite: the check for the log surviving matched
`job.output` anywhere in the file, and that string is also read to work out the
stage — so it passed against a fold that opened onto an ellipsis. Bound to the
fold itself.

### v0.91.1 — the server dialog asked everything of everyone
Adding a machine offered a WMSPanel mapping to a gateway that will never be in
WMSPanel, playback endpoints to a box with no media server, and buried the one
field that decides all of it — the purpose — in the middle of the form.

**The purpose is asked first**, because it governs the rest. A gateway is then
not asked for a WMSPanel mapping or playback endpoints: there is no media
server on it, so those are questions about something that is not there. TLS is
asked of everything, being the one question that means the same on both — a
gateway terminates it for viewers, a media server needs it for LL-HLS.

Some of the dialog was still in English inside a Russian panel: "Add server",
"Edit server", "Management token", "— not mapped —". That is what an unfinished
screen looks like from the outside, whatever the state of the code behind it.

Five checks, two proven by contradiction. A form that asks for things a machine
cannot have is how people learn to skip fields, and then to skip the one that
mattered.

### v0.91.0 — iter23 m1: what a machine is for, and what it has
The two remaining pieces — TLS on the edges, and a gateway VM — turn out to be
one technical problem: the agent has to work on machines that are not media
servers. That needs saying first, because the panel has assumed otherwise
everywhere.

**A server now has a purpose:** `nimble`, `nimble-cdn`, or `gateway`. A gateway
has no media server on it at all — it terminates TLS, resolves a viewer to an
edge and forwards — and half of what the panel checks about a server is
meaningless there. Naming it lets the panel stop reporting a correct gateway as
a broken Nimble host. The agents page groups and filters by it.

**Changing the purpose of a machine running Nimble is blocked**, not warned
about: something is serving video on it, and that is not a field edit.

**Agent v21 reports what a machine has, and changes nothing.** This is the
first step of a class of action the panel has never taken — everything written
so far went into somebody else's API, where a wrong call is refused. A wrong
`apt-get` is not refused; it happens. So finding out is separated from doing,
and the readiness endpoint runs no package manager, writes no file, and
restarts nothing. The cost of being wrong here is a wrong answer.

Each requirement carries what it is for, because a checklist without reasons is
one somebody overrides. For a gateway, ports being free is checked **first**:
installing nginx where something already holds 80 produces a broken service
rather than an error, and finding that out afterwards means having broken
somebody else's machine.

**"Could not find out" is never "missing".** `ss` not installed must not read
as "the port is free", and an agent too old to be asked must not read as a
machine that lacks things — that is the difference between proposing an install
and breaking a service.

**Two gates caught me.** The first version of the agent's helpers used `sh -c`,
against the oldest rule in that file, with unit names and paths arriving from
the panel over the network — the gate written for ffprobe caught it, and the
helpers are `execFile` and file reads now. And `audit:i18n` could not see
hyphens in key *declarations* while seeing them in uses, so keys present in
both dictionaries reported as missing from both; it surfaced only now because
dynamic keys from a literal list became statically visible.

Installing an agent from the panel, and preparing a VM, are the next
milestones. This one is deliberately the half that cannot break anything.

### v0.90.0 — iter22 m5: the goal at 19:42
DVR turned out to be two different questions with two different answers.

**Recording cannot be set up from here.** WMSPanel exposes `/v1/dvr_streams`
as GET and DELETE only — no POST, the same shape as geo. It is configured on
WMSPanel's own DVR settings page, and the panel says so rather than growing a
switch that does nothing.

**Playback needs no object at all.** A DVR link is the live URL with a
different filename, documented consistently across four of Softvelum's own
articles: `playlist_dvr.m3u8` for the archive,
`playlist_dvr_range-<utc>-<seconds>.m3u8` for a fragment,
`playlist_dvr_timeshift-<shift>-<depth>.m3u8` for a rewind, each with an fMP4
variant. Which makes it arithmetic, and arithmetic can be got right without a
fleet.

So the panel builds the link, and builds it the way the request actually
arrives during a broadcast: **a moment and some padding**, not a start and an
end. Nobody watching a match remembers a start and an end.

The parts that are easy to get wrong, each proven by contradiction:

- **Seconds, not milliseconds.** Milliseconds put the request 46 years out and
  the server answers with an empty playlist rather than an error — the kind of
  wrong nobody debugs quickly.
- **UTC, not the operator's clock.** The picker gives local time and the
  conversion happens in one place, because doing it by hand at speed is how
  footage of the wrong minute goes out.
- **An incomplete range is refused, not completed.** Defaulting a missing
  duration turns it into some other range and produces the wrong minute with
  nothing having looked broken.
- **A stream nobody is recording is named as such.** A replay link for it plays
  nothing, and absent and broken are identical from a player.

### v0.89.0 — the gate that failed three times now parses
`audit:undef` exists to catch an identifier used where nothing declares it.
That defect has taken the panel down three times, and the gate caught none of
them:

- `move`, deleted from ServersPage while its call sites stayed;
- `scriptFor` and `sha256`, the same in agentEnroll;
- `originApps` in v0.85.0 — read by one route handler, fetched by a *different*
  handler in the same file. The gate asked whether the name existed anywhere in
  the module. It did. The channels page answered 500.

Regular expressions cannot answer this. Scope is a tree. The scoped version
attempted last week reported **twenty-six** names that were perfectly in scope —
parameters of callbacks it could not see — and a gate that fails every build
gets switched off, taking everything else it was checking with it.

So it parses now, with `acorn`: every function pushes a frame, declarations
land in the frame that owns them, and each identifier read is checked against
the chain. **Zero false positives across 108 modules**, and all three
historical failures are caught with a file and a line — verified by
reintroducing two of them into the live source.

The distinctions a matcher could not make, each now a check: an object key is
not a read but a shorthand value is (which is the exact shape `originApps`
shipped in); `o.b` does not reference `b` but `o[b]` does; catch bindings,
nested destructuring with defaults and rest, class fields and labels are all
declarations. A name declared later in the same scope is deliberately not
reported — this looks for names that exist nowhere, not for names used early.

An unparseable file is reported rather than skipped, because a gate that
silently passes a file it could not read is reporting success about code it
never looked at.

Two checks guarding the old tokeniser were removed, not rewritten: they
protected a comment-stripping regex that no longer exists. What replaced them
is the rule that survived — this audit reads code as code.

### v0.88.0 — the protection modes that could be chosen and not written
Three of the five modes were selectable in the dialog and only one reached the
account. An operator could pick "our sites only", save, apply, see no
complaint, and have a channel exactly as open as before.

- **Referer protection writes a referer group**, one per network holding every
  allowed domain — same reasoning as the auth group, since a group per channel
  fills the account with near-duplicates. The same domains in a different order
  count as unchanged.
- **IP protection writes two objects**, because it is two: a range group, and
  the CIDRs assigned to it. A group with no CIDRs permits nothing and looks
  identical to one with the right ones, so a plan stopping at the group would
  report success over a restriction that lets nobody in — including the
  operator.
- **A WMSAuth rule is only derived for channels that use signed links.** A rule
  for a referer-protected channel is an object with no effect that a later
  reader has to work out the purpose of.

**Country restriction is refused, and says why.** WMSPanel has `GET /v1/geo`
and no POST: the country list is reference data it holds, not an object a
caller creates. The mode stays in the dialog — marked, with the reason, where
it is chosen — because "set it up by hand in WMSPanel" is a real answer and
hiding the option would only move the surprise. What it does not do is accept
the choice silently, which would leave somebody believing a channel was
restricted.

Existing objects are read once, for all three families, and the same reading
drives the preview and the apply: a plan computed against a partial view
proposes objects that already exist, and the apply then duplicates them or
fails on the duplicate.

Nine new checks, four proven by contradiction — including the two that would
have shipped quietly: assigning no CIDRs, and treating a reordered domain list
as a change.

### v0.87.0 — iter22 m4: how it has held up, not whether it works right now
Step five asked a question and threw the answer away. The probe ran, the page
showed it, the next request forgot it — so the step could never turn green, and
"did this channel hold through the match" was unanswerable.

- **Checks are kept**, one row per channel per check, for thirty days. Manual
  checks land in the same history as scheduled ones: separating them would put
  holes in the record exactly where somebody was paying attention.
- **Availability is three numbers, not one percentage.** Every edge serving,
  some serving, none. Averaging them hides which happened, and they call for
  different work — one is a machine, the other is the channel.
- **Never checked is not healthy.** An untested channel reports as untested;
  100% of nothing is the most flattering number available and the panel does
  not print it.
- **The reasons survive.** A 404 all evening is a missing route; a timeout all
  evening is a network. "It was down" is not a report.
- **The slowest answer survives the averaging**, because a channel that serves
  everywhere in four seconds is technically fine and practically broken.

**Checking on a schedule, off by default and per network.** A panel that starts
making requests to production because somebody installed it is a panel nobody
installs twice — being the viewer means fetching a playlist from every edge,
twice, and that is real traffic to real servers. The interval floors at five
minutes, a pass will not start on top of itself, and a channel checked a minute
ago is left alone: without that a slow pass overlaps the next and the fleet gets
asked twice as often as configured.

**A check that could not run is recorded as not run**, never as a channel that
was down — otherwise the history reports an outage every time the panel
restarts.

The probe itself moved out of the route so the schedule and the button run the
same code. Two implementations of "is it arriving" would drift, and the drift
would show as a history disagreeing with the page in front of the operator,
which is worse than having no history.

### v0.86.1 — it wrote the protection and kept asking for it
Three faults, all visible the moment the button was pressed.

**The plan read the groups and not the rules.** Every rule therefore looked
absent and the step said *create* forever: the operator pressed write, the
object was made, and the page went on asking — which reads as the panel not
having done the thing it had just done. It reads both now.

**"Written: undefined."** The protection apply returned no count and the page
printed the field it expected. A panel saying it does not know what it just did
is worse than one saying nothing.

**Step five could never turn green**, because nothing remembered the probe: it
ran, the page showed the answer, and the next request forgot it. The result now
lives on the network — and carries its age, because a confirmation from three
days ago is a statement about then, not about now. Older than a day and the
step goes back to wanting attention with the age said out loud. A green step
that stopped being true is worse than an empty one.

**Signing a link stopped looking compulsory.** There is a button for a link to
hand out and a separate one for a link locked to a named viewer; the IP field
made the rarer case look required. The panel also says plainly how the thing is
used, because "there is a token somewhere" is not a workflow: press sign, hand
out the URL, it expires — the key never leaves the server, and the panel signs.

### v0.86.0 — the step said everything was set up, and the stream was open
A channel switched to token protection sat unwritten while the Nimble step read
**all set up**. The step counted routes and not protection, so every card on
the page was green and anybody with the URL could watch. That is the worst
shape a status can take: not wrong about a detail, but confidently right about
the wrong half.

- **The Nimble step counts both halves** and says which is which — so many
  routes pending, so many protection objects.
- **Protection blocked is its own state**, separate from routes blocked, and it
  is the more dangerous one: the routes work, the stream is delivered, and it
  is delivered to everybody.
- **The protection plan is shown where it is written**, inside that step, with
  what each object is for and a button to write it. It was derived and returned
  by the API since v0.83.0 and rendered nowhere, which is why nothing appeared
  after switching a channel to a token.

**Six steps became five.** "What it is made of" and "who takes content from
whom" opened the same table twice — roles and upstreams are edited in one
place, so the first step could not be completed on its own and the second card
repeated the first. One step, called Topology.

**The ticks are numbers again.** A tick says a step is finished and loses where
it sits in the order, which is the one thing a chain exists to show. Colour
carries the state instead.

The check that the page renders every step was bound to a literal list and went
red on the merge. Bound to `STEP_IDS` now: the page and the service disagreeing
about which steps exist is how a card opens onto nothing, and a hard-coded list
in the assertion only moves that disagreement into the test.

### v0.85.1 — Internal server error on the channels page
v0.85.0 took the page down. The protection status needs to know which
applications are in HTTP Origin mode, and the handler used `originApps` without
fetching it — the name came from a different handler in the same file, where it
is fetched. A `ReferenceError`, a bare 500, and an operator looking at
"Internal server error" with no way to tell which of a dozen calls had failed.

One line to fix. The status function also treats a missing list as an empty one
now, so the same omission degrades to a less precise answer instead of a dead
page.

**The gate that exists for this defect class did not catch it.** `audit:undef`
collects declarations file-wide and asks whether a name exists *anywhere* in
the module. `originApps` did exist — in the handler above. That is the wrong
question, and it is the second time this shape has shipped.

A scoped version was written and is not shipped. It does catch this — it names
`originApps` the moment the fetch is removed — but it also reports twenty-six
names that are perfectly in scope, because a handler is full of callbacks whose
parameters a regular expression struggles to collect. A gate that fails every
build gets switched off, and then so is everything else it was checking.

The attempt is recorded in the audit file rather than deleted, including the
part worth remembering: the first version of its handler-matching pattern found
**zero** handlers in a file full of them and reported success. A gate that
matches nothing is indistinguishable from a gate that passes. The honest fix is
a parser over these files instead of patterns, which is a piece of work rather
than a patch.

### v0.85.0 — which mode is on, and which one is actually working
Protection could be switched on and nothing showed it. The question — "what is
enabled, what is active" — is two questions, and the row answered neither.

They come apart in a way that matters:

- **chosen** is what the panel holds;
- **applied** is whether the WMSAuth rule exists on the account, which is what
  Nimble reads;
- **in force** is whether it does anything — an application in HTTP Origin mode
  is not protected by a signature however many rules point at it, and that is
  the case where every screen looks correct and the stream is open.

The channels table now carries a Protection column saying all three: *in
force*, *chosen but not written to the servers*, or *written but not in force
because the application is in HTTP Origin mode*. An account that could not be
read is **unknown**, never "not applied" — telling somebody their protection is
off because WMSPanel did not reply is the worst of the three answers.

**And the link that actually works is now obtainable.** Switching on token
protection stops the plain link from working, and there was nowhere to get the
signed one, which would have read as the panel breaking the stream. The row
signs on demand, asks who the link is for — Nimble hashes the viewer's address,
so a link is bound to somebody — and reports when it expires and to which
address.

The check that every status has a sentence found two of five: three sit inside
a ternary and the pattern matched only a `code:` prefix, so it passed on a
third of the truth. Its replacement then swallowed a neighbouring route by
bounding on a comment that had drifted. Bounded on the function's own brace
now — the eighth time this month a gate needed the contradiction run against it
before it meant anything.

### v0.84.1 — a refusal that was not a rate limit
The v0.84.0 release failed on the frontend image:

    failed to fetch oauth token: denied: denied

Not the secondary rate limit from v0.62.5, though it wore the same shape. The
tell is on the same screen: `images (api)` pushed and `images (web)` did not.
Same workflow, same login, same `GITHUB_TOKEN` — so the credentials are fine
and the *package* is not. In GHCR each package carries its own Actions access
alongside the repository's, and one created before this workflow existed, or
linked elsewhere, refuses a push from here.

The retry made it worse rather than better: two minutes of waiting, then an
identical failure, and a summary line reading "GitHub asks for a few minutes
before retrying" about a problem that no amount of waiting fixes.

So the message now names both causes, says which evidence tells them apart —
whether the other image in the same run pushed — and where the fix is
(Package settings → Manage Actions access → give this repository Write). The
retry stays, because the other cause is real and it does clear it.

`audit:release` grows a rule for it. A message that describes one of two causes
sends the operator to wait out something that is not a wait.

**Nothing in the panel changed.** The code of v0.84.0 is intact; it simply
never reached the registry.

### v0.84.0 — iter22 m3: protection you can actually switch on
The model and the signer existed; nothing could reach them. Now the channel
dialog asks who may watch, and the panel writes the WMSAuth groups and rules
that means.

**Each mode says what it costs, where the choice is made.** Referer stops
embedding on someone else's site and not somebody opening the link directly.
Tying a link to an IP breaks it for a viewer who changed network — Nimble puts
the address in the signature either way, this only turns on checking it.
Replacing a key kills every link already issued, and the dialog says so before
the save rather than after the phone rings.

**The key is never rendered.** The dialog reports that one exists; the value
lives on the server and signing happens there. A response is read over
shoulders and pasted into chats, and whoever holds that string can mint links.

**Applying is as careful as the routes were**, and for the same reasons —
because the account has no WMSAuth objects at all, so every request body is
documented rather than observed, and the `to` field of a route is what that
position cost last time:

- the plan is recomputed on apply, never trusted from the page: the account
  changes between a preview and a press, and the change that matters most — an
  application put into HTTP Origin mode — is invisible from that page;
- a create that returns no id looks for the object before undoing anything,
  because a missing id is not proof that nothing was written;
- rollback removes only what this run created. A group that existed before may
  carry rules for channels this run knows nothing about, and undoing it would
  be an outage rather than a rollback;
- a rule names one application and one stream. A pattern that matches more than
  intended protects more than intended, which sounds harmless until an
  unrelated stream stops playing.

Seven new checks on the apply path and the dialog, four proven by
contradiction.

### v0.83.0 — iter22 m2: who may watch, said as intent
A channel now carries protection: open, token, referer, geo or IP range. The
operator says "only from our sites" or "only with a link that expires"; the
panel works out the WMSAuth groups and rules that means.

**Open is a real answer and the default.** Most streams are meant to be
watchable, and a panel that treats "unprotected" as an oversight nags about the
normal case until nobody reads it. What it does do is make the current state
visible: today every stream on the fleet is open, which is a decision nobody
made.

**One group per network, one rule per channel.** A WMSAuth group carries
servers and rules, and a group per channel would leave an account full of
near-duplicates nobody can tell apart — and somebody will look, because this
panel does not yet do everything. A network already owns a set of servers,
which is exactly what a group needs.

**The signing key never leaves the server.** It is generated, never accepted
from a client — a key that arrived over the wire has been somewhere and the
operator cannot know where — and the API returns only whether one exists.
Signing happens server-side, and the audit records what a link was bound to
rather than what signed it. Four checks hold that shut.

The findings separate what defeats protection from what merely weakens it:

- **HTTP Origin mode defeats it entirely** and blocks. The operator sees a
  rule, sees a signed link, and the stream is open.
- **An empty allow-list locks out everyone including the operator**, and it is
  one empty array away at all times.
- **Referer is advisory** — a header the client sends and may decline to send.
  Said where the choice is made, rather than after somebody watches with curl.
- **A validity window long enough to be shared is a warning, not a refusal.**
  The operator may have a reason; refusing would be the panel deciding.
- A country that is not a country and a range that is not a range are refused
  outright.

Blocked is not in sync: a plan with everything written and a blocking finding
reports out of sync, because everything being written and the protection not
working is precisely the state worth flagging.

### v0.82.0 — iter22 m1: signing a link Nimble will actually serve
Every protection family in the account is empty — no WMSAuth groups, no referer
groups, no IP ranges, no user-agent groups. Every stream on the fleet is open:
anyone with a URL can watch it, and anyone can embed it on their own site.

Creating a WMSAuth rule is the easy half. The half that matters is producing a
link that satisfies it, and a link signed slightly wrong does not fail loudly —
the server refuses and the operator concludes the stream is broken. So this
milestone starts with the signer.

    str2hash  = ip + id + key + server_time + validminutes
    hash      = base64( md5(str2hash, raw bytes) )
    signature = base64( "server_time=…&hash_value=…&validminutes=…" )
    url       = <playback url> + "?wmsAuthSign=" + signature

Three details silently change the hash, and each is now proven by
contradiction:

- **`server_time` is PHP's `n/j/Y g:i:s A`, in UTC.** No leading zeros, a
  12-hour clock, uppercase AM/PM. `05/04/2012 08:33:05 AM` hashes differently
  from `5/4/2012 8:33:05 AM` and the only symptom is a 403.
- **The MD5 is base64 of the raw digest, not of the hex digest.** Both are
  strings of plausible length; one of them works.
- **The pay-per-view id sits between the ip and the key.** Order is not
  guessable from the field names.

**A signed link is bound to a viewer's IP**, because the address is in the
hash. The panel cannot hand out a universal signed link and says so, rather
than issuing one that works only for whoever generated it. Expiry and the
bound address come back with the URL.

**And HTTP Origin mode defeats a signature entirely** — Softvelum's own paywall
FAQ says an application listed under HTTP origin applications is not protected
by WMSAuth. That is the same shape as the cache interaction: a mode set
somewhere else quietly disabling something the operator believes is on. It
blocks, like the cache one does.

The UTC contradiction did not bite at first: this suite runs in UTC, so local
and UTC agree, and an implementation using `getMonth()` passed. The assertion
now forces `TZ=Asia/Tokyo`, where the date itself rolls over. Seventh time this
month that running the contradiction found what the assertion had missed.

### v0.81.0 — hit ratio's question, asked so the data can answer it
Confirmed from both directions now: Nimble reports cache **sizes** and no hit
or miss counters, in the native API and in WMSPanel alike. Hit ratio is not
obtainable, and no amount of further looking changes that.

The question behind it survives. What an operator wants to know is whether the
cache is absorbing load — do a thousand viewers cause one fetch upstream, or a
thousand? That is a comparison of two figures the server does report:

    amplification = bytes served to viewers ÷ bytes pulled from the origin

Near one means every viewer's request went upstream and the cache is doing
nothing — which is what HTTP Origin mode looks like from outside. Near the
audience size means it is doing everything. It is not hit ratio and is not
called hit ratio.

**The preconditions are the feature.** A ratio computed outside them is a
confidently wrong number, which is worse than the missing metric it replaces,
so each is checked and refused with its reason:

- **Not an origin.** An origin ingests SRT into the same "in" figure, and a
  working cache would read as broken. On this fleet that is the selectel box.
- **Somebody must be watching.** With no viewers both figures approach zero and
  the ratio is noise — and an idle edge is the *normal* state of a pull-based
  network, so this is the common case, not the exception.
- **The same kind of number.** An instantaneous rate against a lifetime counter
  is not a ratio of anything.
- **Serving with nothing incoming** is said in words — a window served entirely
  from cache — rather than as a division by zero.

Field names are matched by whole words within the name, not by substring:
`in` is a substring of half the language and `Interfaces` is a field on this
very endpoint. A substring match would have divided by the interface count.
That contradiction did not bite on the first attempt — there was no test for it
— which is the sixth time this month a rule existed only in a comment.

### v0.80.1 — the fleet answered, and one question is now closed
Three edges replied:

    RamCacheSize=2735  FileCacheSize=0  MaxRamCacheSize=5096  MaxFileCacheSize=5096
    RamCacheSize=2440  FileCacheSize=0  MaxRamCacheSize=4096  MaxFileCacheSize=4096
    RamCacheSize=1430  FileCacheSize=0  MaxRamCacheSize=8096  MaxFileCacheSize=8096

**There are no hit or miss counters.** Not under another name, not nested
somewhere else — this Nimble reports cache *sizes* and nothing more. Cache hit
ratio is therefore not obtainable from `/manage/server_status` by any amount of
further looking, and the panel now says that once, as a fact about Nimble
rather than as a gap in itself. A question open since the CDN discussion,
closed with an answer nobody wanted.

What the fleet does give is occupancy against capacity, in the megabytes
`nimble.conf` uses — RU-2 at 2735 of 5096, RU-3 at 2440 of 4096, FIN-1 at 1430
of 8096 — shown as a pair with a percentage, with the raw fields kept beneath
so a number can be traced to the name Nimble gave it.

**And a bug the real data exposed immediately.** Every row read "the cache
should hold about 0.0 MB". A re-streaming route pulls nothing until a viewer
asks, so an idle edge reports its streams at zero bitrate, and the sum came to
zero — the absence of an input dressed as an answer, which is exactly what this
project keeps trying not to do. There is now no figure at all until at least
one stream has a bitrate, the count of streams that contributed is stated, and
the rest are not extrapolated from an average.

### v0.80.0 — the cache, read from where it actually lives
Cache hit ratio is the number that says whether a delivery network is a
delivery network or three parallel proxies, and WMSPanel does not report it.
It turns out Nimble does — Softvelum's own Zabbix templates read RAM cache
status from `/manage/server_status`, which is the endpoint this panel has been
polling for metrics since iter7. The metric was one call away the whole time.

**What this does not do is guess the field names.** Every shape taken from
documentation rather than from a response has been wrong in this project: the
`to` of a route, the DASH manifest path, and two TLS fields that existed
nowhere at all. So the report reads whatever cache-shaped keys are actually
present, names them as Nimble named them, keeps the path so a number can be
traced to its field, and says plainly when it found nothing.

- **A ratio only when the two numbers for one exist.** No counters means no
  ratio — not zero. A confident 0% about a cache that may be working perfectly
  is worse than admitting the server did not say.
- **A fresh cache is not a broken one.** Zero hits and zero misses reports both
  counters and no percentage.
- **What the cache *should* need is computed separately** and labelled as
  computed: Softvelum document four chunks resident plus a 45-second timeout,
  so six-second chunks hold twelve, and the RAM follows from the bitrate. It
  answers the question an operator has before an event — will it hold — which
  no counter can answer until it is too late. And it does not grow with the
  audience, which is the counter-intuitive part worth stating.
- Measured and computed never share a row.

11 new checks, four proven by contradiction — including the two that matter
most: reporting zero when nothing was measured, and letting unrelated numbers
into the report, which is how a page full of everything becomes a page nobody
reads.

### v0.79.1 — the TLS check moved to where the port is
It was on the Geography tab because that is where a row of per-server actions
already existed, not because it belonged there. Geography is about where a box
stands; TLS is about what it can carry. It now sits in the server dialog, one
line under the HTTP port, because the port is the number it asks about.

- **A TLS port field beside the HTTP one.** Both are the same kind of fact —
  something Nimble knows and no WMSPanel endpoint reports — and both have to be
  told to the panel.
- **The check remembers a port that answered**, so nobody has to find it twice.
- **On a new server the button says to save first**, rather than being enabled
  and failing on a server that has no id yet.
- The result still shows on the Geography tab, where it is useful next to an
  address; only the button moved.

**A gate for the fault that produced this feature.** The LL-HLS check was
written against `httpsPort` and `http2Confirmed`, neither of which existed
anywhere — so it could never pass. `audit:dialog` now requires that every TLS
field is stored, returned by `GET /servers`, accepted on write and editable in
the form, and that every `tls.*` the protocol gate reads is one the API
actually returns. Proven three ways.

That is the third time this shape has cost a release: geolocation written and
never returned (v0.64.1), a response body on `e.data` read as `e.body`
(v0.62.2), and now two fields invented outright. The check is cheap; noticing
was not.

### v0.79.0 — the LL-HLS gate was reading fields that did not exist
v0.78.0 shipped a check that refused LL-HLS unless `edge.httpsPort` and
`edge.http2Confirmed` were set. Neither field existed — not in the model, not
in the API, not in the database. Every LL-HLS channel was therefore permanently
"not ready", and the option was dead code wearing a working feature's clothes.

It is the same shape as the geo bug in v0.64.1 and the `e.body`/`e.data`
mismatch in v0.62.2: something written on one side of a boundary and absent on
the other, with neither side looking wrong.

**A checkbox would not have fixed it.** "This server has HTTP/2", ticked by a
person, is a claim — and the failure it guards against is a player silently
falling back to ordinary HLS, which is invisible *because* everything looks
configured. Video plays, latency does not change, every screen is green.

So the panel asks the server. TLS negotiates the application protocol during
the handshake, so offering `h2` and `http/1.1` gets the server's own answer
before a byte of HTTP is sent.

- **`Check TLS` on each server**, storing what came back with a timestamp: a
  fact about TLS from three months ago is not a fact about TLS.
- **"Not checked" is its own answer**, distinct from "cannot". One is fixed by
  pressing a button, the other by configuring a server, and reporting the first
  as the second sends the operator to the wrong place.
- **A certificate problem is not an absence of TLS.** The probe passes
  `rejectUnauthorized: false` so a self-signed certificate still yields the
  ALPN answer — and then reports the certificate separately, because a browser
  will refuse what our probe accepted, and that is a delivery failure with its
  own fix.
- **Each failure has its own word**: nothing listening, no such host, a port
  that accepts and never speaks TLS, a failed handshake.

Tested against real TLS servers started in-process — an HTTP/2 one, an
HTTP/1.1-only one, and a socket that accepts and says nothing — so the code
path is the same one a live edge takes, with no fleet and no network. 9 new
checks, 4 more proven by contradiction.

### v0.78.0 — the operator chooses what the viewer gets
Three facts from the fleet's own `nimble.log`, none of which were guessable:

    add_dash_segment key='/cyber_cct/srt_feed_3/v_....m4s' duration=6,0
    add HLS chunk app='cyber_cct' stream='srt_feed_3' duration=6.0
    add_chunk key='/cyber_cct/srt_feed_3/l_....ts'

**Nimble already emits HLS and DASH from one input, in the same second, with
neither configured anywhere in `nimble.conf`.** Offering both is therefore not
a conversion feature — it is choosing which URL to hand out, and it costs
nothing on the server. The panel had HLS hard-coded in the route path, the link
and the probe, so the choice existed all along and was simply never offered.

- **A channel carries its packaging**: HLS, LL-HLS or DASH. The link, the
  gateway URL and the viewer probe all follow it — one helper builds the path
  for all three, because two builders is how a probe and a link drift apart.
- **The DASH path is flagged as unconfirmed.** It comes from Softvelum's
  documentation and no response has been seen for it. The `to` field of a route
  taught what documentation-only shapes cost; the first watch probe confirms
  it, and until then the panel says so.
- **LL-HLS is refused, not warned about.** Softvelum are explicit that it needs
  HTTP/2 over TLS and that a client without them *silently falls back to
  ordinary HLS*. That failure mode plays: the operator sees video, calls it low
  latency, and is watching 6-second segments. So the panel checks TLS on the
  edge and reports HTTP/2 as unverifiable rather than assuming it — treating
  "did not look" as "present" is precisely how the fallback goes unnoticed.

**Also found in the log, and worth acting on outside the panel:** every line is
at debug level (`D:`) on a production origin, which is a lot of disk and I/O
for a machine that is also packaging video; segments are 6 seconds, which by
the mantra means roughly 18–20 seconds of latency — for live sport that is the
"spoiled by the neighbour's TV" case; and there is no access log at all, only
`nimble.log`, which is why cache hit ratio cannot be measured the obvious way.

### v0.77.1 — the chain, and screens you can read
The steps worked and looked unfinished, which was fair: a vertical stack of six
accordions says "here are six settings", not "this is one path and here is
where you are on it".

- **Six cards, arrows between them, and the panel grows out of the card you
  clicked.** It scales from the top edge on purpose — from the centre it reads
  as "the page got longer" rather than "that card opened", which is the whole
  job of the animation. Off entirely under `prefers-reduced-motion`: an
  animation is a way of saying where something came from, and somebody who has
  asked for less of it has already been told.
- **Both dense screens were the same complaint**: everything at one weight, one
  colour, one distance apart, so the eye had nothing to grip and a wall of text
  happened to contain the answer. Headings take the accent colour rather than
  only more weight — bold alone in a dark theme reads as slightly-more-text.
  The facts on "At a glance" are ruled cells instead of a field of numbers, and
  the flow boards on "Is it arriving" have room around them instead of touching.

**A tab was labelled `cdn.tab.setup` in production for a release.** The key was
built as `t('cdn.tab.' + v)` and the i18n gate skips dynamically-built keys —
reasonably, since most cannot be checked. But this one is built from a literal
list in the same file, which is as checkable as a static key. The gate now
expands those lists, and would have caught it.

Two of my own contradictions failed before they bit. The reduced-motion check
searched the whole stylesheet and was satisfied by an unrelated rule elsewhere
— passing on evidence about something else. Its replacement then required a
newline before the closing brace and missed the one-liner it was looking at:
a check reporting a fault it had failed to look for. Both fixed, both re-proven.

### v0.77.0 — iter21 m4: one window, six steps
Everything needed to build a delivery network was there and spread across six
equal tabs. That arrangement answers "where is that setting" and never "what do
I do next" — and the second is the question somebody has the first time. An
operator who had used it for a week still could not say what order to work in.

**Setting up a network is now one screen and one ordered list:**

    ✓ 1  What it is made of        4 servers
    ✓ 2  Who takes content from whom   3 of 3 wired up
    ✓ 3  What it carries           2 channels
    !  4  What Nimble needs for that    2 to set up      [Set up]
    ✓ 5  How a viewer gets a link  straight to the edge, nearest
    ·  6  Does it actually arrive  not checked yet       [Check]

- **A tick means the thing is true.** Every state comes from the same data the
  rest of the panel already computes — not a checklist the operator ticks off.
  A network with no channels derives nothing and is therefore trivially "in
  sync"; that is `empty`, not `done`, because a green mark on a network that
  delivers nothing is a lie in one character.
- **Verification is never done on configuration alone.** Every step above it
  can be right while nothing arrives, which is the entire reason the watch
  probe exists.
- **Three ways of not being done, kept apart**: nothing here yet, something
  needs a decision, and the panel could not find out. Different sentences,
  different next actions, and only one of them is the operator's problem.
- **The steps do not block each other.** Step five opens whether or not step
  four is finished; the panel says what is missing and gets out of the way. A
  wizard that leads by the hand is intolerable the second time, and a network
  is configured once and lived with for months.
- **One step open at a time**, which is what stops the page growing downwards.
  The panels were never too long — they were all on screen at once, and each
  one grew when used.
- The page opens on the first step wanting attention, **once**, and then leaves
  the operator alone. Reopening a step under someone's cursor because the data
  refreshed is the panel arguing with them.

Nothing new was built: the existing panels are slotted into the steps
unchanged. Measurements and the globe stay as tabs beside the list — they are
not steps, they are what you look at when something is wrong.

**The layout gate went red about the tabs it had been given in v0.65.0.** The
rule it was written for — one job at a time, every declared tab renders
something — still holds; the particular jobs moved inside. Rebound to the rule.
That is the sixth gate this month to outlive the arrangement it named.

### v0.76.0 — iter21 m3 finished: one home per thing
Channels could be created in two places — the Channels tab and the Delivery
tab — so an application had two homes and the operator had to know which one
counted. That was the duplication this milestone set out to remove and the
last piece of it.

- **Channels are created in one place.** The Delivery tab shows what the
  network carries and says where to change it. It no longer creates anything.
- **Discovery moved with the creating.** The panel reads what the origins are
  publishing and offers each stream that is not a channel yet, with its origin
  named, one click to make it one. Scoped to origins and ingests deliberately:
  an edge is publishing what it pulled, so offering its streams would suggest
  creating a channel for something that is already a copy of one.
- **Origins that could not be read are named**, rather than their streams
  quietly not appearing.

**The gate for "the operator never types a name the origin already knows" has
now gone red on both moves of that feature** — first when chips replaced a text
box, then when they moved to the Channels tab — while the rule held throughout.
Rebound to the outcome: something reads what the origins publish, and one click
turns one into a channel. Which file does it is not the rule.

Its replacement then fired on the viewer probe, which posts an application and
a stream to `/watch` and creates nothing. Matched on the endpoint instead. A
rule that fires on unrelated code is the same fault as one that fires on
nothing — it just takes longer to notice.

And `audit:tabs`, added two versions ago after the black screen, caught a
function my own edit had deleted along with the block above it. That is the
regression it was written for, found in seconds instead of by an operator.

### v0.75.0 — iter21 m3: the panel does the Nimble part
The panel had grown one screen per Nimble primitive — a tab for routes, a tab
for origin applications, a field for a port — and the operator was the
integration between them. That is backwards. Somebody building a delivery
network is saying "carry this channel here"; everything Nimble needs to do it
follows, and the panel is the thing that knows how.

- **Intent in, primitives out.** `derivePlan` turns a network's channels into
  the complete set of objects Nimble requires, and every one of them carries
  *why* it exists — "so this edge can serve that application" — plus where its
  address and port came from. The reasoning matters more than the objects: a
  panel that writes into an account without asking each time is only acceptable
  while it can show its working at any moment, so the working is one fold away
  on the page.
- **Three ways of having nothing to do, told apart.** Already set up, blocked,
  and a channel the network cannot carry at all produce zero items each and
  mean entirely different things. The worst of them was reporting a *blocked*
  channel as "nothing planned", which reads as "you have not set this up" and
  sends the operator to add something instead of reading the reason.
- **Routes are still planned by the existing planner.** Two answers to "which
  routes does this imply" would drift, and the drift would stay invisible until
  an apply did something the preview had not shown. Gated.
- **The WMSPanel account objects moved to their own page** under
  Infrastructure. Building a network is "which servers, which channels, what
  link"; ABR ladders and origin applications are account-wide settings edited
  by someone who already knows what an ABR ladder is. They are still read —
  the "this edge will not cache" finding comes from exactly that data — but
  nobody walks past them to build a network any more.

**A gate caught me deleting a feature.** Replacing the manual plan step took
the apply report with it, and with the report the only place WMSPanel's own
words about a refusal were shown — the difference between "it failed" and
knowing why. The check that noticed had been written three versions earlier
for that exact sentence.

**And one of my own contradictions failed to bite**: the reasoning fold was
asserted by the name `showWhy`, which `const showWhy = false` satisfies while
making the reasoning unreachable. Bound to state that starts closed and can be
toggled. That is the fifth gate this month whose first version tested a name.

### v0.74.1 — a black screen behind 213 green checks
The Delivery tab rendered nothing. A `useEffect` dependency still named
`channels` — state that m2 had replaced — so the panel threw on mount and React
unmounted the tree.

One line to fix. The interesting part is why nothing caught it.

**`pages-smoke` opens each page on whichever tab it defaults to.** Distribution
now defaults to Channels, so the Delivery panel was never mounted by anything,
and neither were the five other panels behind tabs. A panel two clicks in could
crash for weeks with every check green — and did.

- **`audit:tabs` mounts every panel behind a tab**, with an error boundary, and
  fails on a crash or an empty render.
- **It checks its own coverage.** Any `<SomethingPanel>` referenced by the page
  or by the network panel must appear in its list — which immediately found an
  eighth panel I had not included while writing it. A fixture list that falls
  behind the page is the gap reopening in slow motion.
- The globe is included deliberately: jsdom has no WebGL, so it takes its
  no-WebGL path, and this asserts it degrades to a message rather than to a
  blank rectangle. That is a real browser state, not only a test artefact.

Proven three ways: the dangling dependency, a panel missing from the list, and
a crash introduced in an unrelated panel.

All eight render. The blank screen was in Delivery only.

### v0.74.0 — iter21 m2: a list instead of a question
Channels existed as a model; nothing showed them. Delivery still opened with an
empty text box, and the answer to "what is being delivered and where" was
somewhere between four tabs and the operator's memory.

**A dashboard, one row per channel** — the first thing the Distribution page
opens on now. What it is, which network carries it, what each edge is doing
with it, and the links to hand somebody. Click a row and the links unfold.

- **A channel delivered by nothing gets a row too.** It is the state worth
  seeing before an event rather than during one, and it was invisible.
- **The production link says which edge it resolves to right now**, and
  whether it can resolve elsewhere for another viewer. Handing a policy result
  to a partner as though it were a fixed address is how a link that worked
  stops working for somebody else.
- **Test links, one per edge**, straight past the policy and the gateway, each
  flagged if that edge has no route for the channel — otherwise it 404s and
  the edge looks broken.
- **Copy tells the truth.** `navigator.clipboard` is absent over plain HTTP;
  the toast follows what actually happened rather than assuming, which is a
  trap this codebase has fallen into before.
- Every link plays in place, through the same player the Streams tab uses.

**The delivery tab stopped asking.** The applications come from the network's
stored channels, shown as a list; what the origin is publishing is still one
click away, but the click now creates a channel instead of appending text to a
box that forgot it. The stream name for the viewer probe comes from the
channel — it was being typed into a field beside the place that already knew
it.

**Two gates from v0.63.2 went red about a page that had got better.** They
named `toggleApp` and `streamName` — the implementations, not the rules. The
rules were "what the origin publishes is one click away" and "the probe knows
which stream to ask for", and both still hold by better means. Rewritten
against the outcome; a gate bound to a mechanism outlives the mechanism and
then argues for it.

### v0.73.0 — iter21 m1: the channel the panel never had
"Which streams go through which network" was a question the panel could not
answer about its own configuration. Its model was network → nodes → routes; an
application was typed into a box to compute a plan and forgotten the moment the
page changed. Nothing connected a stream to a network, so nothing could list
them, and a viewer's link had nothing to hang on.

- **A channel is one application and one stream.** `test2/test_stream` and
  `test2/other` are two channels: watched separately, healthy separately, and a
  link points at one of them. Unique on that pair, deliberately — the same
  stream delivered by two networks makes "the production link for this channel"
  ambiguous, and an ambiguous answer to that is worse than a missing one. A
  stream that must reach two audiences is a topology question, not two records
  claiming one name.
- **A channel with no network is a row, not an absence.** A stream that exists
  on an origin and is delivered by nothing was invisible, and it is exactly the
  thing worth seeing before an event rather than during one.
- **Two kinds of link, because they answer different questions.** The
  production link goes through the configured mode and policy: it is what a
  viewer gets, and it changes when the configuration does. A test link goes
  straight at one named edge, past the policy and past the gateway — "does RU-3
  serve this" cannot be asked of a link that might resolve to RU-2.
- **Both say what they reveal**, so that pasting a URL into a chat with a
  partner is not accidentally pasting the address of an origin. The production
  link also says which edge it resolved to *now*, and whether it can move
  between viewers at all: printing a policy result as though it were a fixed
  address is how an operator ends up debugging the wrong machine.
- **A test link to an edge with no route for that channel is flagged.** It
  resolves and 404s, and the operator concludes the edge is broken. Unknown
  routes stay null: "we did not read them" is not "there are none".
- **Test links survive when the production link cannot be made**, which is
  precisely the moment they are wanted.

The link generator touches nothing: no fetch, no await. A generator that
reaches out mid-computation cannot be reasoned about and cannot be tested
without a fleet. 12 new checks, five proven by contradiction.

Next: the dashboard row per channel, and the delivery tab as a list of channels
with a detail beside it rather than a page that grows downwards.

**Eight frontend gates only ran on one machine.** Verifying the release archive
from a clean extraction — rather than from the directory it was built in —
turned up an absolute path to the authoring machine in `pages-smoke`,
`render-smoke`, `select-portal-test`, `pipeline-layout-test`,
`playback-url-test`, `ui-components-test`, `stats-chart-test` and
`clipboard-audit`. Extracted anywhere else, every one of them failed to resolve
React and the suite went red for a reason having nothing to do with the code.

They passed for a year because the project always sat in the same directory.
Nothing caught it because the suite was never run anywhere else — not in CI,
which builds images and does not run it, and not on the operator's machine.
All eight now resolve from their own location, and `audit:portable` refuses a
developer home directory or an absolute path naming the repository. It
deliberately allows `/var/log/nimble` and its like: those are data about a
Nimble box, not paths a script opens, and a check that flags them teaches
people to ignore it.

### v0.72.1 — the answer was below the question
Clicking a place on the globe rendered the result under the canvas, which put
it off-screen at the exact moment it arrived: you click, and the thing you
clicked for lands below the fold while the globe you are still looking at says
nothing.

The place, the measure button and the per-node results now sit in a column
beside the globe, and the whole exchange stays in view. One column on a narrow
screen, since two fixed columns with no fallback is just a different way of
hiding things.

Gated by position rather than by class name: the side column opens, the results
render, and only then does the canvas mount. Anything after the canvas is below
the fold again, whatever it is called.

### v0.72.0 — "the ports are set in WMSPanel"
They are. WMSPanel's server dialog holds custom domains and custom ports, and
the panel was reporting the origin's HTTP port as unset while the operator was
looking at it in the other window.

Checked rather than assumed, against the full inventory of the account:

    GET /v1/server        -> id, name, kind, status, ip, custom_ips
    GET /v1/server/{id}   -> id, name, kind, status, ip

**No port field on either endpoint**, and the account's second HTTP port
appears in no response across all 104 dumps. A port set in WMSPanel cannot be
read by anything built on its API. The natural assumption — configured in
WMSPanel therefore available from WMSPanel — is simply false here, and it is
now written down in `docs/iter20-nimble-routes.md` so the next person does not
spend an afternoon on it.

- **The finding says what is true.** "The panel does not know the origin's HTTP
  port", and why: you may well have set it, its API returns none, so the panel
  needs its own copy. Telling someone a thing is unset when they set it sends
  them to look where it already is.
- **The domains, which the API *does* return, are read on every sync.**
  `custom_ips` is exactly the public name an edge needs, and the panel was
  demanding it be retyped as a playback endpoint before it would admit an edge
  had a name — while WMSPanel listed three for it. A redirect gateway now uses
  them, and the "this redirect reveals your edges by address" warning correctly
  falls silent when a domain exists.
- **And it is offered where it helps**: with a redirect gateway configured, an
  edge whose WMSPanel domain the panel knows gets a note pointing at it.

### v0.71.1 — the ladder was right and too tall
v0.71.0 fixed a flat hierarchy by raising everything, which is the wrong half
of the fix. The ratios were correct and the whole panel felt shouted: a dense
operator tool is read at a desk all day, next to a vMix window, and 15px body
with a 30px page title is a poster.

Back to the compact sizes, with the two things that were actually wrong left
fixed:

- **14 → 17.5 → 22.** Three rungs instead of five. The ladder that matters is
  body → heading; the second heading size wedged between them added no clarity
  and cost the page its density. Panel titles and section titles share one
  step, distinguished by where they sit rather than by being different sizes.
- **A section heading is still bigger than its own contents**, which is the
  fault that started this: `.gsection` was 11px over a 14px body.
- **"At a glance" keeps its layout.** The grid, the spacing between facts, the
  findings at body size in the text colour rather than 13px grey. That was the
  part that was hard to read, and none of it needed the type to grow.
- Buttons, inputs, badges, mono text and panel padding are all back where they
  were.

`audit:type` grows a ceiling to match its floor. It could already catch a
hierarchy too flat to read and would have passed 15 → 19 → 24 → 30 happily —
correct ratios, unusable page. A gate that only guards one direction is half a
gate.

### v0.71.0 — a hierarchy that was not one
The pages were hard to use and there was nothing to point at, because the fault
was not in any single rule. It was in the numbers: `h2` at 15px over a 14px
body, a ratio of 1.07, and `.gsection` at 11px — a section heading set *smaller
than the text beneath it*. Everything was roughly the same size, so nothing
led, and the eye had to read the whole page to find anything on it.

- **A scale with real steps**: 15 → 19 → 24 → 30, each at least 1.25 from the
  last, which is where a difference starts reading as deliberate rather than
  accidental. Meta and micro sit below the body as de-emphasis; they are not
  steps in the ladder and are not treated as any.
- **Section headings are headings.** `.gsection` is the 19px step in the text
  colour instead of an 11px grey eyebrow. The uppercase micro-label survives as
  `.eyebrow`, for column and field labels, which is what it was always good at.
- **"At a glance" was written entirely in `.hint`** — the statement and its fix
  both 13px grey, everything equally quiet and nothing legible from across a
  desk. The figures now read at the heading step, the findings at body size in
  the text colour, and only the fixes stay quiet, because they are read second.
  The nine facts sit in a grid rather than a wrapping row, so the labels land
  in the same places on every visit.
- **Result blocks stopped being cards inside cards.** A rule and some air do
  the same job without two containers competing. Blocking findings get a tinted
  field rather than a coloured edge.
- **The globe zooms**, by wheel, and by two buttons for anyone without one. The
  camera moves rather than the world scaling, so markers keep their size while
  the planet grows — which is what "zoom in on the globe" means to the person
  asking for it.

**A new gate: `audit:type`.** This class of fault has no single line to blame,
so the numbers are the only place it shows: the scale must keep its 1.25 steps,
headings must be set from it, and nothing may undercut the smallest step with
an inline size. That last rule found **24 places where I had done exactly
that** — each one locally reasonable, and together the mechanism by which the
hierarchy had flattened in the first place.

Both of the gate's own first attempts were wrong, and both are worth recording.
It counted panels per file and called two siblings a nest, which would have
demanded a worse layout than the one it found. Then the nesting scan matched
each panel against itself, so every file reported a fault — and a check that
fires on everything is indistinguishable from one that fires on nothing.

### v0.70.1 — a page of demands, most of them invented
An operator opened "At a glance" on a network that was delivering video and
asked what the panel wanted from them. Two of the three things it appeared to
want were faults of mine.

- **An origin was asked what it takes content from.** It is fed by whatever
  publishes into it — an encoder, vMix, an SRT caller — none of which the panel
  models. "Takes content from nothing" about an origin describes the normal
  case and demands an action that does not exist. The rule now applies to mids
  and edges, which genuinely are fed from inside the network.
- **An unrelated application in HTTP Origin mode was reported in red.**
  `blastdotakk` happened to be in that mode on a box that is an edge in this
  network, and this network does not carry it. The finding is real only when
  the application is actually delivered here; otherwise it is worth a note —
  route it through this edge later and it will not cache. Red that usually
  means nothing teaches an operator that red means nothing.
- **The list says what is required before it says what is true.** It opens with
  "nothing is required of you — the list below is observations, not tasks", or
  with the count that does need attention. A list of observations reads as a
  list of demands unless it says which of them are demands.

That leaves one real item on that operator's screen: the origin has no HTTP
port set, so every route this network writes aims at a guessed number.

### v0.70.0 — iter20 m7: the network on a globe
Vector coastlines rather than a photographic texture: sharp at any zoom, no
multi-megabyte image to ship, no licence to track — and a glowing wireframe
reads better than a satellite picture with data drawn on top of it.

The polygons do double duty. Natural Earth 110m, public domain, reduced to
175 countries and 155 kB, and they are both the drawing **and** the answer to
"which country did the operator just click". A click is resolved by ray casting
in longitude and latitude, locally, with no external service and no request.

- **Nodes sit where they are, and only where that is known.** A server with no
  coordinates is listed beside the globe as unplaced rather than dropped at
  0,0 — which is in the Atlantic, and a marker nobody can account for is worse
  than a marker missing.
- **Links are great-circle arcs**, interpolated on the sphere. A straight line
  between two projected points passes through the planet; it looks like a
  tunnel because it is one.
- **Click anywhere and measure.** The click resolves to a country, the country
  selects reference points from m4, and each node with an agent is asked to
  reach them. Latency only, and the panel says why: those hosts belong to
  other people.
- **Loaded only when opened.** three.js is 734 kB and the polygons another 155;
  imported eagerly, every page of the panel would pay for a globe on one tab of
  one page. The whole tab is a lazy chunk, and the main bundle is back where it
  was.
- **A browser with no WebGL is told so**, and pointed at the tabs carrying the
  same facts, rather than shown a blank rectangle.

The geometry is tested without a renderer, because "it looks fine" is how a
globe with its markers mirrored east-west ships: the projection is checked
against its own inverse, arcs are checked never to dip inside the sphere, and
capitals are checked to land in their own countries — including one across the
antimeridian, where ray casting on an unshifted ring answers plausible
nonsense.

**Two things the tests caught that a picture would not have.** The
round-trip assertion compared a wrapped longitude against 180 instead of zero
and failed at 0°,0° — the one place on earth where every coordinate is zero and
nothing can be wrong. And 110m Natural Earth omits micro-states entirely, so a
click on Singapore names Malaysia; that is asserted and documented rather than
worked around, since the alternative is ten times the data for a globe showing
fourteen servers.

**The orphan gate called the globe dead code.** It only understood static
imports, so the first component reached through `lazy(() => import(…))` looked
unreferenced — exactly backwards, since it is lazy because it is expensive and
real. It now follows dynamic imports too, and still catches a genuine orphan.

### v0.69.0 — what is switched on, and what that quietly does
The settings deciding how a delivery network behaves were spread across four
tabs and two other pages, and several of them changed each other's meaning from
somewhere the operator was not looking.

A new first tab, **At a glance**, in two halves. The top is the settings
themselves — audience, shape, link mode, policy, what happens when everything
is down, domain, agents, routes, which geolocation database — so "what is
enabled" is answered by reading rather than inferred backwards out of a list of
complaints. The bottom is only what changes what happens.

The findings worth having are the combinations no single screen can catch:

- **HTTP Origin on an edge.** Valid on the account-objects page, valid on the
  topology page, and together they mean the edge does not cache: every viewer
  fetches every chunk from the origin. Neither screen mentions the other. On
  the origin alone it is the normal setup and is not reported.
- **An origin with no HTTP port**, because every route this network writes then
  aims at a documented default — right until it is not, and then the route
  resolves and never serves.
- **"Nearest" over an edge with no coordinates** — a policy that cannot rank
  it and silently falls back. Reported only under that policy: it is worth
  saying when it changes what happens and not otherwise.
- **A redirect gateway over edges with no names of their own**, which reveals
  them by address — the configuration people set up believing it hides them.
- **A gateway node with no agent**, which cannot be handed a routing table and
  so cannot decide locally.

Severity is chosen for what the operator should do, not for how bad it sounds:
a missing agent is a note, not a warning. The panel has cried wolf enough this
iteration.

**The error contract now covers findings too.** Same shape as `err.<code>`:
`cfg.<code>` and `cfg.<code>.fix`, both languages, read out of the service
source by `audit:errors` — so a finding added later cannot reach the screen as
a bare code, and one added without a fix cannot reach it at all. A finding with
no fix is a complaint, and a panel full of complaints is one that gets scrolled
past. Proven by contradiction both ways.

17 new checks on the overview itself, including the pair that matters most: the
same misconfiguration reported under one policy and silent under another.

One fixture bug found by the gates and worth recording: the new endpoint's
smoke fixture matched `/overview$`, which also matches `/agent-fleet/overview`,
and answering that with the wrong shape blanked the agents page. A fixture can
steal another page's endpoint, and only the click gate noticed.

### v0.68.1 — the preview can now answer its own question
The gateway preview produced a URL and stopped there, saying "weight was used"
about a network with one edge.

- **One candidate is named as such.** With a single eligible edge no policy
  ran and nothing was compared; reporting a fallback described a comparison
  that never happened. It is the sentence an operator with one edge reads on
  every preview, so it was the most-read inaccuracy in the panel. The fallback
  reasons still appear when there was a real choice — checked, because
  silencing them everywhere would have been the easy version of this fix.
- **The link can be checked where it is produced.** The panel made a URL and
  the operator went to a player to find out whether it worked; it now asks the
  same question itself and reports what came back — and asks about the edge the
  arbiter actually chose, since probing every node and showing the first answer
  would report on a machine the viewer will never touch.
- **A player, in a dialog, and it is the existing one.** `HlsPlayer` from the
  Streams tab is exported rather than a second player growing here: the hls.js
  lazy import, the Safari native path and the error wording only need to be
  right once. Under a redirect gateway it plays the target rather than the
  front URL — feeding a player something that 302s tests the redirect, not the
  media.

Four gates, proven by contradiction, including the two that are easy to get
subtly wrong: a check that matches the probe to the chosen edge, and one that
fails if the player is handed the front URL.

### v0.68.0 — the delivery worked; the panel was the thing that was broken
An operator started a stream, opened the edge URL, watched the video, and the
panel said "no healthy edge serving this application". The infrastructure was
right for three milestones and the panel was wrong about it.

**An HLS re-streaming route is a request mapping, not a running transfer.**
Softvelum document it plainly: paths are mapped `/from*` → `/to*`, and the
playlist is fetched from the origin when a user connects. Until somebody asks,
the edge pulls nothing, holds nothing and reports nothing. Everything below
follows from having built three milestones on the opposite assumption.

- **The arbiter deadlocked itself.** It required an edge to be *already
  streaming* a channel to be eligible for it — so an idle edge served nothing,
  was not a candidate, got sent no viewers, and stayed idle. m5 could not hand
  out a single link on a working network. Eligibility is now the configured
  route; what the edge happens to be streaming is a reading, not a gate.
- **"Not reaching viewers", in red, was the resting state of every correct
  edge.** It is now "at rest", in no colour at all, with a sentence explaining
  that a re-streaming route pulls nothing until asked.
- **The panel can now be the viewer.** A watch probe fetches the playlist the
  way a player would — the only honest test of delivery in a pull model, and
  one that warms the cache, so it pays for itself. It reads the answer properly:
  a master playlist is success rather than an empty media playlist, an HTML
  error page returned with 200 is named as such, and two readings a few seconds
  apart distinguish a live edge from one serving the same frozen playlist
  forever. 404 is a missing route, 5xx points at the origin, a timeout is not a
  refusal.
- **Three facts instead of one verdict**: configured, serves when asked, in
  use. They answer three different questions, and the middle one — the only one
  a pull-based edge can be asked — was being inferred from the third.
- **Live mode and a one-line summary**, so a tab left open during a broadcast
  answers "is anything wrong" at a glance.

Sent from the panel deliberately: it is outside the edge, which is the vantage
point a viewer has. Routing it through the agent would have the edge fetch from
itself and test a loop.

**Three gates were wrong about their own rules.** The m3 gate banned every bare
`fetch` in the delivery path — it was written to keep management reads going
through the agent-preferring client, and as written it would have forbidden the
one request that finally told the truth. Narrowed to management paths, with
every remaining bare fetch required to be the viewer probe. Its first
replacement then passed against a hand-built path string, because the helper
was still imported elsewhere in the file; bound to the call that produces the
path. And a check listing the verdicts by hand went stale the moment one was
renamed — replaced by one that reads them out of the service.

### v0.67.0 — iter20 m5: the arbiter Softvelum leave you to write
Their documented answer to load balancing is that you build an arbiter: a
service that reads the Nimble API for load, optionally locates the viewer, and
hands back a URL. Every operator writes it again. The panel already polls the
fleet, already holds the topology, already knows where each box is — it was the
arbiter all along and only lacked the last step.

- **All three link modes, with their price attached.** Straight to the edge
  costs nothing and puts the edge's address in the viewer's URL. A redirect
  gateway carries no media so a cheap box will do — but the 302 target is still
  an edge address, so hiding the edges needs a DNS name on each. A proxy
  gateway reveals nothing and now needs the bandwidth of an edge, because that
  is what it has become. The trade-off is the operator's; the panel's job is to
  state it, including on the preview, where the exposure of the actual URL is
  labelled.
- **Four policies, and each admits when it cannot run.** "Nearest" needs
  coordinates on the edges and a located viewer; without either it falls back
  to weight *and says which fallback happened*. A nearest that quietly becomes
  whichever is how a delivery network develops a favourite continent nobody
  chose.
- **An edge that is serving nothing is not a candidate.** It can be up,
  reachable and idle, and sending viewers there produces a player that spins
  forever — worse than an error. But an edge the panel *failed to ask* stays in
  the pool: shrinking the network on a failed poll would be a larger fault than
  the poll.
- **No healthy edge returns nothing, never a dead one**, and what happens then
  is a decision made once in the open — refuse, or send everyone to the origin.
- **The choice is a pure function.** No clock, no network, no database inside
  it. A decision that sends viewers somewhere has to be reproducible and
  arguable, and the preview returns the full comparison — the runners-up and
  their distances — because "why would this viewer go to Frankfurt" deserves an
  answer.
- **The routing table is pushed, not polled.** A gateway that asks the panel
  per viewer turns a panel outage into a delivery outage, which is the
  correlation this design has been avoiding since the conversation about
  self-hosting.

19 new checks, six proven by contradiction: handing out a dead edge, counting
an idle one, a silent fallback, a redirect claiming to hide what it reveals,
dropping an unpolled edge, and a routing table that cannot reproduce its own
policy.

**One test was wrong and the code was right** — it expected Amsterdam as
nearest to Berlin on nothing but a hunch about the map; Frankfurt is 423 km,
Amsterdam 576. Corrected against the function, with the distances written into
the fixture so the next reader does not have to trust a hunch either.

**And the layout gate forbade growth rather than the rule it cared about.** It
matched the literal list `'topology', 'delivery', 'probes'` and went red the
moment a fourth tab appeared, about a rule that had not changed. It now checks
that the required tabs are present and that every declared tab renders
something — which also catches a dead button, the thing the literal never
could.

Not yet: deploying nginx and the resolver onto a gateway VM, and issuing TLS
for its domain. Those need the machine, and it does not exist yet.

### v0.66.0 — "not-found", about a server at 192.168.200.129
A route answered `{"error":"not-found"}`, the page put that string in a red bar
at the top, and an operator read it about a machine on their own LAN. Every
part of that was true. None of it said what happened, whose fault it was, or
what to do — and the answer was "nothing is broken, type the city in", which is
unguessable from the word displayed.

- **A private address is not a missing one.** A public address absent from the
  database might appear in next month's release; 192.168.200.129 never will,
  from any vendor, ever. The two are now different answers, because they have
  different fixes — and "not found" was sending the operator to re-download a
  database. RFC1918, loopback, link-local, CGNAT and their IPv6 equivalents are
  each classified, with the /12 boundary at 172.31 respected: getting that
  wrong turns a public host unresolvable, silently.
- **Failures are shown where the click was, not at the top of a long page**, as
  a dialog with the sentence first, what to do second, and the raw detail
  folded for whoever will fix the code. For a LAN address it also offers to
  open the manual editor, since that is the actual next step.
- **Bulk actions report outcomes, not counts.** "Resolved 11, failed 3" left
  the operator to find which three and why, one server at a time — the work the
  button existed to save. Each failure is listed with its server and its
  reason.

**This is the house pattern from now on, and it is enforced.** The contract has
two halves: the API sends a stable `code`, and the dictionaries carry
`err.<code>` and `err.<code>.fix` for it in both languages. `audit:errors`
reads the codes out of the service source, so a code added months from now
cannot reach a user as a bare string — which is the real failure mode, since it
renders perfectly and nobody notices.

Proven by contradiction four ways: a new code with no entry, an explanation
with no fix, a code translated into one language only, and `explainError`
falling back to the transport's own message.

One older assertion changed meaning rather than breaking: it expected
`not-found` for `127.0.0.1`. It was never wrong that the lookup fails — it was
wrong that the failure shared a name with a different problem.

### v0.65.0 — the page had everything and no shape
Four panels stacked vertically, each growing downwards on every button press,
with three buttons side by side as equals and the order between them something
the operator was expected to already know. Every fact was present. Nothing was
findable.

- **One job at a time.** A network now has second-level tabs — Topology,
  Delivery, Measurements — because those are three jobs done at three
  different moments: building it, running it, checking it. Stacking them meant
  the page had to be scrolled to be understood, and understood to be scrolled.
- **Unsaved topology follows you.** The plan is computed from what is stored,
  so an operator who edited nodes and moved to Delivery had no way to see that
  what they were planning against was not what they had on screen. The
  Topology tab carries a mark until it is saved.
- **Delivery is three numbered steps**: what to deliver, set up the routes, is
  it arriving. Each step's result appears under that step rather than at the
  bottom of the page, and the apply button says why it is disabled instead of
  sitting greyed out for no stated reason. "Check state" belonged to a
  different question all along and has moved to its own step.
- **The written routes fold away.** Reference material, with its count visible
  so it is never a surprise that something is there, but no longer competing
  with the three steps for attention.
- **The network header is one line**: which network, its audience, its
  description. Everything that edits those properties is behind the pencil.

Four layout rules gated and proven by contradiction. The last of the four
passed at first against `const showLive = true` — which satisfies "showLive
exists" while unfolding the list permanently, the exact thing being prevented.
Now checked as state that starts closed and can be toggled. That is the third
gate in this iteration whose first version tested the presence of a name rather
than the behaviour behind it.

### v0.64.1 — a button that worked and a dialog that was not one
Two faults reported as one confusing page, and neither was where it looked.

- **Resolve worked the whole time.** It read the country, wrote it to the
  database, and `GET /servers` never returned the `geo` field at all — so the
  table it was meant to fill re-read a payload that had never carried it. The
  only symptom was a button that appeared to do nothing, which is exactly what
  a dead control looks like. The field is returned now.
- **The location editor was not a dialog.** It was hand-written markup using
  `modal-backdrop`, a class the stylesheet does not define — the project's is
  `modal-back`. It compiled, rendered and passed every gate, and appeared as a
  plain box in the page flow below the table it was editing. Both dialogs now
  go through the shared `Modal`.
- **A network could not be named.** Creating one posted a placeholder and the
  field to change it existed nowhere, so every network was "New network"
  forever. Name, description and audience are asked once, in a dialog, before
  the network exists — and the same dialog edits them afterwards. Audience
  stops being a pair of buttons floating above an unrelated table of nodes and
  becomes what it is: a property of the network, shown where the network is
  described.

**A new gate: `audit:dialog`**, covering the shape both of these share — a
thing that exists on one side of a boundary and not the other, with neither
side obviously broken. It refuses an overlay class the stylesheet does not
define, refuses a component that assembles its own backdrop instead of using
`Modal`, and requires every `geo` field the server model persists to survive
the projection in `GET /servers`. Proven by contradiction three ways.

Worth noting what did not catch these. The click gate presses every button and
saw nothing wrong: the handler was bound and it ran. The render smoke saw a
component that rendered. The i18n audit saw keys that resolved. Everything was
individually correct — which is the whole reason this class of fault needs its
own check rather than more of the existing ones.

### v0.64.0 — iter20 m4: measuring paths the panel is not on
Whether an edge in Amsterdam can reach an origin in Moscow is a fact about
those two machines. The panel sits on neither, so it asks the agent on one of
them — which is the whole reason agents exist, and the reason a node without
one cannot be measured *from*.

- **Agent v20 carries `POST /probe`.** TCP connect time to a given host and
  port, several attempts, min / max / average and how many answered. Not ICMP:
  ping needs a raw socket, which means running the agent as root or shelling
  out to a binary whose output differs per distro — and what an operator
  actually needs is whether a connection to the port carrying the stream comes
  up and how long it takes. The field is called `connectMs`, never "ping".
- **No payload is transferred.** Throughput needs something to download and a
  decision about what that costs on a live channel. This measures the path, not
  its capacity, and the wording says so rather than implying more.
- **A node with no agent is a gap with a reason, not a number.** The panel
  could reach that box itself and produce a plausible latency — it would be the
  panel's latency, presented as the edge's: the same shape of answer to a
  different question. Three gaps are distinguished, because they have three
  different fixes: no agent, an agent that is enabled and silent, and an agent
  too old to probe. The fleet is never uniformly upgraded, and "no handler for
  POST /probe" from a v19 agent must not read as a broken network.
- **The spread is reported, not averaged away.** A path answering in 12 ms four
  times and 900 ms once is not a 190 ms path, and the average is exactly the
  number that makes it look like one. A target that never answered has no loss
  figure at all — 100% loss and "no connection was ever made" look alike and
  are not.

**Reference points**, for measuring towards places we do not own. Country
mirrors of the Ubuntu archive and cloud storage regional endpoints, each
resolving to one region — no anycast, because 1.1.1.1 answers from whichever
site is nearest the prober and measuring "towards Germany" against it measures
nothing about Germany. Latency only: those hosts belong to other people, and
pulling payload to measure our bandwidth would be spending theirs. Selection is
by country first and great-circle distance second, so clicking western Germany
measures to Germany rather than to a nearer host across the border.

The list is a starting set, not an authority. A point that fails from *every*
node is reported as a probably-stale entry of ours rather than as a region that
has gone dark — the difference between an operator editing a hostname and an
operator investigating a network that is fine.

17 new checks, six of them proven by contradiction: probing an agentless node
from the panel, collapsing the old-agent case into a failure, averaging away
the spread, attributing 100% loss to something never reached, admitting an
anycast host, and computing distance by subtracting coordinates.

### v0.63.2 — every fact on screen, none of it legible
The state view had columns for "on origin", "on edge" and a verdict. Reading it
meant holding the direction of the flow in your head and mapping two numbers
onto it — the job a picture does for free, and the one the transcoder screens
have done since v0.60.0.

- **Delivery is drawn as it runs**: origin → route → edge, three stages left to
  right on the same board the transcoder screens use, with each reading on the
  box it belongs to. The verdict is a sentence, not a tag: "origin-only" means
  nothing until it is read as "the origin has this and the edge does not — the
  route exists, so the edge is not managing to pull it".
- **The applications are offered, not demanded.** The page opened with an empty
  field and three disabled buttons, expecting the operator to know names that
  live on the origin — so the panel goes and reads them, and they are one click
  each. Typing still works for an application that exists in the plan before
  anything is published under it.
- **A missing agent is stated where its consequence is visible.** RU-2 has no
  agent, so it is read by dialling it directly, and the board says so on the
  row where that reading appears rather than in a footnote.

**Two gates were testing their own location.** The dash-not-zero rule went red
when the rendering moved to the new board, though the rule itself had not
changed; rewritten to check whichever component renders readings. Then its
contradiction passed anyway — a bandwidth formatter in the same file had a
null check of its own, so a file-wide search matched a different rule that
happened to look the same. Now bound to the stream count itself. Both of those
were the check being wrong, not the code, and both only surfaced because the
contradiction was run rather than assumed.

### v0.63.1 — a reading whose provenance was known and unsaid
m3 read each box over the native Nimble API and showed the numbers without
saying where they came from. The client prefers the agent and falls back to a
direct dial when the agent cannot answer, so "there is an agent" and "the agent
answered this" are different statements, and the panel was making neither.

- **Each reading says which path produced it** — via the agent, or dialled
  directly. The client now reports its transport instead of the caller
  inferring it from whether an agent looked alive, which would have been a
  guess dressed as a fact in exactly the cases that matter.
- **"Unreachable" was three different jobs wearing one word.** No agent and the
  direct dial failed means install an agent. An agent that is running and
  silent means look at the agent. A refusal from Nimble means the transport is
  fine and the server is the thing to look at — and the old wording would have
  sent an operator to debug an agent that was working perfectly. Each is named,
  and the reason travels with the box that could not be read.
- **A gate, so the rule stops living in memory.** Native reads in the delivery
  path must go through the shared client, because that is the single place
  preferring the agent — one bare `fetch` here would opt out of it silently and
  permanently. The check refuses a `fetch(` in either delivery file and
  requires the transport to be collected rather than assumed.

The classification moved out of the route and into the service so it could be
checked without a server. It had been sitting in the route, and the
contradiction that should have caught it collapsing into one word passed —
because nothing tested it. A rule with no test is a comment.

### v0.63.0 — iter20 m3: stored is not delivering
m2 could write a route and prove WMSPanel stored it. A route can be stored,
correct, pointing at an origin that has nothing on it — and every screen the
panel had would have looked fine. This answers the narrower question: is this
edge serving what I think, from where I think.

- **What the servers say, beside what the plan says.** Each box in the network
  is read directly over the native Nimble API — no WMSPanel quota, so it can be
  asked as often as an operator wants to look — and every application gets a
  verdict that maps to a next action: flowing, not reaching the edge, no route,
  nothing published yet.
- **"Could not ask" is kept apart from "nothing there".** An unreachable edge
  reports as unreachable, not as empty, and a missing reading prints as a dash
  rather than a zero. Zero is a claim; the panel does not get to make it about
  a box that did not answer. An unreachable *origin* does not turn a serving
  edge into a fault either — those are two separate facts.
- **Drift is surfaced, not omitted.** Routes on an edge that no listed
  application accounts for, and routes left on a box whose role has since
  changed, are shown. `/test1/` on the real fleet is exactly this: left over
  from the first successful write. A view of "what is on my network" that shows
  only the plan is showing the plan.
- **A route can be deleted from the panel that created it.** Writing without
  unwriting left the operator in WMSPanel, three menus deep and one server at a
  time, to undo what this page did. The confirmation names the consequence —
  delivery stops at the next sync and viewers notice — because "are you sure"
  about an invisible outcome is not a confirmation.

Cache hit rates would be the obvious next thing to show and there is no
confirmed endpoint for them, so they are absent rather than estimated.

13 new checks on state, 4 more on the panel; every rule that decides a verdict
proven by contradiction. One of those contradictions appeared to pass at first
— the fault was quoting in the throwaway script that ran it, not the gate. A
check that seems not to bite is worth re-running by hand before it is believed.

### v0.62.5 — a release that failed for no fault of its own
The v0.62.4 push to ghcr was refused:

    denied: permission_denied: HTTP 403 "Forbidden"
    "You have exceeded a secondary rate limit. Please wait a few minutes…"

Nothing was wrong with the build. GitHub throttles pushes when they come too
fast, and six releases in a day — each pushing two images under two tags, with
the matrix running both at once — is fast. The wording is the trap:
`permission_denied` reads as a credentials problem and sends you to check
secrets that are fine.

- **The push retries once, after two minutes.** The layers are built and cached
  by the first attempt, so a retry costs the push and not the build. The same
  shape already used for `setup-buildx`, for the same reason: a step that fails
  for a reason that resolves itself should not fail a release.
- **Images are pushed one at a time.** Two jobs pushing to ghcr in the same
  second is half of what earns the limit. The images are small; the serial
  cost is about a minute.
- **`audit:release` grows two rules**, because this will recur the next time
  several fixes ship in a day: the push must have a retry, the retry must be
  conditional on the first attempt failing rather than pushing twice always,
  and the matrix must not run in parallel. Proven by contradiction.

Worth noting that the failure was clean. The tag is created last, in the final
job, so a release that dies mid-way leaves no tag — and the next push to main
simply does the whole thing again. That ordering was chosen in v0.59.2 for
exactly this, and this is the first time it earned its keep.

### v0.62.4 — a route was written and there was nowhere to see it
The first live route landed and read back matching. The next question — where
is it — had no answer in the panel: it showed intent and never state.

- **The routes that exist are listed, under the plan.** Every route on the
  account, with the fleet's names in place of WMSPanel ids, refreshed after an
  apply so it is not stale exactly when it is read.
- **Where to look outside the panel is written down**, because it is not
  guessable: WMSPanel holds routes per server, under Nimble Streamer → Edit
  Nimble routes, and a route written for one edge is invisible while another
  server is selected. The Nimble instances get it on the ~30s sync.
- `docs/iter20-nimble-routes.md` moves "what a created route returns" from
  unknown to confirmed — the response does carry the route. The missing-id
  fallback stays: one observation is not a guarantee, and undoing on a wrong
  assumption would delete a route that exists.

### v0.62.3 — the target was never a URL
The first live `POST /v1/routes/` answered:

    HTTP 200
    {"status":"Error","message":"Target Domain and Port must be specified (e.g 127.0.0.1:8080)"}

`to` is host, port and path — `79.98.187.66:8081/test1/` — with no scheme. The
`http://` hid both the domain and the port from WMSPanel's parser.

The reference is not wrong; it is incomplete in a way that reads as complete.
Every populated example it gives points at `file:///var/www/video/`, which is
the VOD special case, and building the general form from it produced something
plausible and rejected. The vendor's own UI splits the field into "Domain to"
and "Path to", which is the same fact seen from the other side.

- **The scheme is gone, and a check exists so it cannot come back** through
  some later formatting change. One character, one release cycle.
- **HTTPS origins are not offered.** `to` has no scheme, so it cannot express
  one; the reference documents an SSL option in the dialog but no field for it
  in the object, and this account has no route to read back. Left unsupported
  rather than guessed at.
- **`docs/iter20-nimble-routes.md`** records what the live API accepts,
  separated into what a real response confirmed and what is still unknown. The
  thing worth keeping is not the answer but which parts were observed.

Worth noting for anything else built on this API: the error came back with
**HTTP 200**. A client that trusts the status code would have recorded a route
that does not exist. `wmspanelClient` checks the body's `status`, which is the
only reason this surfaced as a failure instead of a phantom success.

### v0.62.2 — the apply failed and said nothing about it
The plan reached the servers, the apply came back "HTTP 502", and that was the
entire message. The read-back, the rollback and the per-route steps all ran and
all worked; none of it was on screen.

- **Two files disagreed about one property name.** `api.js` attaches the parsed
  response body to `err.data`; the routes panel read `e.body`. Every failure
  therefore arrived as a bare status line with the useful part — which route
  stopped it, what WMSPanel replied, what was rolled back — discarded on the
  way. A blocked plan had the same fate, so the 422 findings were never
  reaching the operator either.
- **What WMSPanel said now reaches the step.** The client already parsed the
  upstream body; it was being collapsed into a status code one layer up. It is
  the only thing that names the real cause, so it travels with the step.
- **A create that returns no id is no longer assumed to have failed.** The
  reference says the response carries the route, but this account had none to
  learn from, and a missing id is not proof that nothing was written — rolling
  back on that assumption would delete a route that exists. The list is re-read
  and the route looked for before anything is undone.

**A new gate asserts the error contract from both ends**, because this class of
bug is invisible to every check that looks at one side: what `api.js` names the
property, and that the panel reads that same name. Proven by contradiction in
both directions — the reader drifting, and the writer renaming.

The first version of that check passed on a file where the only mention of the
property was the comment explaining it. Comments are stripped before matching
now; a gate that a sentence can satisfy is not a gate.

### v0.62.1 — the save that threw away the topology
Adding a server to a network and pressing Save answered "Internal server
error", and the plan then reported "this network has no edges yet" about a
topology sitting on screen. Both were one bug.

- **Client-side node ids are minted server-side now.** A node the operator has
  just added has no id, so the page invents a temporary one. That string went
  straight into `_id` — and into the `upstream` of whatever pointed at it —
  where mongoose refused the cast. The save never landed, which is why the plan
  was right: the *stored* network had no nodes. Ids are minted on the server
  and every upstream reference is rewritten through the same map, so a brand
  new edge can point at a brand new origin in a single save. A reference to a
  node that is no longer in the payload is dropped rather than carried as a
  dangling id.
- **A failed save says which field is wrong.** It reached the operator as a
  bare 500, which manages to be both alarming and uninformative.
- **The plan will not run over unsaved edits.** It is computed from what is
  stored, so pressing it over pending changes could only ever answer about a
  different network than the one being looked at. It now says so and waits.
- **Geography moved to its own tab.** Deciding which box is an edge and
  checking that a box is in the country you think it is are different jobs done
  at different times; stacking them made the page open with fourteen rows of
  geography before the thing the operator came for.

**A new gate: `audit:attribution`.** Splitting the panel in two left the DB-IP
link behind in the half that no longer renders geolocation — and DB-IP's
CC BY 4.0 grant requires that link on pages showing its results. Nothing
checked it; the click gate caught it only by accident, because the component
was left referenced rather than deleted. Now the check is explicit: whichever
component renders geolocation results must render the link and the licence it
is granted under, and the service and the page must attribute the same source.
Proven by contradiction three ways. An earlier comment claimed this gate
existed when it did not — that has been true and false in the same file for a
version, which is its own small lesson.

### v0.62.0 — iter20 m2: from a network on paper to routes on servers
m1 recorded which box is an origin and which is an edge. This turns that into
the Nimble routes that actually make it so — and, more usefully, into the list
of reasons it might not do what the operator reads.

- **The plan is a first-class thing.** A network plus a list of applications
  produces the exact `from` and `to` that would be written, on which server,
  with which action (create / update / already right). It is computed with no
  side effects, so it can be looked at as often as wanted, and it is recomputed
  server-side before an apply: the fleet can change between reading a plan and
  pressing the button, and that change is invisible.
- **HTTP Origin and caching cannot both be on, and the panel now refuses.**
  Softvelum state it plainly — HLS re-streaming is not cached while HTTP Origin
  mode is enabled. This fleet already runs HTTP Origin: `blastdotakk` across
  three servers, RU-2 among them. Route that application to RU-2 as a caching
  edge and every viewer fetches every chunk from the origin. It works, it
  reports nothing, and origin traffic multiplies by the audience. Blocking, per
  server rather than globally, and not a problem on the origin itself, which is
  the normal setup.
- **An assumed port is labelled as assumed.** Nimble's HTTP port is not exposed
  by any WMSPanel endpoint, so an origin without one set gets the documented
  default — and the plan says which number it used and where it came from,
  beside the URL it produced. An assumed port yields a route that resolves and
  never serves.
- **Apply reads back what it wrote.** The account had no routes at all, so the
  create response shape is unproven; a create that reports success and stores a
  different target is exactly the failure worth paying a call to exclude.
  Rollback removes only what this run created — an update is left and reported,
  because restoring the previous target would mean inventing it.
- **Re-running a plan does not duplicate it.** An identical route is kept, the
  same path pointing elsewhere becomes an update with the old target shown, and
  a route on a different server is not treated as this one.

Built and tested on the fleet's own topology: selectel(24/7) as origin,
Nimble RU-2 and RU-3 — the two boxes already named "Только Раздача" — as edges.
That naming is the whole argument for m1: the intent existed, in a place no
program could read. 16 new checks; the four that matter proven by contradiction
(severity downgraded, the HTTP Origin check removed, an assumed port passed off
as configured, deduplication removed).

**The API reconnaissance tool was hiding its own failures, and leaking.**
A run that returned 52 identical `FAILED` lines turned out to be one cause:
WMSPanel matches the caller's IP against a whitelist, and the script had been
run from a workstation instead of the panel host. It could not say so because
`curl -f` discards the body, which is where WMSPanel explains itself. It now
reports the HTTP status and the response, stops at the first refusal instead of
turning one cause into fifty lines, names the three things to check in order,
and defaults to api.wmspanel.com — where all 505 documented examples point.

Worse, its header claimed the output contained no credentials. True of the API
keys, false of everything else: the successful run carried 121 republish
logins and passwords, push credentials, licence keys and **live Twitch stream
keys**. Secrets are now redacted on write and listed in `_redactions.txt`,
verified against the real dump format.

### v0.61.0 — iter20 m1: roles and geography
The panel now holds a delivery network as an object of its own, and knows
where each server physically is without asking anyone.

- **Roles are written down.** Nimble has no notion of "this box is an edge" — a
  server becomes one because somebody pointed a route at an origin, and the
  only record of that intent lived in whoever set it up. A network now carries
  its nodes with roles (ingest, origin, mid, edge, gateway) and their
  upstreams, so later milestones can compare the plan against what the servers
  actually report instead of drawing a topology from configuration and calling
  it the truth. Direction is enforced at the API: an origin cannot pull from an
  edge, a node cannot feed itself, and a cycle through otherwise legal edges is
  refused. An unwired edge is a warning, not a refusal — a network is normally
  incomplete while it is being built.
- **Country is resolved offline.** DB-IP Lite, CC BY 4.0, fetched into its own
  volume on demand. The request goes out from the panel, not from the managed
  servers: DB-IP sees a download, not a lookup, and nothing about the fleet
  leaves the building.
- **Country Lite is the default, and that is not a compromise.** It is 7.9 MB
  against City's 124 MB *and* DB-IP rates it more accurate — index 81 against
  77 — because city granularity adds error it does not remove. City earns its
  size only if approximate coordinates are wanted, and the trade-off is stated
  beside the selector rather than in a manual.
- **No invented coordinates.** With the Country edition loaded there are no
  coordinates at all, so the panel sets the country and says so, rather than
  placing a marker on a country centroid that no data backs. Real centroids
  arrive in m7 computed from Natural Earth geometry.
- **Two provenances, kept apart.** `source` covers the country, `coordsSource`
  the coordinates, separately, because they do not arrive together. A value
  entered by hand is marked as the operator's and is never overwritten by a
  later lookup — DB-IP infers a location from a routing prefix, the operator
  knows which rack the machine is in. Latitude and longitude are set or cleared
  together: half a coordinate is not a position.
- **The page was two things in one list.** Distribution now separates the
  delivery network — the plan, held by the panel — from account objects (ABR
  ladders, aliases, origin apps) that live in WMSPanel and apply to whatever
  servers are ticked. It was impossible to tell which settings described a
  topology and which were global.
- **Attribution is a build gate.** CC BY 4.0 requires a link back to db-ip.com
  wherever results are shown, so the link is in the page and the audit fails
  without it.

The downloader is tested without a network, because none of what can go wrong
with it needs one: the release-candidate order, a 404 on the 1st of the month
falling back a month, the year boundary, a body that lies about its
content-length, an interrupted download leaving no partial file, a working
database surviving a failed update, and a download that gunzips cleanly and is
not a database being refused before it replaces anything. 26 new checks.

**Two gate findings, neither of them in this milestone's code.**
`pages-smoke` had been reporting a missing React key. It was in FunctionsPage,
where every row's key was `fn._id` — and the smoke fixture supplied only `id`,
so every key was `undefined` and React fell back to index. The page was right:
that endpoint returns raw mongoose documents. **The fixture was lying about the
shape of the API**, which is precisely how a smoke test stays green while
production does not. And `audit:version` aside, the glyph-verb rule caught a
text Edit button in the new panel — the convention held.

### v0.60.0 — editing a scenario now looks like the scenario
The read-only view drew a pipeline the way it is operated: source → processing
→ encoders, one card per pipeline. Both screens that *change* a scenario threw
that away and rendered a single table of every element of every pipeline of
both kinds. A scenario with four decoders, six filters and one encoder became
eleven rows, and nothing on a row said which stage it was, which pipeline it
belonged to, or whether it was video or audio.

- **One layout, three screens.** `PipelineBoard` is now the only place a
  pipeline is laid out, and the scenario view, the editor and the clone wizard
  all render through it. They differ in what goes inside a node, not in what
  the picture is — so a change to the shape of a scenario can no longer appear
  in one screen and not the others.
- **Fields live on the node they belong to.** `app` and `stream` are edited on
  the decoder card in the source column; the encoder's are edited on its card
  in the encoder column, under its codec. The forwarding flags stay folded
  behind their count, on the node rather than in a cell. An edited node is
  marked, so what is pending is visible without reading the diff.
- **The processing stage is no longer missing from editing.** Filters were
  rows in the table with a caption; they are now the middle column, with the
  split and its undocumented branch assignment carried across exactly as the
  read-only view states it. The fan-out itself is labelled as fixed in
  WMSPanel instead of offered as a field.
- **The clone wizard shows what it is cloning.** Eight rows reading "Source"
  became the pipelines they came from, with the filters shown dimmed and
  marked as copied as-is. Retargeting the wrong encoder in this dialog creates
  a second scenario writing over the first one's output, and the flat table
  gave the operator nothing to catch that with.
- **Bulk retargeting, visibly.** A clone almost always moves every decoder to
  one application, every encoder to another, and needs new output stream names
  so the copy does not collide with the original. Three helpers do that in one
  go — and they write into the per-node fields, so what the boards show is
  what gets sent. Nothing is applied invisibly at submit time.
- **A filter and a search on the editor**, matching the scenario view, because
  a fleet scenario is wider than a screen.
- **A new gate: `audit:board`.** It renders all three screens against a real
  scenario shape and asserts the structure is on screen — one card per
  pipeline, three stage headings each, decoders before encoders in document
  order, the processing stage present, every endpoint an editable node — and
  that a flat element table does not come back. Proven by contradiction on
  four separate regressions.
- **Three assertions rewritten as outcomes.** They matched the editor's source
  verbatim — `filter: ['params', 'name']` and `keys.filter(k => cur(k)).length`
  — so reordering two field names and renaming a local broke checks that care
  about neither. They now read the documented-field map as a set and locate the
  flag count by what it does. This is the same fault v0.58.1 found in the SRT
  merge checks; it had simply not been swept for elsewhere.
- **`audit:version` named a variable, not an invariant.** It asserted the
  workflow contained `image_tag=$pkgver`; the rename to `version` changed
  nothing it cares about and it went red anyway. It now checks that the output
  feeding the ghcr tag is the bare version and that the tag expression never
  reaches for the epoched one.

### v0.59.2 — releasing stops being something a person can get wrong
v0.59.0 made the version single-source and made CI refuse a tag that disagrees
with `package.json`. The gate is right; the process around it was not, and
three releases died in a row without a single line of panel code being at
fault:

| tag pushed | `package.json` on that commit | |
|---|---|---|
| `v1.8.7` | 0.59.0 | old scheme against a new tree |
| `v0.59.0` | 0.59.1 | tag from before the bump the same change carried |
| `v0.59.1` | 0.59.0 | the revert took the bump with it |

Every one of those was a person retyping a number that a file already knew, so
the number is no longer asked for.

- **A version bump pushed to `main` is the release.** The workflow resolves the
  version from `package.json`, checks that `v<version>` is not already tagged,
  builds, publishes, and creates the tag itself at the end. Nothing to type,
  nothing to keep in sync. A push to `main` that does not change the version
  skips every job and stays green.
- **The tag path still exists and is still strict**, for a deliberate
  re-release — and its error now says that tagging was never required.
- **The tag is created last.** A release that fails halfway leaves no tag, so
  the next push to `main` retries the whole thing rather than needing a tag
  deleted first.
- **The version is resolved once.** The two jobs each carried their own copy of
  the same shell block — the same drift the block exists to catch, one level
  up. A `meta` job resolves it and both consume its outputs, and it compares
  the two `package.json` files, which nothing did.
- **The pool comes from the branch, not the CDN.** `build-apt-repo.sh` read the
  existing pool through the Pages URL, and Pages is a CDN with a deployment
  queue already observed lagging and cancelling. A stale read drops older
  versions out of the rebuilt index while their files sit on the branch —
  rollback breaks and nothing reports an error. The job checks `gh-pages` out
  and reads the pool from disk; the URL stays as a fallback.
- **A release that cannot be installed is refused before it is signed.** apt
  offers an upgrade only when the new version sorts strictly above the
  installed one, and `0.59.x` sorts *below* the `1.8.x` in this pool — so a
  release that loses the epoch publishes cleanly, reports success and reaches
  no server. The repo build compares against every version already in the pool
  and stops.
- **One `.deb` per Release.** v0.59.0 started pulling the published pool back
  into `dist/`, and the Release step globbed `dist/*.deb` — so every historical
  version would have been attached to every Release, growing each time. The
  preserved pool is staged outside `dist/` and the Release names one file.
- **A new gate: `audit:release`.** Ten rules over the workflow, the packaging
  scripts and `postinst`. All ten proven by contradiction.

Verified in a container rather than only read: the decision block run against a
real git remote in all five cases (new version, matching tag, two mismatched
tags, already-released version); the deb built with the epoch; the repository
assembled against the real `gh-pages` pool, signed, and resolved by a live
`apt` — `Candidate: 1:0.59.2` above `1.8.5`, InRelease accepted without
warning, `apt install nnm-control=1.8.5` still available.

### v0.59.0 — the release the panel could actually deliver, and the editor it hid
Two independent faults, both about work that existed but never reached a screen.

- **The transcoder pipeline editor was edited in a file the app no longer
  renders.** On 24 Jul the mounted editor was switched `PipelineEditor` →
  `ScenarioEditor` (the guarded, preflight-checked one), and `PipelineEditor`
  was left in the tree. Two later iterations then wrote the "regroup" work —
  folded forwarding flags with a count, the audio filter's name/params — into
  that orphan, so none of it ever showed. The forwarding block now lives in the
  live `ScenarioEditor`, folded per input/output with a count of what is on;
  because those flags are undocumented as changeable, editing them is gated
  behind an explicit opt-in and still goes through the same preflight-verify-
  rollback path. `PipelineEditor.jsx` is deleted.
- **A new gate: `audit:orphan`.** A component that no other file imports is not
  in the running app, and `audit:deadimport` could not see it (the orphan
  imports nothing wrong; it is simply never reached). The gate also surfaced a
  second orphan — `TemplateWizard`, reachable by a button that set state nothing
  consumed — which is now wired back in.
- **Versioning is single-source and can upgrade again.** The version comes from
  `package.json`; the release fails if the tag disagrees. The `.deb` now carries
  a Debian epoch (`1:0.59.0`) so the internal 0.x scheme sorts above the stray
  `1.x` tags already in the pool and `apt upgrade` offers it; the image tag and
  `NC_VERSION` are the same version without the epoch, since a docker tag cannot
  contain a colon.
- **The apt pool is preserved across releases.** The repo build pulls the
  already-published `.deb`s back in before rebuilding, so older versions stay in
  the index — rollback (`apt install nnm-control=<old>`) works again instead of
  the pool holding only the current release.

### v0.58.2 — two real faults in our release workflow
Both found by reading the Pages logs rather than the panel, and both ours.

- **No `concurrency` group.** Every re-run and every overlapping release adds a
  Pages deployment for the same branch, and GitHub cancels the earlier one to
  make way — so a run re-tried to unstick a deployment is a run that cancels
  the deployment it was waiting for. That is exactly the `Deployment
  cancelled` in the log. `cancel-in-progress: false`, because a half-published
  release is worse than one that waits: by the time Pages runs, the deb is
  attached and the images are pushed
- **A re-run produced no new commit.** `peaceiris/actions-gh-pages` does not
  push when the tree is identical, so re-running after a successful push
  creates nothing and re-deploys the same version — which is why
  `pages_build_version` was byte-identical across two runs with different
  artifacts. The repo build now writes `build-info.txt` with the timestamp, run
  id, commit and deb name, so every release differs and what is published can
  be read from a browser:
  `https://voidnery.github.io/nnm-control/apt/build-info.txt`

The branch content itself was correct throughout — the Pages build log lists
`nnm-control_1.8.4_all.deb` in the archive. Nothing between v0.56.0 and v0.58.1
touches anything that reaches `public/`.


### v0.58.1 — two defects in the last few releases
Both mine, both from v0.51–0.52, and one of them would have cost an outage.

- **Editing one SRT parameter deleted the others.** The merge was over `rest` —
  the parameters this panel does *not* model — so it kept `nakreport` and
  dropped `latency`, `maxbw`, `rcvbuf` and `streamid`. Changing latency on a
  live stream silently removed its bandwidth limit and receive buffer, and the
  form still looked right afterwards because it re-read what it had just
  written
- **And a check was holding it in place.** Two assertions named the merge
  expression rather than what it had to preserve, so `{ ...rest, ...next }`
  satisfied them exactly while being wrong. Rewritten as outcomes: edit one
  field, the rest survive; clear one, only it goes
- **The hidden-tag count counted the wrong set.** It reported the size of the
  hidden set, which is kept per browser tab and outlives the tags in it — so a
  tag deleted, or simply absent from this tab's vocabulary, still counted, and
  the bar said "2 hidden" with nothing hidden. Counted against the catalogue
  now
- Checked and found sound: the drag reordering at all four boundaries, the
  helper's apply path, and the icon sweep against the classes it dropped
- 2 new checks, 2 corrected


### v0.58.0 — one fault in the audit's tokeniser, fixed
- The `//` comment stripper carried a `[^:]` guard, there to protect `://` in a
  URL. It also refused to strip **any** comment reaching `//` just after a
  colon, and the leftover comment text then ran on to the next apostrophe and
  swallowed whatever lay between — which is how four real functions came to be
  reported as undefined. URLs are protected directly now, by hiding their
  separator across the strip and restoring it after
- 2 new checks, one of them running the stripper on a URL, a plain comment and
  a comment containing an apostrophe

**The load collection is still out**, and honestly so. The tokeniser has a
second fault: with the block present, the transform swallows the middle of the
file — `cpuSeconds` is gone from the output — so something before it consumes a
long span. Narrowed to that and no further; the template-literal stripper is
the next place to look, since it runs after the regex stripper and both handle
backslashes. The block is reverted rather than the gate suppressed, as before.


### v0.57.0 — the pipeline editor regrouped
- **A second set of hidden fields, found the same way.** An audio filter's
  `name` and `params` were rendered for video only — and the audio filter on
  this fleet is `{ type: custom, name: aformat, params: sample_fmts=fltp }`,
  set in WMSPanel and invisible here. Both lines show them now
- **The forwarding flags are one folded question.** Seven or eight checkboxes
  asking the same thing, on a stage with five real fields — they were most of
  what the form showed. Folded, with a count of how many are on, because
  scanning a pipeline what matters is that something is being forwarded, not
  which
- 2 new checks, both reading the fixture

Two invisible fields in two releases, both found by measuring the editor
against a real transcoder rather than reading it. That is the argument for the
fixture: the next one will be found by a failing check instead of by someone
noticing that a setting does not stick.


### v0.56.0 — the pipeline editor, checked against a real pipeline
A working transcoder is now a fixture, and the editor is measured against it
rather than against what it assumed.

- **A field people set was invisible.** A video output on this fleet carries
  `forward_sei_timecodes`; the editor's list did not have it, so it could be
  set in WMSPanel and never seen here. Added, and a check now derives the list
  from the fixture — if an output grows a flag, the check fails rather than the
  field quietly disappearing
- The real shape, written down: `{ status, transcoder }` at the top — a caller
  reading the top level finds two fields and no pipeline — then
  `video_pipelines` and `audio_pipelines` **side by side**, each with its own
  `inputs`, `filters` and `outputs`. Two independent lines, not one pipeline
  with a video half
- `params` is an **array of name/value on an output and a plain string on a
  filter**. Same name, two shapes; the editor already tells them apart, and a
  check now holds it to that, because an editor treating them alike writes the
  wrong one and the transcoder accepts it empty
- 4 new checks, all reading the fixture

The list endpoint carries no pipeline at all — id, name, description, paused,
server, tags, `out_of_process` — which is why the first probe run learned
nothing. The pipeline comes one transcoder at a time.


### v0.55.0 — the transcoder probe

- `nnm-api-probe.mjs` dumps **one whole transcoder pipeline** — nesting and
  field names intact, only leaf values reduced. A shape summary of the top
  level says nothing about which fields appear at which stage, and that is
  exactly the question: the editor currently shows fields nobody has and hides
  fields people set

**The load collection is not in this release, and the reason is the gate.** The
agent side was written and works — `/proc` parsing verified against a live
process — but it makes `audit:shadow`'s sibling, the undefined-reference audit,
report four real functions as undefined. Narrowed to the new block and not
pinned: the audit tokenises this file, and something in the block reads to it
as an unterminated literal, after which every declaration below becomes
invisible.

That is a broken gate rather than broken code — `node --check` passes and the
functions are plainly there. But a gate that fails is either a real defect or a
gate that cannot be trusted, and shipping past it without knowing which is the
one thing this project does not do. The block is reverted rather than the gate
suppressed; the fix is to find the construction, which is a short job with a
fresh look at the tokeniser.


### v0.54.0 — transcoders: the guidance, and tags
Two of the four asked for. The other two are set out below rather than
half-built.

- **The page says where a new transcoder comes from.** WMSPanel's API has no
  method for creating one, so this panel cannot — and without saying so the
  page reads as broken, because every other object here can be created from it.
  Build the pipeline in WMSPanel once, and from here it is viewed, copied and
  changed, which is what the work consists of
- **Tags appear once a server is chosen.** They belong to a server; on the
  all-servers view they would merge the vocabularies of fifteen machines into
  one list where half of it matches nothing on screen. The bar filters the list
  — a row of buttons that highlight and change nothing is worse than no bar
- WMSPanel's own tags and this panel's are kept apart in the row. Merging them
  would offer to remove a tag we cannot remove
- 4 new checks

**Not done, and why.** The structured pipeline view (decoders, filters,
encoders per line) is partly built already in `PipelineEditor` — reworking it
should start from a real transcoder configuration rather than from what the
component currently assumes, the way the playlist work started from a real
`server_playlist.json`. And the load dashboard has no data source: there is no
transcoder statistics method in the WMSPanel client at all, so there is nothing
yet to put on it.


### v0.53.0 — a step that changes where a push goes
- There was a step for what an RTMP Push **takes** and none for where it
  **sends**. The destination is the half that changes between events, and it
  was the half a function could not touch
- **The destination can be copied from a rule that already works.** Typed by
  hand it is six fields including a stream key sixty characters long, and a
  step pushing to a mistyped destination reports success — the rule was
  changed exactly as asked, and the mistake only shows as an empty player
- Copying takes the destination and nothing else. Bringing the source along
  would make it a different step than the one chosen
- The rules are fetched only by the step that can use them: every step
  fetching every family would be one request per step on a function with
  fifteen
- A check asserts the runner has a route for the fields the step writes. A step
  whose fields nothing applies reports success and changes nothing, which is
  the failure this project keeps finding in other shapes
- 5 new checks


### v0.52.1 — the helper beside the form, not under it
- Below the fields it was a second screenful: compute at the bottom, scroll up
  to see what landed. Beside them both are visible, which makes filling the
  fields one action instead of two
- Portalled out of the dialog, because the dialog scrolls its own content — a
  child placed to its left would be clipped by that overflow rather than
  appearing there
- Positioned against the dialog's own centring rather than measured: the
  dialog is a fixed width and centred, so half of it plus a gap is the offset,
  and nothing can drift out of step with it. Checked at 1920, 1400 and 1200 —
  it clears the dialog and stays on screen at each
- Below 1100px there is no room for two columns and it returns under the form,
  where it is cramped and reachable, which beats being off-screen
- 1 new check


### v0.52.0 — the helper moved in, the remarks moved out
- **The SRT tuning helper lives in the stream's own settings now**, folded away
  until wanted. On the tab it could only offer three numbers to copy, because
  it had no stream in front of it — and copying them by hand into a live stream
  is what it was asking for. It fills the fields directly, and touches only the
  three it computes: a calculator has no opinion about a stream id
- It moved rather than being duplicated. Two copies of a calculator drift
- **Technical remarks collect in a tray, top right.** Lines like "64 streams
  matched; 12 more shown from WMSPanel data" are each true and worth having,
  and each pushed the table they described further down the page — on a tab
  with three of them the list started below the fold, and they were read once
  on the first day and never again. Countable, clearable, and out of the way
- Not toasts, deliberately: a toast is for something that just happened and
  then disappears, and these describe a standing condition of the page that is
  wanted on the fifth visit as much as the first. A repeated notice counts
  rather than stacking, and the list is bounded — a page in a loop must not
  grow it without limit
- **One warning stays on the page:** the readings shown belong to a different
  server. That is not a remark about the tab, and a warning filed in a tray is
  one nobody sees in time
- Restructured `JoinNote` so its hooks run before its three early returns. A
  hook placed after one of them runs on some renders and not others, which
  React cannot track — the move to the tray would have introduced exactly that
- The tray degrades to nothing outside its provider: a component that reports
  something must not be why a page fails to render
- 6 new checks. **All four requests from this round are done.**


### v0.51.0 — SRT parameters as fields, and the Raw view removed
- **The parameters were a box of raw JSON**, typed by hand into a live stream:
  `{"latency":"3000","maxbw":"6250000","rcvbuf":"15728640"}`. A misplaced brace
  there is a stream that does not come back, and nothing checked it before it
  was sent. Five named fields now — latency, max bandwidth, receive and send
  buffers, stream id — which is what this fleet actually sets
- **A parameter this panel has never heard of survives an edit.** SRT accepts
  many more than five, and dropping the rest would make editing latency quietly
  change something else
- Values stay strings, because every working stream on this fleet has `"3000"`
  and not `3000` — converting here would send a different thing than what came
  back
- Parameters that cannot be parsed show the text and no fields: offering empty
  fields over an unreadable value would discard whatever is actually set the
  moment anyone typed
- The hardcoded English label went with it
- **The Raw view is gone** — a debug panel from an earlier version of this
  page — along with the state that fed it, which was written and never read
- New `npm run audit:deadimport`, which found four: the two the Raw view left
  behind and two that predate it. An unused import is harmless and invisible,
  which is exactly how a page accumulates the artefacts of its previous selves
- 5 new checks


### v0.50.0 — every verb is a glyph
- Thirty-six text buttons across eleven pages — edit, delete, restart, pause,
  resume, duplicate, history — now draw from the one component, each keeping
  its word as the tooltip and the accessible name
- Only buttons whose entire body is a single translated verb were converted. A
  button whose label is part of a sentence stays a sentence; turning it into a
  glyph would lose what it was saying
- **The first sweep found four of them.** Its pattern forbade braces in the
  attributes, and an `onClick` almost always has them — so every button with a
  handler was invisible to it. Balancing the braces instead found the other
  thirty-two
- **And the sweep broke ten files.** Its check for an existing import looked
  for the bare name and matched the markup it had just written, so ten files
  gained the component and no import — which compiles and throws when the row
  renders. The click gate caught all ten, which is exactly why it clicks every
  button rather than counting them
- 2 new checks: no verb left as a text button anywhere, and every file using
  the component importing it


### v0.49.0 — measured, and one control removed

The probe answered for all six families:

| tab | field | values |
|---|---|---|
| SRT In | *(none)* | `status`: offline ×56, online ×19, **paused ×1** |
| SRT Out | `paused` | false ×44 |
| SRT in Nimble | `paused` | false ×44, `status`: synced ×44 |
| RTMP Push | `paused` | true ×2 |
| RTMP Pull | `paused` | true ×8, false ×2 — and `status` agrees exactly |

- **The SRT In pause shipped in v0.48.0 does not work, and is removed.** Across
  76 incoming objects the API returns twelve fields and `paused` is not among
  them — not even on the one whose `status` reads `paused`. The state exists
  and is not set through the object; WMSPanel's own interface uses a separate
  action route on a session-authenticated host that this panel cannot call. A
  button writing a field the schema does not have is one that silently does
  nothing
- RTMP Pull is what made the rest legible: it carries **both** `paused` and
  `status`, and they agree object for object — so `paused` is the switch and
  `status` is the report of it. SRT In has only the report
- The four families that have the field keep their control, now all drawing the
  same glyph from the same component
- **The probe's first run was wrong in my hands**: it asked for
  `mpegts/incoming` — WMSPanel's own resource name — where the panel serves
  `incoming`, and three families answered 404 in a way that read as "this
  server has none of those". It uses the panel's paths now and names an HTML
  404 as a wrong path rather than an absent family
- 3 new checks; two from v0.48.0 retired, because measurement disproved them


### v0.48.0 — SRT In can be paused after all
- **I was wrong in v0.47.0.** I concluded these objects had no paused state by
  reading our own edit form — which does not show it — and the object carries
  it: WMSPanel's interface pauses these streams and ours reports
  `status: paused` back. Reading our form is not evidence about what WMSPanel
  supports
- The control is there now, writing `paused` through this family's own route.
  What is written to set it is still inferred — the API reference does not
  document it and the UI route is session-authenticated and unusable from here
  — but the inference is safe to act on: the panel re-reads after every action,
  so a field WMSPanel ignores leaves the row unchanged in front of the operator
  rather than failing quietly
- **And a defect found while placing it.** Two rows in that tab gated on
  `{manage && …}`, an identifier the component does not have — it uses `can`.
  That compiles and throws when the row renders, taking the whole tab with it.
  One of them was mine, from the History button in iter19
- 3 new checks


### v0.47.0 — the glyphs everywhere
- The same icons across the object tabs, the playlist source rows and the
  function steps — seventeen call sites, all drawing from the one component, so
  two tabs cannot come to mean different things by the same symbol. Each keeps
  its word as the tooltip and the accessible name
- A check now fails on a glyph written straight into markup, and found one on
  its first run: a delete button in the SRT Out form using `×` where the shared
  component uses `✕`

**No start/stop on SRT In, and this is deliberate.** Its objects have no
`paused` field — the edit form carries application, port, protocol, chunking
and fallbacks, and nothing else. A button sending a field WMSPanel does not
know is a button that silently does nothing, which is the exact failure this
project has spent a week finding in other forms. SRT Out and RTMP Pull have the
field and now use the shared glyph for it.

If pausing an incoming stream is wanted, the question is what WMSPanel offers
for it — worth checking against the API before a control is added, not after.


### v0.46.1 — the names, and verbs as glyphs
- **The name was there and never shown.** A republish rule carries a
  description, editable in its form, and the table displayed only
  `app/stream` — so eighty-three rules were identified by path alone. The name
  leads now, with the path beneath it; a rule nobody named still shows its path
  rather than an empty column
- **Action buttons are glyphs.** Five words per row — switch source, edit,
  restart, delete, and a start/stop — took most of the width of the table,
  leaving the thing each row is about squeezed into what remained
- **The word does not go away.** It is the tooltip and the accessible name,
  positioned off-screen rather than hidden, because an icon alone is a guess
  until it has been learned and some of these stop a broadcast. The glyphs are
  the ones already learned from media players rather than anything invented
  here
- Defined once, in `IconButton`: five actions across several tabs spelled per
  call site is how two tabs come to mean different things by the same symbol.
  An unknown action renders a visible placeholder rather than nothing
- 4 new checks; one from v0.46.0 re-pointed, since it asserted the words that
  are now glyphs


### v0.46.0 — the RTMP tabs, and managing tags
- **Both RTMP tabs filter now**, matched on source, destination and
  description — what someone knows about a rule when hunting for it, not the
  id. A filter was the only difference in how the SRT and RTMP families were
  treated
- **The name leads on RTMP Push.** The id was the first column and is the one
  thing nobody searches by: it identifies a rule to the system, never to the
  person looking for it
- **A push rule can be stopped from its row.** Stopping one was a checkbox
  called "Paused" inside the edit form — three clicks and a save, for something
  done in a hurry. Sent as a whole-object update, because rebuilding the rule
  from the row would drop whatever the row does not display
- **Tag chips are sized for a pointer.** They are the primary filter on every
  object list and were small enough to read as decoration
- **A tag can be hidden without being unassigned.** A vocabulary grows over a
  season and most of it is last month's; deleting takes the tag off the
  streams, which is rarely what someone tidying the filter bar wants. Hidden
  tags stay on their objects and leave the bar, per browser tab — a working
  preference for the afternoon, not one carried across sessions to hide things
  for reasons nobody remembers
- Deleting a tag says how many streams carry it first
- 6 new checks

Two mistakes caught by the gates on the way: a duplicate translation key that
would have silently overridden an existing one, and a guessed helper name
(`removeTagEverywhere` for `deleteTagEverywhere`) that made the delete button
vanish rather than fail — the harder of the two to notice.


### v0.45.0 — when Nimble is not listening on loopback
- Two of three new agents collect statistics and the third reports **"fetch
  failed"**, which names neither the address nor the reason. A Nimble that is
  down, one bound to the external interface alone, and a wrong port all look
  the same
- The agent now says what it tried and why each attempt failed, with the errno:
  `could not reach Nimble from this server — tried http://127.0.0.1:8082:
  ECONNREFUSED`
- **Loopback first, then the address the panel knows the server by.** Loopback
  is what makes "which machine answered" a non-question, and it is right
  whenever Nimble listens there — but a management API bound only to the
  external interface refuses it. The fallback is still the same machine, since
  the agent runs on it, so it cannot reach a different Nimble
- An answer ends the search even when it is an error: asking a second address
  after a server has already replied is asking a question that was answered.
  Only an unreachable address moves on
- The credential travels in the query the panel builds rather than in the base,
  so the fallback path carries it unchanged
- 4 new checks. Agent protocol version 19


### v0.44.0 — reading a list of steps
- Steps are numbered in words — "Step 3", not a bare 3 — with the column kept
  wide enough that they still line up
- **Open steps are spaced; folded ones are not.** The gap exists to separate
  blocks of controls, and a folded step has none — spacing them the same makes
  a scannable list sparse for no reason
- **The preset palette is grouped**: SRT In, SRT Out, SRT in Nimble, RTMP Push,
  RTMP Pull, hot swap, transcoder, other. Twenty-seven buttons in one row is a
  wall to read every time. The grouping comes from each preset's own
  `objectKind`, so one added later lands in its group without anyone
  maintaining a list — and a check fails if a group has no name, because an
  unnamed group renders an empty heading and its buttons vanish
- **The Insert button pulses while a choice is waiting to be applied.** Picking
  a stream changes nothing until it is pressed, and that gap is where the
  patch silently stays as it was. It pulses only in that gap: a button that
  always pulses is one nobody sees after a day. The border reads as active
  without the motion, and the motion stops under `prefers-reduced-motion`
- 5 new checks


### v0.43.1 — variant overrides move with their steps
- **Variant overrides are keyed by step position**, so any change to the order
  or the number of steps silently re-points every override after it. Deleting
  the third of six steps left the fourth variant's values attached to what had
  been the fifth — reported as "drifted from the step", which was true and
  unexplainable — and left an override for a position that no longer existed,
  which is why a variant showed **six values against five steps**
- **Reordering, added in v0.43.0, made it worse.** It re-points overrides
  without changing the count, so nothing looks wrong at all until a variant is
  run against the wrong step
- The keys move with the steps now, on all three mutations: deleting closes the
  gap, reordering swaps exactly two, and a duplicated step inherits nothing —
  a variant names the fields it differs in, and inheriting them would give the
  new step values nobody chose for it
- Functions already carrying stale overrides can be cleaned: **drop the values
  that no longer match any step or field**, keeping the ones that do. They
  cannot be repaired automatically — there is no way to know which step they
  were written for — but removing them is what makes the drift badge mean
  something again
- Keying by a stable step id is the better shape and needs a migration of every
  stored function; this keeps the two in step today
- 5 new checks; two re-pointed at handlers that changed


### v0.43.0 — telling fifteen steps apart
A function of fifteen steps was fifteen identical grey panels, each labelled
with a grey badge reading `action:outgoing:restart`. Scanning them meant
reading every one.

- **The colour encodes what a step does**, not what it acts on. The question
  asked of a long list is "which of these stops something" — and which object
  is already spelled out beside it, so colouring by object kind would spend the
  one signal available on the answer already given. Pause and restart read as
  consequential, resume as safe, a settings change as neutral
- **The header carries the order, the verb and the target**, in that order,
  because that is the order they are looked for. The ordinal has a fixed width
  so the numbers form a column instead of drifting right as the list passes
  nine, and the target — the longest and least predictable part — is the part
  allowed to run out of room
- **Steps fold**, one at a time and all at once. At fifteen the useful view is
  the list of what happens, not fifteen open forms with the one being edited
  somewhere in the middle
- **Order can be changed where the steps are.** Order is what a function does,
  and changing it meant deleting a step and re-adding it further down the page
- 5 new checks


### v0.42.1 — one file at a time
- **The history was not scoped to the file being viewed.** It listed versions
  of every playlist file on the server, so the stopped-streams list offered a
  stream belonging to one file while another was selected — and starting it
  failed with "no version this panel holds contains it", which was true and
  left nothing to do about it
- **The panel lands on a file that exists.** The default name is right for a
  fresh install and wrong for a server that named its file something else, and
  the page then showed an empty state, a history of other files, and buttons
  that could not work. A name differing only in its separator —
  `server-playlist.json` against `server_playlist.json` — is recognised as the
  same intent. An operator who picked a file keeps it
- **A stream that lives in another file says which.** "There is nothing to
  restore" sends someone to rebuild a task that already exists a few lines away
- 3 new checks; one re-pointed at the extended handler


### v0.42.0 — uploads up to a hundred gigabytes
- Raised on **every** limit along the path, not just the first: nginx, the
  spool, and the transfer timeouts. A limit raised in one place and left in
  another produces the same refusal from a different component, which is harder
  to find than the original was
- **Bounded, not removed.** An unlimited upload is one that fills a disk, and a
  panel with no disk left stops answering for every server rather than failing
  one transfer
- **An upload with nowhere to go is refused before it starts.** At this size
  the answer "no" arriving at the end is the expensive one: the bandwidth is
  spent, there is a half-written file to clean up, and the disk it was going to
  fill is shared with the database. The declared size is checked against actual
  free space, with a 2 GB margin — a disk at exactly zero cannot be recovered
  from without someone on site
- Too large and no room are **different answers**: 413 is "never", 507 is "not
  now" and will be right again once something is deleted. Telling an operator
  the wrong one sends them to the wrong fix. Being unable to measure refuses
  nothing — the meter still stops an overlong write
- **The broadcast server refuses what it cannot hold**, before pulling the file
  rather than after. Filling that disk does not fail a transfer: it stops
  encoders writing and takes streams off air, and the transfer would have run
  to completion first to do it
- Timeouts allow hours. A hundred gigabytes over a studio uplink is not
  minutes, and a task expiring mid-transfer throws all of it away
- 7 new checks; one from v0.41.1 rewritten to assert a real limit rather than a
  particular figure. Agent protocol version 18


### v0.41.1 — the 413, the stray text, and one feature removed
- **nginx was refusing every upload before it reached the panel.** There was no
  `client_max_body_size` in the template, so the default of one megabyte
  applied — while the panel itself accepts two gigabytes. A 413 from a proxy
  looks identical to a 413 from an application, which is why this needed a
  screenshot to find. The upload location has its own limit now, and
  `proxy_request_buffering off` so a large file is not written to the proxy's
  disk first and delayed by the length of its own upload
- The limit is written out rather than substituted: the nginx image renders
  this template with envsubst, which does not understand shell-style defaults —
  `${VAR:-2048}` would be left verbatim and nginx would refuse to start. **A web
  container that will not start is worse than a limit that has to be edited**
- New `npm run audit:nginx`: any substitution envsubst cannot render, a missing
  body limit, and unbuffered upload. Verified against both faults
- **"onDup= /> ))}" was my own damage** — a fragment of the old per-item call
  survived the replacement of the source list and rendered as literal text in
  the middle of the editor
- **"Interleave adverts" is gone.** It was never asked for
- 4 new checks; one retired with the feature it described


### v0.41.0 — an editor someone can actually use
The source list was a grid of eight labelled inputs per item — type, path,
duration, total duration, offset, iterations, and two Icecast fields —
repeated twenty-four times down a modal. Every field was equally prominent, so
the two used constantly were as hard to find as the two used once a year, and
there was no way to reorder anything.

- **One line per item**: the type, the file, and the controls. Everything else
  behind a disclosure — those fields are real and occasionally needed, and
  showing them beside the path is what made this unusable
- **Order can be changed.** Drag by the handle, or arrows. Dragging is on the
  handle alone, because a draggable row means every attempt to select text in
  the path starts a drag. Dropping past the last row appends: every other
  target inserts before something, so without it the end of the list is
  unreachable
- **An item can be moved to a neighbouring block** — the thing that was
  impossible before, where a source in the wrong block had to be deleted and
  retyped. The move is asked before it is done, so the button is disabled at
  the ends rather than silently doing nothing
- **A file can be picked from the server or uploaded right there**, and the
  upload fills the path in. Uploading elsewhere and typing the path here is
  exactly how an entry ends up naming a file that arrived under a different
  name. The picker refreshes after an upload, so the next row is not choosing
  from a list one file out of date
- An entry naming a file the server does not have is still marked, as before —
  that guarantee moved into the new component rather than going away
- 6 new checks; two existing ones re-pointed, one because its subject was
  deleted with the old grid

**Coverage, stated:** the click gate does not open the editor modal, so these
controls are exercised by hand.


### v0.40.0 — the upload, and one page instead of two
- **The upload sent the wrong file name.** `upload(file)` shadowed the `file`
  state — the playlist being viewed — so it uploaded the chosen file's contents
  under the playlist's name. It compiles, it runs, and it is wrong in a way
  nobody reads past
- The backend has had a shadow check since v0.25.3, when a destructured `pub`
  shadowed the function that built a response. The same mistake reached the
  frontend by a different route, so **the check follows it**: a parameter named
  after a `useState` in the same component. 59 components, verified both ways
- The control was a `<label>` wrapping a hidden input, which either works or
  does nothing — and "does nothing" was reported as "there is no upload". It is
  a button opening a real input now
- **The page opened on the library and put the server underneath**, showing the
  same subject twice in two mental models and leaving the reader to join them
  up. The server comes first: what is on air is the truth, and the panel's
  stored playlists are material for it — relabelled "drafts", with a line
  saying they affect nothing until deployed
- 4 new checks


### v0.39.1 — seeing it was not the same as being able to touch it
Three faults, all visible on one screen.

- **Every action defaulted to a file name instead of using the chosen one.**
  v0.39.0 passed the name when reading and not when acting, so Stop read
  `server-playlist.json` — which does not exist on this fleet — and reported
  the stream as absent while the page displayed it, from a different file, two
  lines above
- **"Cannot check" was reported as "not there."** The playlist points at
  `/srv/nimble/video`, outside the directory the agent is allowed to read, and
  two entries showed as broken on a server where both files exist. They are
  now said as unverifiable, with the reason: an alarm that is wrong is an alarm
  that stops being read
- **A playlist on the server could be seen and not edited**, because the editor
  works on playlists the panel holds. Importing copies it in, and touches
  nothing on the server — deploying stays a separate act
- 4 new checks; two existing ones re-aimed, one because `deployHandler` is
  declared above the route that calls it and searching from the route name
  found nothing


### v0.39.0 — the file name was a guess, and the guess was wrong
- The playlist on this fleet is `server_playlist.json`. The panel asked for
  `server-playlist.json`. One character, and it reported "no playlist" about a
  server that has had one running for weeks
- The captured file was named with the underscore when it arrived; the hyphen
  came from prose describing it. The written name was taken over the actual
  one, which is the same mistake as trusting a five-entry sample earlier in
  this project
- **The guess is gone rather than corrected.** The agent lists the `.json`
  files in its config directory, and when the requested one is absent the panel
  offers what is actually there — each name a button that switches to it.
  `.bak` files and `nimble.conf` are not offered as playlists
- The chosen name travels with the request. It was being fetched without one,
  so the server default applied and picking a file would have changed nothing
- A listing that fails does not turn "the file is not there" into an error: an
  agent too old to list is still an agent that answered
- 5 new checks; two existing ones re-aimed at the code they meant rather than
  at the first textual match. Agent protocol version 17


### v0.38.3 — the diagnostic had the same fault it was reporting
- v0.38.2 fixed fourteen calls in the panel and missed the fifteenth, in
  `nnm-diag.mjs` itself. So the tool went on reporting the 409 **after the
  fault was fixed** — reporting its own bug as the panel's
- The audit added in the same release read only `frontend/src`, which is why it
  passed. It reads the standalone tools and `backend/tools` too now, and the
  extension they use. 18 calls instead of 17
- Verified both ways, on the tool this time

A tool that can be wrong about the thing it diagnoses is worse than no tool.
That is the second time in this project — the first was `nnm-diag` reporting
"no rate in any point" against a panel that was storing rates perfectly well.
Both times the tool was fixed rather than the finding explained away.


### v0.38.2 — the calls were aimed at the wrong router
- The diagnostic named it in one line: **409, "native control is off while the
  control plane is WMSPanel"**. The playlist panel called
  `/nimble/:id/agent/...` for all fourteen of its requests, and the agent
  routes are mounted at `/api/servers` — so every one landed in the native-API
  router instead, which has a control-plane guard, and was refused
- It looked like a permissions problem, then like a missing playlist, and was a
  wrong prefix. Nothing in a build catches that: both prefixes exist, both
  routers are real, the request is well-formed, and it only shows at runtime on
  a server in a particular mode
- New `npm run audit:prefix`. It reads **where each router is actually
  mounted** from `index.js` and which router declares each `/:id/agent/...`
  route, then checks every call in the frontend against that — rather than
  against a list of prefixes someone would have to keep current. 17 calls, 12
  routes, 25 mounts, verified both ways
- Also from that run: "73 — the rest are disconnected sockets" reads as though
  something is still wrong when 73 of 73 have data. The remainder is named only
  when there is one

**The rest of that run was clean**: all live sockets have a stored series, and
end to end is intact.


### v0.38.1 — a found defect, and four causes told apart
- **The agent reports a missing file politely and the panel was not listening.**
  `GET /config` answers ENOENT with `{ content: null, exists: false }` rather
  than throwing, and that answer fell straight through to the parser, which
  said "empty". So an agent that could not be reached, a server with no
  playlist, and a server with an unreadable one all arrived at the page looking
  alike — and none of them looked like "the playlist is there"
- Content that is neither a string nor a stated absence is now reported as
  such, rather than becoming "empty playlist", which is a different fact
- **The agent says where it looked.** "No such file" is not actionable without
  it: a `CONF_DIR` pointing elsewhere looks exactly like a server that has no
  playlist. Agent protocol version 16
- The page says the four apart, and `tools/nnm-diag.mjs` gained a playlist
  section reaching the same four verdicts — the agent did not answer, it looked
  and the file is not there, it is there and will not parse, or the panel can
  see it
- 5 new checks


### v0.38.0 — reviewing iter19, with the fleet in mind
Three defects, all in the seam between a new panel and agents that are not new.

- **An agent older than v10 would have lost native statistics entirely.** The
  fallback in `nimbleClient` listed the failures worth falling back from and
  missed the one that matters: an older agent has no `POST /nimble` and answers
  "no handler for …", which threw instead of falling back to a direct call. On
  this fleet that is twelve servers. Inverted: falling back is harmless — a
  direct call either works or fails quickly — so it is the default, and only an
  answer that came from **Nimble itself**, directly or relayed, is propagated,
  because asking the same server the same question again would only reproduce
  it
- **The media root was derived from the upload directory.** `dirname(MEDIA_DIR)`
  is convenient and wrong: with `MEDIA_DIR` at `/srv/nimble/media` it yields
  `/srv/nimble`, which contains `conf/` and therefore the agent's own token;
  with `MEDIA_DIR` at `/` it yields the filesystem. A default that widens as
  someone's configuration gets simpler is the wrong shape for a permission.
  Fixed default now, and a root that is obviously too broad is narrowed
- **And the first fix for that was worse than the fault.** Throwing on a bad
  setting means an agent that will not start — and an agent that will not start
  cannot self-update to a fix either, on a machine that by design has no
  inbound route. Someone would have to be sent to it. It refuses the setting
  loudly and carries on
- Confirmed on the way: an unknown route fails fast rather than on a 20s
  timeout, so an old agent makes the panel look old rather than broken; every
  throw added by iter19 is inside a handler and nothing new can abort start-up;
  and the new file passes the check a v9 agent applies before becoming it,
  which is what keeps the fleet able to move forward without a visit
- 6 new checks. Agent protocol version 15


### v0.37.0 (iter19 m8) — all of it reachable
- m1 to m7 were routes and services, and **none of them was reachable from the
  panel**. A capability with no way in is a capability nobody has — which is
  exactly what "I don't see our changes" meant when this epic started. Two of
  them, the resume and the four checks, had no route either
- One panel on the playlists page, ordered by the question an operator arrives
  with: what is running, what is wrong with it, what is available to put in it,
  and what was there before
- Running tasks show entries and distinct files, lap length or run length, when
  the content ends as a **clock time** rather than a duration to add to now,
  and — where `InactivityTimeout` is 0 — that the stream will stay up empty.
  Joins that will stutter are counted as boundaries and listed on demand
- **Start and resume are two buttons.** They do different things and the
  difference is an hour of broadcast; a checkbox beside one button is a setting
  people do not read. Resuming is opt-in on the server side too, and the
  response stops claiming a restart when it resumed
- Stopped streams are recovered from the version history and offered back,
  because otherwise stopping is a one-way door: the definition is in the
  history and nobody digs it out mid-event
- Media upload with a folder, listing, deletion; deploy history with a viewer
  and rollback. Both destructive actions ask first
- **A file body is now sent as a file.** `JSON.stringify` of a Blob is `"{}"` —
  a gigabyte upload would have become 38 bytes and reported success
- The four reads are independent: a server whose media cannot be listed can
  still have its playlist read, and saying "nothing works" when one thing does
  sends the operator looking in the wrong place
- 6 new checks; one from m5 rewritten because m6 made its subject conditional

**iter19 is complete.**


### v0.36.0 (iter19 m7) — four things the panel can say that nothing else does
Each of these answers a question currently answered by watching the stream.

- **Changed behind the panel's back.** The next deploy overwrites without
  asking, and editing the file by hand is how this has always been done here —
  so the change would be lost silently, and noticed only when it stopped being
  in effect. Reported with its consequence rather than as a bare "differs"
- **Joins that will stutter.** Checked at the boundary rather than per file: it
  is the *change* that shows. A playlist of uniformly odd files is fine; one
  odd file among twenty produces two bad joins, going in and coming out.
  Resolution, frame rate, video codec, sample rate, channel count — and a file
  with no audio among files that have it, which is silence rather than an
  artefact and audible even when the picture is fine
- **How long a block runs.** Summed from measured durations, and a partial sum
  is marked partial: "at least 40 minutes" is useful and pretending it is the
  whole answer is not
- **When a stream will fall off air.** A looping block has no end; a finite one
  does, and `InactivityTimeout` decides how long the output lingers after it.
  **Zero means never** — the content ends and the stream stays up, empty, which
  is its own thing worth saying and is what the live file is set to. Tasks
  already finished sort ahead of tasks about to finish: negative is more
  urgent than small, not nonsense to be filtered out
- The probe reads streams and duration in one ffprobe call — the call that
  measures length is already open, and asking twice would double the cost of
  the check that catches a stuttering join. Frame rates arrive as ratios like
  `30000/1001` and are reduced, so two spellings of one rate compare equal
- 9 new checks, all against the live playlist. Agent protocol version 14


### v0.35.0 (iter19 m6) — resuming where it stopped
- The file cannot say where playback is. Nimble knows and does not expose it,
  so the position is **reconstructed** from three things the panel does know:
  when the task started, when it was stopped, and how long each file runs
- Rebuilt using grammar Nimble already has — entries already played are dropped
  from the first block and the one being resumed carries an `Offset`. Nothing
  here depends on a feature that does not exist
- **The resume lands before the computed point, never after.** Drift is
  inevitable — a transcoder restart, a container duration disagreeing with its
  content — and the two errors are not equal: land early and the audience sees
  a few seconds twice; land late and they miss content that will never be
  shown. Three seconds of insurance against arithmetic that cannot be exact
- **One unknown duration disables the resume entirely.** Guessing past it would
  put the resume in the wrong file, which is worse than not resuming: a restart
  from the top is at least what the operator expects
- A block with a `Start` time is a schedule, not a queue, and is left alone —
  resuming into it would move the schedule. A looping block wraps: 400 minutes
  of this playlist is three full laps and part of a fourth
- The result is marked as an estimate. Presenting it as exact is the only real
  mistake available here
- **The agent gained its first external process**, and it is narrow because of
  that: `execFile`, so there is no shell and a file name containing a semicolon
  is an argument rather than an instruction; a constant command with only paths
  as arguments; a timeout; and confinement to the media root. A missing
  ffprobe is told apart from a missing file by errno rather than message text,
  and reported once rather than once per file
- 10 new checks. Agent protocol version 13


### v0.34.0 (iter19 m5) — stop and start, and what they cannot do
- **There is no pause in this format**, and Softvelum's own grammar confirms
  it: a playlist declares what to play and, per block, when to start — `Start`,
  `Offset`, `Duration`, `InactivityTimeout`, `MaxIterations` — and nothing that
  means "resume". Playback position lives inside Nimble and is not expressible
  in the file
- So stopping is removing the task and starting is putting it back. A stopped
  stream that is restarted **begins at the top of its block**, and the response
  says so rather than leaving a Play button to silently rewind an hour of
  broadcast
- Stopping removes exactly one task and disturbs nothing else: another
  operator's tasks, the sync interval and any key this panel does not model all
  survive. A stop is not an excuse to rewrite the file
- Starting restores the task **in the position it occupied**, whole. Order
  matters less to Nimble than to the next person reading the file, and a task
  that reappears at the bottom looks like a new one
- The definition is recovered from the version history rather than a copy kept
  for the purpose — nothing extra to store, and no chance of a stored copy
  drifting from what was really running
- **Both are deploys.** They call the deploy body, so they carry the same
  checks as any other write. A second way to change a live config would be a
  second way that skips them, and this is the path most likely to be taken in a
  hurry
- 7 new checks

**What would be needed for a true resume:** the file can express an `Offset`
per entry, so a resume could be computed — but only from media durations the
panel does not have. Probing them on the agent would make it possible; it is
not guesswork that can be skipped, since being wrong means resuming into the
wrong file.


### v0.33.0 (iter19 m4) — deploying, and being able to take it back
- The playlist file is a live broadcast config: writing it takes effect the
  moment it lands, because Nimble watches the directory. There is no staging
  step and nothing reports back that what it read was what was meant. So
  everything checkable is checked **before** the write
- **Three refusals, and they are different in kind.** A malformed file is
  refused outright, whatever anyone says. A source the server does not have is
  refused unless forced — it is recoverable, and an operator may know the file
  is arriving in a minute. An **empty playlist** is refused too: it is legal
  JSON that stops every stream on the server, and a plausible accident from
  deleting the last task
- An unreadable media list is not a licence to skip the check. The check
  failing and the check passing must not look the same
- **What is being replaced is recorded before it is replaced**, including what
  was on the server before the panel ever wrote to it. Without that the first
  rollback has nothing to go back to — and the first deploy is the one most
  likely to need undoing
- **Rolling back is deploying.** The rollback route calls the deploy body
  rather than reimplementing it: a separate path would be one that skips the
  checks at the exact moment they matter most, which is when something has
  already gone wrong
- A forced deploy is remembered as forced, with the paths that were missing at
  the time. It explains an outage nobody could otherwise account for
- Full content is kept per version, not a hash. A hash tells you the file
  changed; it does not let you put back the one that worked at 3am. The version
  list omits the bodies — thirty playlists is a lot to send to a browser that
  wants a list
- 9 new checks


### v0.32.0 (iter19 m3) — the editor knows what the server has
- The structural editor already existed; what it did not have was any idea
  which server it was writing for. A source was **free text**, which is how a
  path to a missing file gets into a playlist — and the only way to find out
  has been silence on air
- Pick a server and the editor gains three things: a **file picker** listing
  what that server actually holds, a **warning on any entry** whose path is not
  among them, and a line saying what is on the server now — task count, entry
  count, and how many of its entries point at files that are not there
- **Editing still never writes to a server.** It reads, so it can warn.
  Deploying stays a separate act: a page that can save and deploy in one motion
  is a page that deploys by accident. A check asserts every write in the
  builder goes to the panel and none to an agent
- **Interleave adverts**, which is what the live playlist was built with by
  hand: three adverts before every match, 24 entries for 8 matches. Doing that a
  row at a time is where an advert goes missing or a match repeats, and neither
  shows until it airs. Applying it again replaces the previous insertion rather
  than multiplying it
- 4 new checks, one of them running the interleave and comparing the result
  against the shape of the real file


### v0.31.0 (iter19 m2) — media, in the folders operators actually use
- The upload path was already built in iter12 — spooled by the panel, fetched
  by the agent with a checksum, tracked with retries. What it could not do was
  put a file in a folder: a media name had to be a bare file name
- **One folder level is allowed now**, because that is how this work is
  organised: the live playlist separates `adds/` from `matches/`. Flattening
  would either collide names or force everything into one heap. Two levels are
  refused — a depth limit that is a number invites argument about the number,
  and one is what the work needs. Absolute paths, `..`, and anything escaping
  the root still fail
- The folder is created on upload rather than required to exist. Making an
  operator log in and `mkdir` first defeats the point of uploading through the
  panel
- The listing reaches one level down to match, and is sorted — a file filed
  under `adds/` would otherwise vanish from the panel the moment it landed
  there, and a listing should not reshuffle itself between refreshes for
  reasons that are the filesystem's
- **A file the live playlist names cannot be deleted.** Tidying up media
  happens between events and the consequence lands hours later in the middle of
  one: the entry stays in the playlist and plays silence, and nothing else in
  the system would report it. `force=1` overrides, as an explicit act
- The reference check compares **full paths**, not file names: this fleet's
  playlist holds two different `match_1.mp4` in different directories, and a
  name match would block deleting either because of the other. A playlist that
  cannot be read is not permission to delete either — the check failing is
  reported rather than passed
- 6 new checks. Agent protocol version 12


## iter19 — playlists
### v0.30.0 (m1) — what is actually on the server

**Where the media goes, decided.** One shared library per server, with the
subfolders the operator already uses — not a folder per playlist. The working
file settles it: `reklama_1,2,3` appear eight times in one playlist and will
appear in the next event's too. A folder per playlist would mean uploading the
same advert again for every event and, worse, duplicating the truth — replace
the advert and it stays old everywhere else. Playlists reference files; they do
not own them. Two rules follow: deduplicate on the sha256 the agent already
computes, and never delete a file a live playlist still names.

- **Read-only, and deliberately.** An operator about to change a live playlist
  should be able to see its current state without looking being able to alter
  it
- Built against a file from a running server. Two things it settled that would
  have been guessed wrong: the playable items are nested one level deeper than
  they look (`Tasks[].Blocks[].Streams[]`), and **entries and distinct files
  are different numbers** — 24 entries describe 9 files, because three adverts
  are interleaved between every match. Reporting one number for both would
  misdescribe the playlist whichever was chosen
- `MaxIterations: 0` is reported as looping. An operator reading "0 iterations"
  would conclude the opposite
- **Every path the file names is checked against the filesystem.** An entry
  pointing at a missing file plays silence, and the only way to find that out
  today is to watch the stream. The agent gained a `POST /media/stat` for it,
  confined to the media root — reads reach the whole tree because a working
  playlist points at directories the operator made by hand, while writes stay
  where they were
- The panel's copy and the server's are compared as parsed structure, so
  whitespace and key order are not reported as changes. Keys the panel does not
  model are preserved rather than dropped
- A missing playlist is a state, not a failure: a server that has never had one
  is the normal starting point
- New `npm run test:playlist`: 9 checks, all against the live file kept as a
  fixture. Agent protocol version 11


### v0.29.1 — five more places called node by bare name
- The download worked, the unpack worked, the install reported success — and
  the script died two lines later with `node: not found`. Making Node optional
  in v0.29.0 was only half the change: five places went on calling `node`
  directly, including a version gate that had become redundant the moment
  `node_ok` started choosing the binary
- Every one of them was written when Node was a prerequisite, and none was
  wrong at the time. That is exactly why re-reading the diff does not catch
  them
- New `npm run audit:installer`, ahead of the test suite. It **generates the
  installer and inspects it** rather than trusting a review: any use of node by
  bare name, any resolution from PATH outside the one line that discovers a
  system Node, and a unit that does not run `$NODE_BIN`. It also fails if it
  finds suspiciously few uses of `$NODE_BIN`, since that means the check has
  stopped matching the script rather than the script having become clean
- Verified both ways, including a false positive on the discovery line itself,
  which was narrowed rather than suppressed


## iter18 — the installer brings what it needs
### v0.29.0 — Node is no longer a prerequisite
- The SSH install exists so nobody has to touch the server, and it failed with
  "node is required; install it and re-run" — putting the work back on the
  operator for something the installer can do itself
- **Node is fetched into the agent's own directory**, not installed
  system-wide. A live broadcast server's toolchain is not this agent's to
  change, and a system-wide Node can collide with whatever is already there.
  Nothing outside `/var/lib/nnm-agent` is touched, and removing the agent
  removes it
- A system Node that is new enough is used as it is — downloading one anyway
  would be changing a machine that needed nothing. Then a Node this agent
  installed earlier. Only then a download
- **The download is verified against the release manifest** before it is
  unpacked: an interrupted or substituted file fails loudly rather than being
  installed. The lookup is an exact field match rather than an anchored grep —
  the manifest lists several formats per architecture, and the grep worked only
  because a trailing dollar before a quote happens to be literal in sh, which
  is too subtle for something whose failure mode is installing the wrong file
- An architecture with no official build says so and asks for a manual install,
  instead of downloading nothing and failing later
- The systemd unit runs the Node that was settled on. `command -v node` in the
  unit would find a different one, or none, once systemd's PATH differs from
  the installing shell's
- 7 new checks


### v0.28.3 — spacing
- **Adjacent buttons in a table cell had nothing holding them apart** — only
  the whitespace between JSX elements, which collapses the moment they wrap,
  leaving "Delete" flush against "Edit" and stacked. Found on the Roles and
  Servers pages; there are nine such cells in the panel, so the fix is a rule
  rather than two edits
- Scoped to table cells on purpose: in a `.row` the flex `gap` already spaces
  them, and a margin there would add to it and give two different spacings on
  one screen
- The stream history dialog: the tile grid started immediately under the range
  picker, so the first row read as part of the toolbar. It has room above and
  below now, the tiles are a little wider and better padded, and each tile's
  heading is clear of its chart
- New `npm run audit:spacing`, verified both ways. It checks the rule exists
  rather than every call site, because the rule is what makes the next cell
  right without anyone having to remember


### v0.28.2 — the axis labels fit
- The clipping was not the window's width: the labels were being cut **inside**
  the chart. The y-axis gutter was a fixed 58px, which fitted bare numbers and
  stopped fitting the moment v0.28.1 gave the labels units — "0.06 Mbps" and
  "22.89M pkt" do not. Widening the modal would have widened the plot and left
  the gutter exactly as short
- A clipped label is worse than a missing one: "06 Mbps" reads as a different
  number rather than as a truncated one
- The gutter is measured from the labels uPlot is about to draw, per redraw, so
  it follows the data instead of a guess about it — narrow for percentages,
  wide for packet counts — and is capped so one enormous label cannot eat the
  chart it belongs to
- The chart dialogs are wider too, as asked, and now bounded by the viewport.
  The existing wide sizes were fixed pixel widths that ran off the side of a
  laptop
- 3 new checks


### v0.28.1 — units on the charts
- `formatValue` only ever knew `bps`, so everything else fell through to a bare
  figure: RTT read "9.81", a byte total read "29,000,000,000", and the reader
  had to guess which. It handles milliseconds, megabits, bytes, packets and
  percentages now, in the magnitude the counter has reached — 12.9 GB is
  legible, 12 900 000 000 is not; 22.89M packets is, 22 890 894 is not
- Every tile carries its unit in the heading, and the single-metric view
  derives one from the metric name rather than falling back to an empty string
- **Nimble's rates stay in megabits.** It reports them that way and converting
  would invite exactly the confusion this change is fixing. SRT windows are
  labelled in packets, which is what SRT measures them in
- **Counters that only climb are marked as such.** `packetsLost` and
  `bytesReceived` run from the moment the socket connected, so a rising line
  means "it has happened", not "it is happening" — the slope is the reading and
  the height is not. The expanded view says what the shapes mean: flat is
  almost no loss, a step is one bad minute, a drop to zero is a reconnect
- 5 new checks


## iter17 — the full SRT picture
### v0.28.0 — tiles, and a chart that says what it is showing
- **All seventeen columns WMSPanel shows have been in the series all along.**
  The gap was never data: the collector stores every numeric field an entry
  carries, and the History dialog drew three charts out of eighteen metrics.
  What follows is a display change, not a collection one
- Eight tiles now, grouped by the question each answers rather than by where
  Nimble puts the field — packets lost, dropped and belated share one tile
  because they answer "how is the link" once, where three tiles would ask it
  three times. Click one and it opens full size
- Tiles rather than a stack: eight charts one under another is a scroll through
  everything to reach the one that matters; side by side they are compared at a
  glance
- **Every chart in the panel now says what is under the cursor** — the moment
  and the value, for each series. A reading without its moment is half a
  reading. uPlot's own legend is a table under the chart, which is too much
  furniture for a 92px tile, so it is a small label that follows the cursor and
  flips at the edge to stay inside the plot
- One request feeds every tile; eight would be eight aggregations over the same
  documents. A tile with no readings is not drawn — a receiver has no send
  counters, and empty axes are noise
- 5 new checks


### v0.27.3 — that a socket exists is a measurement
- Both of the previous run's contradictions are gone: `healthy`, and reads go
  through the agent. What remained was two subjects with no stored series —
  **the same two ids in four consecutive runs**, so not a timing artefact
- `add` skips a sample whose metric set is empty, and these two sockets report
  nothing numeric at all: no stats block, not even a retry counter. So they had
  no series whatever. The panel could see them and the history said "this
  stream has never appeared" — both statements true, and useless together
- Every socket now records `present`, and `connected` where the state says so.
  The absence of readings becomes a reading, which is what makes the difference
  between "the collector never saw this" and "it is watched and nothing has
  flowed through it" — sentences an operator acts on differently, and the
  History dialog now uses both
- 3 new checks


### v0.27.2 — a busy agent is not an unclaimed one
- `end to end is intact`, 85 points with 85 rates. The pipeline is healthy —
  and the run surfaced two things that disagreed with it
- **`polling-not-claimed` fires on every healthy agent.** The rule — a task
  still queued although the agent has polled since — was written when tasks
  were rare. Since iter16 the panel asks the agent for every native read, so
  tasks arrive continuously, and at any instant there is one queued a moment
  ago and a contact a moment before that. A signal that fires constantly is
  worse than no signal: it makes the one that matters unreadable. A task now
  has to outlive a full poll cycle before it counts as passed over
- **The diagnostic reported "a direct call" for an agent serving every read.**
  It inferred the transport from the diagnosis code; the panel routes on
  freshness of contact. Two different questions. It uses the panel's rule now,
  and reports a poor diagnosis separately rather than conflating the two
- 5 new checks. Two existing ones needed widening: their gaps were shorter than
  the new window, and one had to stay inside the polling window or a stronger
  verdict won and it tested the wrong thing


### v0.27.1 (iter16 m4) — control and collection are different things
- The control-plane notice sat above **every** tab in WMSPanel mode, including
  the ones where nothing is disabled. So it read as the explanation for
  whatever looked wrong on screen — and for a long stretch of this epic it was
  taken for exactly that: the reason the live columns were empty. They were
  empty for unrelated reasons, and statistics were being collected the whole
  time
- It appears only when native tabs are actually being withheld, and it **names
  them** instead of describing them in the abstract. "Native sections are
  disabled" leaves the reader to work out whether the thing they are missing is
  one of them
- And it says the other half out loud: this is about control; stream
  statistics are collected in either mode, and the bitrate columns and History
  work the same. Repeated where the collector reports on its own health, since
  that is where the question arises
- The guard's own message said "the native API is disabled" — true of control,
  false of everything else, and it reached the browser for reads too until
  v0.24.1, where it looked exactly like an explanation for missing statistics.
  It now says which half it is refusing
- 4 new checks

**iter16 is complete**: live columns (m1), per-stream history (m2), native
reads through the agent (m2b), Charts as a summary (m3), and this.


## iter16 m3 — Charts as a summary
### v0.27.0 — everything on one screen
- The Charts tab drew one subject at a time, which answers the follow-up
  question rather than the opening one. It opens on **Everything**: a card per
  stream, its current rate, and the shape of the last hour. Picking one stream
  is still there, one click away, and clicking a card goes straight to it
- **One request, not forty.** A new `/stats/:id/multi` returns many subjects in
  a single pass over the same bucketing the single-subject endpoint uses;
  asking per subject would have been forty round trips on open and forty more
  on every refresh, with the page painting in forty jerks. Capped at sixty
  subjects and 120 points each — these are drawn small
- **Idle sockets are counted, not silently dropped.** Half of this fleet's
  seventy SRT subjects are disconnected sockets holding a retry counter.
  Drawing them all buries the ones worth looking at; hiding them without saying
  they exist is worse, so the line reads "carrying media: 34 of 70" with the
  rest one click away
- Busiest first, because a screen that cannot hold everything should hold the
  traffic
- The rate metric is discovered from what each subject holds, never named here.
  Naming it has cost a release twice in this epic, and a configured ceiling
  like `mbpsMaxBandwidth` is excluded — it is a setting, not a reading
- 6 new checks. One failed first time and it was the check: it forbade a `map`
  near the request, and the subject list is legitimately built with one inside
  it — corrected to count the calls


### v0.26.6 — the diagnostic contradicted itself
- **iter16 m2 is done**: `end to end is intact`, 64 points with 60 carrying a
  rate, and the per-stream charts draw
- The second run showed the tool disagreeing with itself — "metrics on record:
  1 — retryCount", "none of them looks like a rate", and then "with a rate: 85"
- Two defects, both mine. It picked a socket on `bps > 0`, which an idle SRT
  socket satisfies with a few tens of kbit/s of handshake traffic, so it
  followed a stream with nothing to draw. And when the subject held no rate
  metric it fell back to counting whatever was there — a retry counter — and
  labelled the result "with a rate"
- It uses the same no-media threshold the panel does, and when a subject holds
  no rate metric it says exactly that instead of counting something else
- 2 new checks

**Still open, small:** two live sockets have no stored series, both senders and
one no longer carrying. Everything else pairs. Worth a look, not worth holding
the milestone for.


### v0.26.5 — the last two gaps
- The dot fix worked: **70 subjects stored, 50 of them with 18 metrics**, up
  from none. Bitrate, RTT and reconnects draw
- **The diagnostic was lying.** It hardcoded the dotted metric names and so
  reported "no rate in any point" against a panel that was storing rates
  perfectly well. It asks the panel what a subject actually holds now and
  picks the rate from that — a tool that can be wrong about the thing it
  diagnoses is worse than no tool. A configured ceiling like
  `mbpsMaxBandwidth` is excluded: it is a setting, not a reading
- **The SRT endpoints are asked in the same order on every tab.** They were
  ordered per tab — receiver first for SRT In, sender first for SRT Out — and
  the dedupe keeps whichever arrived first, so a socket present in both lists
  became `srt-receiver:X` on one tab and `srt-sender:X` on the other. Two
  subjects for one socket, and which tab you opened decided whether its history
  was there. The collector asks receiver then sender, always; now so does the
  route
- 2 new checks


### v0.26.4 — a metric key with a dot in it cannot be stored
- The diagnostic named it in one run: 42 subjects stored, **none** with
  anything but `retryCount`, and 33 live sockets with no series at all — the
  ones carrying data
- `metrics` is a mongoose `Map`, and **MongoDB forbids a dot in a map key**. So
  `stats.link.rtt` made the whole sample fail to validate and the write was
  lost. Only sockets carrying nothing survived, because a disconnected entry
  flattens to `retryCount` alone and has no dot in it. Every socket worth
  charting was discarded, silently, for as long as SRT collection has existed
- Metric names are joined with `_`. That is the fix rather than a workaround: a
  key that cannot be stored is not a key. A source field containing a dot is
  rewritten too
- The reader was asking for the dotted names, which matched nothing and looked
  exactly like a stream that had never reported
- 3 new checks, and two existing ones updated because their subject changed.
  One of the new ones needed an async-aware runner: a synchronous `check`
  handed an async body reports success without having checked anything


### v0.26.3 — a diagnostic that needs nothing to be true first
- The in-image tool could not be launched: the image had not carried it, and
  then the compose service was not called `api`. A diagnostic that is hard to
  start is one nobody runs, and each failed attempt costs more than the answer
  was worth
- `tools/nnm-diag.mjs`: one file, no dependencies, nothing to install. It talks
  to the panel over the same HTTP API the browser uses — no container, no
  database, no assumptions about service names. Copy it anywhere with Node 18
  and run it
- Five sections in order, ending in a verdict that names the link that is
  short: settings and transport, live readings, what is stored, whether the
  live sockets and the stored series agree, and one carrying socket followed
  end to end
- The comparison in section 4 is the one that matters for the symptom reported:
  a socket carrying data whose series is absent is printed by name, with
  "(carrying data)" against it
- Read-only, and it says plainly that a two-factor account cannot be used
  rather than returning an opaque 401
- `tools/README.md` explains all four tools and which to reach for first


### v0.26.2 — the tools were not in the image
- The command handed over in v0.26.1 could not have worked: the Dockerfile
  copies `src` and nothing else, so `tools/` never reached the container.
  Instructions that are wrong cost more than a missing feature — the person
  follows them, gets an error, and then doubts the diagnosis as well as the
  tool
- `tools/` ships now. It is read-only, unreachable over HTTP, and needs the
  same database and credentials the service has, so inside the image is the one
  place it can usefully run
- New `npm run audit:dockerfile`, ahead of the test suite: a top-level
  directory in the repository that no `COPY` brings into the image. `tests/`
  and `scripts/` are named as deliberately absent rather than inferred, so the
  check stays quiet about them and loud about anything new
- `pipeline-check.mjs` run without an argument now lists the servers with their
  ids, instead of printing a usage line and leaving the reader to go and find
  one


### v0.26.1 — walking the pipeline instead of guessing at it
- The agent route works: 63 of 76 streams matched, live columns filled, rates
  and RTT and loss where a socket carries data
- **"Only retryCount" is not a bug.** A disconnected socket has no `stats`
  block at all, so a retry counter is genuinely everything there is to record —
  and the subjects on the Charts tab showing nothing else are exactly the ones
  the table marks "нет сигнала". Verified against the capture: connected → 18
  metrics, disconnected → one
- **"ok, 60 subjects" reads as health and is not.** Sixty disconnected sockets
  make sixty subjects that hold a counter and nothing to draw, and the charts
  are then empty for a reason the summary just called fine. The report counts
  subjects *with data* separately and says plainly when there are none
- New `backend/tools/pipeline-check.mjs`. There are six links between a socket
  on a Nimble box and a point on a chart, and a break in any of them looks
  identical from the browser. It walks them in order — settings and transport,
  what Nimble returns, whether each entry yields an identity, what is stored,
  whether live entries and stored subjects agree, and one carrying socket end
  to end — and names the link that is short
- 3 new checks


## iter16 m2b — native reads through the agent
### v0.26.0 — the panel stops dialling servers
- **The panel was calling Nimble directly.** That predates the reverse
  transport: the collector was written in iter9, the "agents call the panel,
  never the reverse" rule arrived in iter12 and was applied to logs, media,
  tasks and health — and this one path was never revisited. It is why a server
  on the studio LAN could not work at all: the panel is remote and cannot route
  to 192.168.200.15
- Native **reads** now go through the agent, which already talks to the panel.
  Writes stay direct: control is rarer and watched, and putting a long-poll
  cycle between an operator and the change they are waiting for is a bad trade
- **The agent fetches loopback**, and that removes a whole class of confusion
  for free. A mismatched server record — one address in the record, a different
  machine behind it — cost this project a dozen releases. Through the agent it
  is impossible by construction: an agent can only answer for the Nimble it
  lives with
- The proxy accepts `/manage/...` and nothing else. The task already comes from
  an authenticated panel, but a proxy that forwards anything is one somebody
  eventually points elsewhere
- A silent agent is not waited on: after ninety seconds without a poll the
  direct call is tried instead, which fails quickly rather than hanging on a
  task nothing will claim. Servers without an agent are unaffected
- Agent protocol version 10
- 6 new checks. The undefined-reference audit produced a false positive on
  `AbortSignal` — a Node 22 global it did not know — and was corrected rather
  than worked around


### v0.25.15 — ports repeat across machines, ids do not
- The wiring check added in v0.25.14 stayed silent on the very case it was
  written for. It counted **ports**, and the machine the panel is reaching has
  sockets on 35001-35005 while this server's own SRT Out objects use those same
  numbers — so it found an "overlap" between two unrelated machines and said
  nothing
- It compares **WMSPanel object ids** now, which belong to exactly one server.
  Against the real captures: reaching the wrong machine gives an overlap of
  zero and the message fires; reaching the right one gives two and it stays
  quiet
- A build that reports no `setting_id` at all now gets no verdict rather than a
  wrong one — with nothing to compare, a zero would accuse a correctly wired
  server
- **The message names the address actually being polled.** A server record
  carries several addresses and the operator has no way to know which one the
  native calls use — here it was one WMSPanel had assigned rather than the
  machine's own
- 3 new checks; two existing ones corrected — one named the old cache, and one
  bounded its search by a character count just short enough to miss the code it
  was looking for


### v0.25.14 — two machines behind one server record
- **The answer was already in the data.** Every subject the panel collects
  appears in the first dump and **not one** appears in the probe run on the
  box. And the probe's ports — 18001-18006, 17801 — are exactly the ones the
  SRT In tab lists. So the probe ran on the machine WMSPanel calls "Сердце
  Пальмиры", and the panel's native URL reaches a different one
- Nothing was wrong with the join, the identity, the envelope or the key
  selection. The native API address and the WMSPanel server mapping point at
  two different machines
- **The panel says so now.** No overlap on one tab is normal — those objects
  live elsewhere. No overlap anywhere on the server is a different claim, and
  that is the one that went unstated for a dozen rounds. It is checked against
  every family's ports, cached for two minutes, and a failure of that check
  cannot empty a table
- 3 new checks, including the deduction itself against both captures


### v0.25.13 — the release tag, and diagnostics out of production
- **`v.1.3.5` broke the release.** A Docker tag may not begin with a separator,
  so stripping only the leading `v` left `.1.3.5` — and it failed on the very
  last step, after everything before it had run. The workflow strips the `v`
  and any separator after it, and **refuses a tag that still does not yield a
  usable version, on the first step** rather than the last
- **The investigation is out of the production path.** Shapes, samples,
  identifier sets and hardware fingerprints were being shipped inside a
  response polled every ten seconds and rendered into the page. They cost bytes
  on every poll and put server internals on a screen, for a question asked
  twice a year
- It is all still available, and better: `backend/tools/join-report.mjs`, run
  inside the API container where the database and the WMSPanel credentials
  already are. It reports which machine answered, each endpoint's count, the
  full-set overlaps of identifiers and ports, what the join chose and why, and
  five entries from each side — with addresses reduced before printing
- The panel keeps the four sentences an operator acts on: nothing came back,
  came back and did not line up, partially matched, or these are different
  streams entirely
- Five checks retired because their subject moved; three added on the tool


### v0.25.12 — which machine answered
- The measurement settled it, and not where I was looking. **The panel and the
  probe see different sockets.** Run on the box, the probe returned
  `setting_id: 6a18bf52…` on ports 18001-18006; the panel gets `6a1963…` on
  ports 35001+ from the same endpoint, and not one id from either list appears
  in the other
- Two disjoint sets from one endpoint can only mean two different Nimble
  instances — and nothing in the panel said which one it was reaching
- The diagnostics now name it: the URL that answered, its core count, RAM and
  GPU model. Enough to tell two servers apart at a glance, and nothing that
  identifies a person or a stream. A failed status call does not take the
  readings with it
- 3 new checks


### v0.25.11 — measuring instead of sampling
- Collection is working: the Charts tab now lists `srt-receiver` subjects that
  did not exist before. They carry only `retryCount` because that is all a
  **disconnected** entry has — no `stats` block, nothing else to record
- **Subjects have readable names now.** `srt-receiver 6a1963109aac8647b52d1448`
  is not something to act on. The collector cannot resolve it — one WMSPanel
  call per ten-second sample would spend the daily budget by lunchtime — so it
  is resolved on read, cached for two minutes, on a page a person opened. The
  direction is kept, and a failed lookup leaves the list intact
- **The identifier overlap is measured over the full sets.** Two five-entry
  samples failing to overlap is what sent this down a wrong path for several
  rounds; the diagnostics now report how many of the object ids appear as
  `setting_id`, and which ones, alongside the port figures already there
- Verified against the probe: the join **does** pair the real data — two of
  three, on entries and objects taken from the live server. So a zero in the
  panel is no longer attributable to the algorithm, and the next screenshot
  will say which set is short


### v0.25.10 — the envelope
- The probe answered it in one run. **Nimble's SRT endpoints reply
  `{ SrtReceivers: [...] }` and `{ SrtSenders: [...] }`** — and the collector's
  list extraction matched a fixed set of key names (`streams`, `sockets`,
  `stats`, `rules`) which did not include them. It therefore recorded **nothing
  at all** for SRT, silently, while the same data reached the live table
  through the route's own, more forgiving, copy of that function
- That is exactly what the history dialog kept saying: the server *is*
  reporting — other groups — and this stream never appears
- There is one `entryList()` now, shared. Two implementations of "find the
  list" disagreeing was the whole defect, and it is the third time in this epic
  that the same relationship was answered twice in two places
- **`setting_id` is the WMSPanel object id after all.** The probe shows three
  overlaps in samples of five apiece. I asserted it, then doubted it on the
  strength of two non-overlapping five-entry samples, and built a port-based
  fallback on that doubt. The fallback stays — it is right for entries with no
  `setting_id` — but the doubt was mine and unfounded
- 4 new checks, against the probe output kept as a fixture


### v0.25.9 — a probe instead of another guess
- The live join still does not pair the SRT In rows, and I have now been wrong
  about this four times in a row: which endpoint holds which family, what an id
  looks like, which key is strongest, where the rate lives. Each guess was
  plausible, each correction cost a round trip, and the last screenshot shows
  the panel saying "no live socket" beside a stream WMSPanel has full SRT
  statistics for
- So: `tools/nimble-probe.mjs`, run on the Nimble box. It asks every endpoint
  that could carry stream statistics — including ones this build may not have,
  since knowing what is absent is half the map — and writes down the shape,
  the counts, every id-ish and port-ish field wherever it sits, and the numbers
  whole
- Addresses are reduced to their first three octets before anything is written.
  Ids, ports and numbers are kept, because they are the point: what comes out
  is enough to build a join on and not enough to be a leak
- Verified against the capture already in hand rather than only compiled


### v0.25.8 — one answer to "which stream is this"
- Stepping back was the right call. **The history could never have worked**,
  however well the live join performed: the collector keyed each series by
  Nimble's own identifier while the dialog asked for one built from the
  WMSPanel object id — two independent answers to the same question, in
  different id spaces. So the columns could be right and the charts empty, for
  ever, which is exactly what was happening
- There is one `entryIdentity()` now, shared by the collector and the join, and
  **the subject travels with the reading**: the endpoint that did the pairing
  says which series the row's data is in, so the browser no longer derives one
  of its own
- The series label comes from the endpoint that answered rather than being
  inferred from the presence of a `recv` block — the endpoint is known, because
  that is the code that called it
- A row with no live socket says so instead of showing an empty chart and four
  possible reasons
- The first cut of the shared identity threw away `id` outright, and the
  collector suite caught it: some endpoints return a stable id there. What has
  to be excluded is the **socket pair** specifically, whose source port changes
  on every reconnect
- 5 new checks; one from m2 rewritten to assert the behaviour rather than the
  line that used to hold it


### v0.25.7 — the key that pairs the most wins
- WMSPanel's own SRT stats for `72.56.79.88:17802` prove Nimble holds readings
  for an SRT In object at exactly that address, so the data was there and the
  join was not finding it
- **The rule was "first key to match anything wins"**, on my theory that the
  order encoded how strongly each key identifies a stream. One stray match on
  an earlier key then stopped a later one from ever being tried — and the
  result was indistinguishable from "these are different streams", which is the
  conclusion I drew from it. The key that pairs the **most** objects wins now,
  ties broken by order so a name still beats a port
- **The diagnostics misled me too.** The port lists were truncated to twenty of
  sixty-one, which reads as the whole set — and that is how "no overlap" got
  concluded from a sample that had not reached the overlap. They lead with
  counts and the actual overlapping ports now; the samples are labelled as
  samples
- 4 new checks


### v0.25.6 — several sockets, one stream
- The diagnostics settled both questions. **SRT Out matches** — its objects are
  the 35001+ family, five paired. **SRT In genuinely has no live counterpart**:
  not one of 61 live sockets shares a port with those 76 objects
- **And it exposed a third thing, which was producing wrong numbers rather than
  missing ones.** An SRT Out setting reports one socket *per connected client*
  — five entries sharing a `setting_id` in the capture — and the join kept the
  last, so the row showed one viewer's rate where the egress total was meant
- Entries are aggregated per object now: **the rate is the sum**, because that
  is what is leaving the server; **RTT and loss are worst-case**, because one
  bad client is the one worth noticing and an average hides it; and idle only
  when *every* client is, since one viewer pulling nothing while four others
  work is not an idle stream. The client count is shown — WMSPanel has it and
  we did not
- **"Could not be matched" reads as a fault**, and on SRT In it isn't one. When
  the two port sets do not overlap at all, the sides describe different streams
  configured on other tabs, and the note now says exactly that
- 6 new checks


### v0.25.5 — live values on SRT Out, where those streams actually live
- Ports 35001+ are configured through WMSPanel's UDP Streaming — **SRT Out** in
  this panel — and Nimble reports them under `srt_receiver_stats`. My mapping
  of endpoint to tab was an assumption, and a wrong one: it produced an empty
  column on SRT In with a plausible explanation attached to it
- The assumption is gone rather than corrected. **Both SRT endpoints are asked
  for every SRT tab** and their entries merged; the join then decides by
  identifier or by local port, which is what actually ties an entry to an
  object. A socket appearing in both lists is counted once, and one endpoint
  failing no longer loses the other — they cover different sockets and either
  alone is worth having
- SRT Out gains a bitrate column, the no-media marking, RTT, and a History
  button. `paused` is the configured intent; the rate is what the socket is
  doing, and the two disagree often enough to be worth showing both
- 3 new checks


### v0.25.4 — matching on the socket
- The identifiers do not overlap at all: Nimble's `setting_id` values
  (`6a1963…`) and the SRT In objects' ids (`6a1805…`, `6a18bf…`) come from
  different families. Neither does the **ports** — Nimble is receiving on
  35001-35005 and 22201-22216 while the tab lists 40001-40005 and 17801-17806
- Added a join on the **local port**, parsed out of Nimble's socket pair
  (`31.28.6.149:60317->0.0.0.0:35001` → 35001; the left-hand port is ephemeral
  and means nothing). Two systems can name the same stream differently and
  still be talking about the same socket, and the port is what the operator
  configured, so it means the same on both sides. A name still wins over it,
  since a port can be reused after a stream is deleted
- The diagnostics now list the ports from both sides, because that is the
  comparison that settles it. When the two port lists do not overlap, the sides
  are describing **different streams** — which is a different conclusion from
  "the field names differ", and no key would ever have joined them
- 4 new checks


### v0.25.3 — settings could not be saved, and the join failed quietly
- **"Internal server error" on every settings save.** The handler destructured
  `publicUrl` into `pub`, which is the name of the function that builds the
  response — so everything saved correctly and then the last line called a
  string. The settings were written and the operator saw a failure, retried,
  and saw it again. It survived several releases because it only fires when the
  request carries a non-empty publicUrl, and that field was empty until it was
  set
- New `npm run audit:shadow`, ahead of the test suite: a destructuring rename
  whose target is a function declared in the same module. Narrow on purpose —
  that much is decidable from the text, unlike shadowing in general — and it is
  the shape that bites. Verified against the line that shipped
- **A partial join said nothing at all.** The note only appeared when *nothing*
  matched, so streams falling back to WMSPanel values were marked `wp` with no
  explanation anywhere. It now reports whenever anything is unmatched, and
  shows the identifiers from both sides — `setting_id` from Nimble against the
  object id from WMSPanel — so a mismatch is visible as a mismatch rather than
  as an absence


### v0.25.2 — why the history is empty, and where a number came from
- **The empty-history message listed possibilities and made the operator work
  through them.** The panel knows which one applies, so it says it: collection
  switched off (with a link to the setting), collection on but this server has
  produced nothing at all (the server, not the stream), this stream never seen
  in the samples (probably not connected), or samples exist but outside the
  range asked for (with the timestamp, so the range can be widened). The extra
  queries run only when there is nothing to show
- **The live join was silently falling back to WMSPanel's own reading**, and
  the only way to tell was that the two formatters differ — `0.03 Mbps` from
  WMSPanel where a native reading would say `30 kb/s`. Values that came from
  WMSPanel are marked now; when the two disagree, which one is on screen is the
  whole question
- 3 new checks

**On the empty history:** metric collection has to be on for any of this to
record. Settings → Metric collection. It is a separate switch from the host
metrics one, and neither is on by default.


### v0.25.1 — the History button was never there
- The state and the dialog shipped; the button did not. A string replacement
  matched nothing and said nothing, so v0.25.0 went out with a feature that had
  no way in. Every other gate passed: it compiled, rendered, and the click gate
  does not reach that tab
- New `npm run audit:wired`: a state initialised to `null` or `false` whose
  setter is **only ever called with a falsy value** gates something that can
  never appear. `setHistory(null)` was present in the dialog's own onClose, so
  the thing could be closed and never opened — which is why a plainer "is the
  setter used at all" check missed it on the first try, as it did here
- Setters passed by reference (`.then(setFleet)`) are uses like any other.
  Missing that produced two false positives, and a gate that cries twice for
  one real finding gets ignored — the same judgement that led to deleting the
  flicker audit
- Verified both ways: clean now, and it names exactly the missing button when
  the button is taken back out


### v0.25.0 (iter16 m2) — per-stream history, and the history was being shredded
- **The SRT series was keyed on the socket pair.** `so.id` is
  `31.28.6.149:60317->0.0.0.0:35001`, and its source port changes on every
  reconnect — so a stream showing 52 751 retries in the capture produced up to
  52 751 separate subjects, each holding a few seconds, all of them crowding a
  capped collection shared by the whole fleet. There was no usable history, and
  nothing said so. Keyed on `setting_id` now: one stream, one series, across
  any number of reconnects
- Old subjects are left alone; they age out on the existing TTL
- **History opens from the row that raises the question.** Bitrate, round-trip
  time and reconnects, over a range picked in the dialog. Three charts rather
  than one because they answer different questions: loss without RTT reads as a
  bad source, RTT without loss reads as a slow path
- Reconnects are drawn as the counter they are. It only climbs, and the shape
  of the climb is the point — a steady slope is a link dropping continuously, a
  step is one bad minute
- "No samples in this range" is said plainly: a stream added minutes ago has no
  history and that is not a fault
- 3 new checks. One failed first time and it was the check —
  `indexOf('so.id')` also matches inside `so.setting_id`

**Coverage gap, stated:** the click gate does not reach the SRT In tab, so the
history dialog is exercised only by hand. The series key, which is the part
that was actually broken, is covered against the real capture.


### v0.24.4 — 0.03 Mbps is not a stream
- The live columns work, and the first thing they showed was worth acting on:
  dozens of sockets sitting at exactly **0.03 Mbps with no codecs detected**,
  beside real feeds at 6.5. That is an SRT socket's handshake and keepalive
  traffic — connected, carrying no media — and a green "online" lamp next to it
  makes "connected" look like "working"
- The no-media test was an exact zero and so missed all of them. It is a
  threshold now, and the threshold is **stated rather than buried**: 0.2 Mbps,
  an order of magnitude above the observed overhead and an order below the
  quietest real feed. The capture shows the same gap from the other side —
  every entry in it is either exactly 0 or above 8 Mbps, with nothing between —
  and a check asserts the threshold lands in that gap. Overridable via
  `NNM_NO_MEDIA_MBPS`, because an audio-only fleet would need it lower
- The rate stays visible when it is only overhead. Hiding it would erase the
  difference between "socket up, nothing flowing" and "socket down", which need
  different things looked at
- 3 new checks


### v0.24.3 — the real response settled it
- **The join key is `setting_id`**, which is the WMSPanel object id. Nimble's
  own `id` field is a socket pair — `31.28.6.149:60317->0.0.0.0:35001` — and
  identifies a connection rather than a configured stream, so matching on it
  paired nothing. That was "0 matched of 76". All ten entries in the capture
  now pair
- **The bitrate is `stats.recv.mbpsRate`, and this one mattered.**
  `stats.link.mbpsBandwidth` is the link's estimated capacity: 2444 Mbps on an
  8 Mbps feed. A "bandwidth" guess would have put gigabits in a bitrate column
  — wrong in a way that looks entirely plausible. The field is named
  explicitly rather than swept up by a pattern
- **Connected-but-silent is its own state**, and two of the seven live sockets
  were in it. Folding it into "offline" would hide a stream that is up and
  delivering nothing, which is the case an operator most wants to catch — it
  shows an amber `0` rather than a dash, since a dash means "no reading"
- A disconnected entry reads null, not zero: it did not report, which is not
  the same as reporting nothing
- Packet loss is a ratio of what arrived, and the retry count comes through —
  a count that climbs is a link that keeps dropping, which no instantaneous
  reading shows
- The captured response is now a fixture, so this is pinned against reality
  rather than against my reading of it. Three checks failed on first run and
  all three were the checks, written against flat fields I had guessed at


### v0.24.2 — "0 live streams" against 76 configured
- **The list was being looked for under four fixed key names.** Nimble keys its
  stats differently per endpoint and again between builds, so a name we had not
  seen produced an empty list and a table of dashes. It now takes the first
  array of objects at the top level — there is only ever one — and an object
  keyed by stream name or port becomes a list with that key kept as the name,
  because it is often the only identifier the entry has
- **"Nothing came back" is now reported apart from "came back and did not line
  up".** Only the first is answered by the shape of the response, and
  conflating them sends the operator looking in the wrong place
- When the list is empty the panel returns **the shape of what Nimble
  actually sent** — key names, types and array lengths, never values, because
  this crosses a screen and a stats response can carry addresses. It is
  rendered expandable and copyable rather than in a tooltip, since a tooltip
  cannot be copied and this is the thing worth sending on
- 5 new checks

Still unverified against a live server: whether these streams are genuinely
idle or the response simply sits somewhere new. The panel now answers that
itself on the next refresh.


### v0.24.1 — the live columns were blocked, and the block was invisible
- **The whole native router is gated on the control plane**, so in WMSPanel
  mode the new endpoint was refused with a 409 before its handler ran. The gate
  exists so that *control* does not go two ways at once — a change made
  natively is overwritten on WMSPanel's next sync — but reading a counter is
  not a change, and the stats collector has been polling this same API in this
  same mode all along. The panel was refusing itself data it already had
- Read-only stat endpoints pass; everything that changes anything stays blocked
- **The failure was silent, which is worse than the failure.** The hook caught
  the error and set the state to null, and the note only renders when it has
  something to say — so a 409 looked exactly like "every stream is offline".
  It now reports the reason, which is what would have made this one refresh
  long instead of one release long
- 2 new checks


## iter16 — stream statistics
### v0.24.0 (m1) — the bitrate and status columns finally have values
- Those columns have been drawn and empty since they were added: the rows come
  from WMSPanel objects, which describe how a stream is **configured** and
  never what it is doing. The live numbers were already being polled from
  Nimble's native API for the charts — what was missing was the pairing
- **The join discovers its own key.** Nimble and WMSPanel name the same stream
  differently and the field names differ between builds; guessing them has cost
  this project twice already. So it tries name, stream, id, local socket,
  remote socket and URL in that order, takes the first that matches anything,
  and reports which one it used. A listener is identified by its port alone,
  because `0.0.0.0:21041` and `:21041` are the same socket
- **When nothing matches, it says so and keeps the evidence.** An unmatched
  object and an offline stream look identical in a table, and only one of them
  is a problem with the panel — so the note gives the counts on each side and
  carries a sample of what Nimble actually returned. That sample is the
  documentation these field names have never had
- Rates are read out of whatever shape the entry has: under a thousand is Mbps,
  above it is bps, because six bits per second is not a video stream. A missing
  rate stays null rather than becoming zero, which would read as "carrying
  nothing" — a different fact from "did not report"
- RTT and packet loss ride along in the status cell where Nimble reports them
- New `npm run test:join`: 11 checks, most of them about the failure path
- The native stats fetch and the WMSPanel list are independent, so each is
  still useful when the other is unreachable

**Not verified against a live server.** I asked for a real
`/manage/srt_receiver_stats` response and built without it, so which key
actually matches is still unknown to me — but the panel will now answer that on
its first run rather than me guessing. If the columns stay empty, the note
above the table will name the counts and show a sample; that is the thing to
send.


### v0.23.1 — the budget readout is switchable, and the limit is editable
- A **WMSPanel budget readout** section in system settings: show it or not
- **The daily limit moved out of the environment.** It is a property of the
  account's plan, and the person who knows which plan that is cannot edit the
  container's environment. Validated between 100 and 10 000 000 — zero would
  make every reading "over budget" and an unbounded one would make the readout
  meaningless — with the environment variable kept as the fallback
- Switched off, the endpoint returns nothing to render rather than a number the
  dashboard then has to decide to ignore
- The settings audit added in v0.22.12 already covers the new block: it counts
  eight now and confirms each is reachable from the page
- 2 new checks


### v0.23.0 — WMSPanel budget on the dashboard
- The remaining daily API budget sits left of the range picker: what is left,
  a bar for what is spent, when it resets, and where the day is heading at the
  current rate
- **The rate is the point.** "11 200 left" is reassuring at 09:00 and alarming
  at 23:00, and only the projection tells them apart — so the box says which,
  and turns amber when the day is on course to overrun. It stays quiet in the
  first quarter-hour of the day, where a rate computed from minutes means
  nothing
- **It is a floor, not a balance, and says so.** WMSPanel reports no remaining
  quota — no header, no endpoint — so the only number available is what this
  panel spent. The account is shared: another panel, a script or someone in the
  WMSPanel web UI spends from the same budget and is invisible here
- Calls are counted **before** they are attempted, because a failed call has
  still left the account, and counting successes would under-report exactly
  when something is failing and being retried
- Counting is accumulated in memory and flushed on a timer rather than written
  per call — solving a budget problem by spending a different budget is no
  solution — but it is persisted, because a restart at midday would otherwise
  report a fraction of the truth
- Object ids are collapsed in the breakdown so paths group rather than
  fragmenting, which is what makes a spike attributable; the top five are in
  the tooltip
- The readout cannot break the page: it is a readout, not the point of it
- 7 new checks


### v0.22.12 — host metrics had no switch, for the second time
- **The whole chain shipped in iter15 m1 except the way to turn it on.** The
  setting existed, the gateway delivered it, the agent honoured it — and it
  defaults to off, so every agent faithfully collected nothing and the
  dashboard drew empty cards. This is exactly the omission log collection had
  in iter10, repeated
- New **Host metrics** section in Settings: the switch and the sampling
  interval, which matches the stream metrics by default so two charts read side
  by side share one timebase
- **The per-server interface picker was also missing.** The agent has reported
  which physical NICs it has since m1 and nothing displayed them. They are
  tickboxes on the Agents page now — a choice from a real list rather than a
  name typed from memory — and none ticked still means every physical
  interface, which is right on a box with one
- New `npm run audit:settings`: every block the settings route serves must be
  mentioned by the settings page. Blunt on purpose — it cannot tell a real
  control from a stray string, but it catches a block with no UI at all, which
  is the failure that has now happened twice. Verified against the real defect
- Its own first version read the wrong part of the route, found nothing and
  reported OK; it now refuses to pass if it cannot parse the shape at all,
  because an audit that examines the wrong thing is worse than none


### v0.22.11 — the warning outlived the fault
- **A resolved problem kept being reported.** The self-update deadlock flag was
  derived from the task history alone, so the failed task from before a
  reinstall went on firing after the reinstall had fixed it — the panel telling
  an operator to fix something they had already fixed, and hiding the update
  button while it did
- It is now a statement about the present: the agent must still be behind, and
  the failure must have aimed at a version newer than the one running. A
  failure overtaken by events is history, not state — the same applies to the
  "last update failed" note
- **The state column carried sentences at 110px.** The update notes lived in
  the version column, which holds a number; a paragraph in that width came out
  as a vertical ribbon. They sit with the state now, and the two columns are
  sized for what they actually contain
- 2 new checks, covering both the "still true" and the "no longer true" side


### v0.22.10 — a broken updater cannot fix itself
- The v0.22.9 fix is in the new agent, and the agent that needs it is the one
  that refuses to accept it: **the code doing the checking is the code being
  replaced.** Every agent up to v8 will reject every download it is offered,
  for ever, and retrying cannot change that
- The panel recognises that specific failure now and says what does work —
  reinstall from the Agents page: one command on the server, the token is kept,
  and the agent lands where it can update itself by button afterwards. The
  retry button is not offered for an agent in this state, because offering it
  would be offering something that cannot succeed
- The escape route is asserted rather than assumed: the installer replaces the
  binary, keeps an existing token, and installs into the state directory
- **The lesson, recorded:** a component that validates its own replacement can
  lock itself out permanently with one over-strict check. The new check is as
  permissive as safety allows — a shebang and a version marker — and is
  verified against the real shipped file, so tightening it accidentally fails a
  test instead of stranding a fleet


### v0.22.9 — self-update could never have worked, and preferences were never stored
- **The agent's own sanity check on the download never passed.** It looked for
  the string `nnm-agent` in the leading 200 bytes, where the file has a shebang
  and a title in capitals. Every self-update on every agent failed at that
  line — and the message, "the downloaded file does not look like the agent",
  sounded like tampering rather than a bug in the check. It now tests what the
  file actually contains, over the whole of it: a shebang and the version
  marker. An HTML error page returned with a 200 is still rejected, which is
  what the check exists for. Agent protocol version 9
- **`preferences.dashboard` was discarded on save.** `preferences` is a typed
  sub-schema, and mongoose silently drops keys it does not declare — so the PUT
  succeeded, the value vanished, and the dashboard reverted to its defaults on
  every reload. That is why the range kept returning to an hour: the optimistic
  update from v0.22.8 applied, and then the refresh brought back the unchanged
  account. Declared as Mixed; the route already validates it by allow-list
- 5 new checks, both verified against the real defects. The agent one runs
  against the shipped file rather than a fixture, so a future change to the
  file's opening lines fails the check instead of silently breaking updates
  again


### v0.22.8 — the range would not take, and the toolbar was wrapping
- **`Select` ignored the width its caller gave it.** It accepted no `style`
  prop, so every one took its natural width; the toolbar row overflowed and
  wrapped, and each label landed on its own line above its own control. That is
  the misalignment, and it was the same everywhere the pattern is used — the log
  dashboards included
- Labelled control groups are pinned against wrapping, with a `.row.pair` house
  rule so the next one does not have to remember
- **Choosing a range waited on the network.** I had put a control reached for
  constantly behind a write: a PUT, then a GET, and only then did the screen
  change — and nothing changed at all if either failed. The choice applies
  immediately now, persistence catches up behind it, and a failed save reverts
  rather than leaving the screen disagreeing with the account
- The click gate caught the first attempt at that fix throwing `Cannot access
  'pending' before initialization` — the state was declared below the memo that
  reads it
- 5 new checks


### v0.22.7 — a step that cannot run says so, and a refused update stops hiding
- **Steps with no object are caught on save**, per step and by index, instead
  of on a live fleet at preflight. Reported rather than refused — building a
  function over two sittings is normal, running one that cannot work is not —
  and the same rule runs live in the builder, with the offending step marked so
  it is findable in a long list
- **An update that failed was invisible.** The agent reported exactly why, the
  task recorded it, and the panel showed nothing: an agent that refused to
  update looked identical to one nobody had asked. The last attempt is now
  reported whatever its outcome, with the agent's own reason, and "nobody
  picked it up" is its own case — that one means the agent was not polling, not
  that it refused
- 7 new checks

**Note on the agent stuck at v7:** the most likely cause is an agent installed
before iter14 under `/usr/local/bin`, which `ProtectSystem=strict` makes
read-only — it cannot rewrite itself and says so, and that message was the one
being swallowed. Reinstalling from the panel moves it to `/var/lib/nnm-agent`,
keeps the token, and makes future updates work. After this release the panel
will state which of the two it is.


### v0.22.6 — picking an object lost its id
- **The function never had a target on any step, and the panel said otherwise.**
  Picking an object called `set('targetId', …)` and then `set('targetLabel', …)`
  in one handler. Both reads take the same `step` prop — React has not
  re-rendered between them — so the second write discarded the first. The label
  stuck, the id did not: the editor showed "SELECTED cct_feeds/feed1" beside an
  empty id, the function saved cleanly, and every run failed preflight on every
  step
- Both fields are written in one update now. The v0.22.5 diagnostics are what
  made this findable: "this step has no outgoing object selected" pointed
  straight at the data instead of at WMSPanel
- New `npm run audit:setter`: flags two consecutive calls to the same
  single-field setter inside one handler, across all 51 components. Narrow on
  purpose — a setter taking a whole patch, or two different setters, is fine —
  and verified against the exact line that shipped
- The lost-write itself is reproduced in a check rather than asserted about, so
  the shape is pinned and not just the current code


### v0.22.5 — preflight says which fault it hit; variants show when they drift
- **"outgoing object not found" covered three different faults.** The object
  was deleted, or the list came back empty (a server mapping or an API key that
  lost access), or the step never had an object picked at all — one message,
  three opposite fixes. Now: an empty list says so and points at the mapping and
  the key; a stale id gives the count and names some of what WAS there; and a
  step with nothing selected says that without calling WMSPanel to find out
- **Variants no longer drift silently.** A variant overrides only the fields it
  names, so changing a step changes everything else — but a field the variant
  does name keeps its old value, and that old value is what reaches a live
  stream. The editor warns when a variant overrides a field the step no longer
  sends or a step that is gone, and shows the step's own value beside each
  override so the comparison is made where the editing happens
- **Nothing is corrected automatically.** Overwriting an override would destroy
  the difference the variant exists to express; a variant that merely differs
  in value is not flagged either, or the warning would be meaningless within a
  day
- 7 new checks


## iter15 — dashboard of charts
### v0.22.4 (m5) — the dashboard is configurable, and the click gate grew teeth
- Which charts to show, the range, the column count, the refresh interval
  (including manual) and how many streams per server — all set from one dialog
- **Saved on the account, not on the panel.** One person watches the network on
  a wall display while another chases a memory leak; they should not be
  fighting over one screen. The existing `user.preferences` mechanism was
  reused rather than a second one invented, and every value is validated by
  allow-list like the rest of it — these drive queries, and a range of "999999"
  would be a way to ask the database for everything it has
- The range stays in the toolbar because it is reached for constantly;
  everything set once and left alone is behind the button. Defaults show
  everything: a dashboard whose defaults hide things is one where a fault is
  missed by whoever never opened the settings
- **The click gate was checking less than half the interface.** It collected
  buttons once, before any click, so nothing a click revealed — a dialog, an
  expanded row — was ever exercised. It rescans after each click now:
  **126 → 319 buttons**, and everything newly reached passed
- It also conflated two findings: the render-error filter matched any warning
  whose formatted text ended in "undefined", so a React key warning was
  reported as a crash. Crashes fail the gate; warnings are listed separately,
  attributed to their page, and do not
- **Three real defects the widened gate found**, all predating this milestone:
  transcoder tags keyed by their own value (WMSPanel returns duplicates), graph
  nodes keyed by an optional id, and three lists returning bare fragments — a
  fragment cannot carry a key, so React had nothing to identify those rows by
- 6 new checks on the settings

**Open finding:** one duplicate-key warning on the transcoder page survives the
fixes above and is not yet located. It is visible and attributed in the gate
output. Not fatal — React reuses the wrong node on reorder — and not from this
milestone, but it is real and still open.


## iter15 — dashboard of charts
### v0.22.3 (m4) — streams on the dashboard
- Each card now shows the streams that server is carrying, over the same range
  as its host charts
- **The metric name is discovered, never assumed.** `flattenNumbers` stores
  whatever numeric fields Nimble reported and those differ between builds —
  which is the reason `StatSample` keeps a free-form map in the first place. A
  hardcoded `bandwidth` would work on one fleet and silently plot nothing on
  another, so the rate field is found per subject by the same pattern the
  graphs tab already uses, preferring the plainest name
- **One chart per card, streams as series.** Six charts per card would have
  been seventy-eight more uPlot instances on a page already carrying
  thirty-nine — and separate axes make the comparison an operator actually
  wants, which stream dropped while the others held, impossible
- Streams report on their own timelines, so they are aligned onto the union of
  their timestamps. A stream that was not reporting at a moment is **null**
  there, never 0: a stopped stream and a stream at zero bitrate are different
  events, and drawing them alike hides the one that matters
- The busiest streams get the space, capped per server, with the total shown —
  a box with two hundred streams must not draw two hundred lines
- A stream Nimble reports without any bitrate field is **counted and named**
  rather than dropped. It exists; it just cannot be plotted
- Two requests for the whole page, not two per card, and a failure of the
  streams half leaves the host charts standing
- New `npm run audit:align` (5 checks) plus 7 backend checks. One assertion
  from m3 needed correcting rather than the code: it pinned "exactly one
  `/stats/` call site", which m4 legitimately makes two


## iter15 — dashboard of charts
### v0.22.2 (m3) — a card of charts per server
- The dashboard listed servers, which the Servers page does better. What an
  operator opens a dashboard for is "is anything wrong right now", and a number
  that has been the same for an hour cannot answer that — only its shape over
  time can. It is a wall of charts now: CPU with steal and iowait beside it,
  memory with swap, network in and out, and the current values above them
- **The card is the link.** The list was also the navigation, so the header
  goes to the server and nothing has to be found again
- **One request serves the whole fleet.** Thirteen cards asking for themselves
  would be thirteen round trips and a page that paints in thirteen jerks
- The bucketing that thins a series is now written once and shared by the
  per-subject and the fleet endpoints: two implementations of the same
  averaging would eventually draw two different pictures of the same minute.
  A card gets 240 points rather than 600, because six hundred points in three
  hundred pixels is work nobody can see
- **Three empty states, told apart.** No agent, an agent that has gone silent,
  and an agent that has simply not sent anything yet all look like an empty
  chart otherwise, and only one of them is an outage
- Range and column count are remembered, and the last view goes up in the first
  frame while the refresh runs behind it
- **The undefined-reference audit missed a real defect and was widened.** A
  missing `import { NimbleServer }` slipped through because the identifier is
  used as `NimbleServer.find(...)` — a member call, not a direct one — which is
  the most common shape in this codebase. It catches capitalised receivers now,
  and was verified against the exact miss
- 7 new checks


## iter15 — dashboard of charts
### v0.22.1 (m2) — uPlot, proven on the existing stats tab first
- A `Plot` wrapper around uPlot, put to work on the Graphs tab before anything
  is built on it. uPlot 1.6.32, zero dependencies
- **uPlot is imported dynamically, and not as a size optimisation.** It touches
  browser globals — `matchMedia`, `devicePixelRatio` — at module load rather
  than at construction, so a static import ran that code everywhere the module
  was pulled in and crashed the render harness before a single component had
  rendered. Loading it behind the same guard that decides whether a canvas can
  be drawn keeps it out of those environments entirely
- The bonus is real though: it lands in its own chunk, 52 KB plus 1.6 KB of
  CSS, fetched only when a chart is actually shown. The main bundle barely
  moved
- Without a canvas the chart renders the latest value instead of throwing — the
  harness needs that, and so does any browser with canvas disabled
- The instance is created once and fed with `setData`; a new one per tick would
  discard the operator's zoom and redraw from scratch. It IS rebuilt when the
  series list, unit or height change, because uPlot cannot add or remove a
  series after construction — and that shape is **derived** from what is drawn
  rather than signalled by a flag someone must remember to set
- Size follows the container through a `ResizeObserver`, and colours come from
  the stylesheet, so the light theme needs no second code path
- **A gap is `null`, never `0`.** A missing reading drawn as zero is how a
  restarted server looks like an idle one, and those call for opposite
  reactions
- New `npm run audit:plot`: 11 checks on the data transform, the rebuild rule
  and the import guard. One of them was wrong on the first run — it matched the
  word "rebuild" in a comment, which is testing prose; narrowed to the
  component's props
- The render harnesses now ignore stylesheet imports: they check that pages
  render and their buttons are bound, not how they look


## iter15 — dashboard of charts
### v0.22.0 (m1) — agents report the host
- Agents sample CPU, memory, swap and network straight from `/proc` — no
  dependency, no privilege the agent did not already have — and push them on
  the same path the logs use. Agent protocol version 8
- **No new storage.** `StatSample` was already a generic series
  (`serverId, subject, group, ts, metrics`), so host samples land in it under
  `group: 'host'` and inherit the retention that was already there. One query
  serves host and stream charts alike
- **Rates are computed on the agent, not the panel.** Everything in `/proc` is
  cumulative and a reboot resets it; only the agent can tell a restart from a
  spike, by watching its own uptime go backwards. The first read after a start
  or a reboot returns nothing at all — a gap is honest, an invented peak gets
  investigated
- An interface recreated between samples is skipped for that round rather than
  reported as an enormous positive rate
- **Memory is measured by `MemAvailable`.** `MemTotal - MemFree` counts page
  cache as used and is wrong in both directions depending on how warm the box
  is. Verified against `free -m` on a live machine: both say 269 MB
- **Steal and iowait are their own series.** On a shared VM "CPU is fine but
  steal is 30%" is the diagnosis, and it disappears the moment it is folded
  into one number. Busy therefore excludes idle *and* iowait
- Which interfaces to watch is chosen per server, because the machines differ,
  and delivered on the poll response — nothing to configure on the box. Only
  real NICs are offered: a device directory under `/sys/class/net` is what
  separates a card from `docker0`, a bridge or a veth pair, which would
  double-count
- New `npm run test:host`: 12 checks, driven against a synthetic `/proc` so the
  reboot and counter-reset paths can actually be exercised, and run against the
  agent's own source rather than a copy of it


### v0.21.6 — swept the rest of the app for the same flicker
- Checked every component that empties state before fetching: 39 places. **One
  was the defect** — the category member picker blanked its table before
  reloading it, so the dialog collapsed and re-expanded on every load
- It keeps the list now and shows progress on the button instead. Changing the
  server or the kind still clears it, because that list under a different
  heading would be **wrong** rather than merely stale
- The other 38 are correct and were left alone: a clear inside a `catch`
  happens after the attempt, and a reset on opening a dialog drops the previous
  run's result. Three more looked identical to the defect and are not — a probe
  of a different host, a new run's report, another group's expanded rows. There
  the old value belongs to a different subject
- **No general audit for this.** One was written and then deleted: it flagged
  sixteen places to catch one, because the distinction is semantic rather than
  syntactic, and a gate that cries wolf is worse than none — it teaches people
  to skip it. The two views that genuinely refresh themselves are pinned by
  checks instead
- The shared `useObjects` hook every object tab uses was already correct: it
  assigns only on success. Worth recording, since it is why the object tabs
  never had this


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
