# Nimble routes via WMSPanel — what the API actually accepts

Written after the first live `POST /v1/routes/` on this account, because the
official reference alone produced a request WMSPanel rejected. Everything below
that is marked **confirmed** came from a real response; everything marked
**unknown** is still unknown and should stay that way until something proves it.

## The target is not a URL — confirmed

Sending what looks like a URL:

```json
{"from": "/test1/", "to": "http://79.98.187.66:8081/test1/", "servers": ["…"]}
```

is answered with **HTTP 200** and:

```json
{"status": "Error", "message": "Target Domain and Port must be specified (e.g 127.0.0.1:8080)"}
```

The scheme hides both the domain and the port from the parser. The accepted
shape is host, port, then path:

```json
{"from": "/test1/", "to": "79.98.187.66:8081/test1/", "servers": ["…"]}
```

This matches how the vendor's own UI splits the field into *Domain to* and
*Path to*, and it is consistent with the reference's `file:///var/www/video/`
examples being the VOD special case rather than the general form. Reading the
reference alone is exactly what produced the wrong shape: every populated
example it shows serves files off a disk.

## HTTP 200 does not mean success — confirmed

The error above arrived with a 200 status and `"status": "Error"` in the body.
Any client that trusts the HTTP code will record a route that was never
created. `wmspanelClient.call` checks the body's `status` field, which is why
this surfaced as a failure rather than as a phantom success.

## An empty domain in `from` — confirmed accepted

`"/test1/"` with no domain is accepted, and is what an edge wants: viewers
reach it by IP today and by a DNS name later, and pinning a domain now would
break the second.

## Reaching an origin over HTTPS — unknown

The reference documents an SSL option in the re-streaming dialog but no field
for it in the route object, and the scheme cannot carry it because `to` has no
scheme. Until a route created through the UI can be read back and inspected,
the panel does not offer it.

## What a created route returns — confirmed

The response does carry the route: the first successful write read back with a
`to` identical to the one sent. The missing-id fallback stays anyway, because
one observation is not a guarantee and undoing on a wrong assumption would
delete a route that exists.

## Where a route appears afterwards — confirmed

In WMSPanel: **Nimble Streamer → Edit Nimble routes**, with the server picked
at the top of the page. Routes are held per server, so a route written for one
edge is invisible while another is selected. The Nimble instances themselves
receive it on the ~30s sync, not immediately.

Worth stating because it is the first question after a successful write, and
the panel used to have no answer: it showed what it would do and never what
was there.


## Custom ports are not in the API — confirmed absent

WMSPanel's server dialog holds custom domains *and* custom ports (`Custom
ports: HTTP 8081,25541`). Only the domains come back from the API:

    GET /v1/server        -> id, name, kind, status, ip, custom_ips
    GET /v1/server/{id}   -> id, name, kind, status, ip

No port field on either, and the account's second HTTP port appears in **no
response across all 104 endpoint dumps**. So a port set in WMSPanel cannot be
read by anything built on its API, and a panel that needs one has to be told
separately.

Worth stating plainly because the opposite assumption is natural and wrong:
"it is configured in WMSPanel" does not imply "it is available over the
WMSPanel API".

`custom_ips`, on the other hand, is exactly the public name an edge needs for a
redirect gateway, and is now read on every sync.
