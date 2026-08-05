# Diagnostics

Standalone, read-only, run when something needs explaining. None of this is in
the request path of the panel: an investigation that ships inside a response
polled every ten seconds costs bytes forever to answer a question asked twice a
year.

## nnm-diag.mjs — the stats pipeline, end to end

One file, no dependencies, nothing to install. Talks to the panel over the same
HTTP API the browser uses, so it needs no container, no database access, and
does not care what the compose services are called.

```bash
node nnm-diag.mjs --url https://panel.example --user superadmin --pass '…'
node nnm-diag.mjs --url … --user … --pass … --server <serverId>
```

Without `--server` it lists them. Five sections, in order, ending in a verdict
that names the link that is short — there are several between a socket on a
Nimble box and a point on a chart, and a break in any of them looks identical
from the browser.

Needs Node 18 or newer for `fetch`. An account with two-factor enabled cannot
be used; the tool says so rather than returning an opaque 401.

## nnm-api-probe.mjs — what every object family looks like

The panel shows six kinds of stream and each is a different WMSPanel resource
with its own fields. Which of them carry a pausable state, and under what name,
has been guessed twice in this project and got wrong twice — once from reading
our own edit form, which does not show every field, and once from a five-entry
sample.

```bash
node nnm-api-probe.mjs --url https://panel --user NAME --pass SECRET --server <serverId>
```

Records, per family: the key its list is wrapped in, every field name seen
across the WHOLE list rather than on the first object, the shape of one sample,
and — the part that settles it — every distinct value each state-like field
actually takes. A field that is `false` on every object tells you nothing; one
that is `true` somewhere is the switch.

Read-only. Addresses lose their last octet and anything named like a key is
replaced outright.

## nimble-probe.mjs — what Nimble reports

Run **on the Nimble machine**. Asks every endpoint that could carry stream
statistics, including ones a given build may not have, and writes down shapes,
counts and every id-ish and port-ish field. Addresses are reduced to their
first three octets before anything is written.

```bash
node nimble-probe.mjs > nimble-probe.json
```

## In-image tools

`backend/tools/` holds two more that need the database and the WMSPanel
credentials directly — `join-report.mjs` and `pipeline-check.mjs`. They run
inside the API container and are the same investigation from the other side.
Prefer `nnm-diag.mjs`: it needs less to be true before it works.
