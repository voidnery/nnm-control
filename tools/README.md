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
