# NNM Control — what this is and how it is put together

For somebody opening the repository without the history. `docs/STATE.md` says
what is true right now; this says what the parts are and why they are shaped
that way.

## What the panel is for

A self-hosted operator interface for a fleet of Nimble Streamer servers,
**replacing WMSPanel as the primary interface** rather than wrapping it. The
operator sees channels, networks and links; the Nimble primitives — routes,
origin applications, ABR, aliases, tokens, LL-HLS settings — are derived from
that intent and written by the panel.

Fourteen Nimble servers, mostly Russian and European.

## The three kinds of machine

Decided by `purpose`, in one place: `backend/src/services/serverCapabilities.js`.
Every screen reads it rather than deciding for itself, because six places
deciding separately is what let the privileged helper be reachable in the API
and invisible in the interface for two versions.

| purpose | in the UI | serves viewers | TLS lives in | helper | LL-HLS |
|---|---|---|---|---|---|
| `nimble` | media server | no, it processes | — | not offered | no |
| `nimble-cdn` | media server + delivery node | yes, Nimble | `nimble.conf` | edge profile | yes |
| `gateway` | edge-proxy, no Nimble | yes, nginx | nginx | gateway profile | no |

A machine that serves viewers while labelled `nimble` will not be offered
LL-HLS. That is the filter working on wrong data, and the data is the fix.

## The three layers that reach a machine

**The panel** composes plans. It is the thing that might be compromised, so it
is never the only thing enforcing a limit.

**The agent** (`agent/nnm-agent.mjs`, vendored to `backend/src/assets/`) runs on
each server under `ProtectSystem=strict`. It executes steps it is sent —
`file`, `package`, `command` — and composes none. Anything else would be a
remote shell with ceremony.

**The privileged helper** is a second unit, root, installed only where something
needs it. Its writable paths and permitted binaries are fixed at install time
from a profile, and the helper refuses anything outside them — so a compromised
panel cannot reach further than the profile allows. The lists exist in both the
panel and the agent, and a test holds them equal.

Two profiles, and the edge one is **strictly smaller** apart from the directory
it exists for:

- **gateway**: nginx, letsencrypt, the ACME webroot, apt, systemd; may run
  `nginx`, `certbot`, `systemctl`, `ln`, `rm`, `kill`.
- **edge**: `/etc/nimble`, letsencrypt, apt, systemd; may run `apt-get`,
  `certbot`, `systemctl`. No nginx, no webroot, and no `kill` — on a media
  server, a process holding port 80 belongs to somebody.

## The plan/apply envelope

Anything that changes a machine goes through the same shape, because it is the
shape that survived contact with the fleet:

1. **Plan.** Exactly what would be written, shown to the operator. Diffs of
   configuration files are masked — `nimble.conf` carries the WMSPanel
   credentials.
2. **Apply.** The plan is recomputed and compared by digest; if the file moved
   since the preview, it refuses. Steps are backed up before they are written.
3. **Verify by asking the wire.** A TLS handshake, a fetched playlist. Never an
   exit code: a step that returned zero and a port that answers HTTP/2 are
   different claims.
4. **Rollback** from the backups the run itself reported.

Long work runs as a **job** the browser polls. Anything that takes minutes
inside a held-open request meets a proxy timeout at sixty seconds — four times
in this project's history.

## Where the LL-HLS logic lives

| file | what it owns |
|---|---|
| `services/llhls.js` | the rules, each number with its source: the 500 ms part floor (measured; the published reference says 250), the ceiling of half the chunk, hold-back as three times the part, container advice, the restart requirement |
| `services/llhlsPlan.js` | the `nimble.conf` half: an **upsert** on the file that is there, never a template |
| `services/llhlsState.js` | one assembled answer per edge, three-valued throughout |
| `services/certPlan.js` | three ways to obtain a certificate, and what each costs |
| `services/certState.js` | what to do about the certificate that exists |
| `routes/llhls.js` | the routes, including the applications half |
| `frontend/pages/LlhlsPage.jsx` | the screen |

**`nimble.conf` is edited, never composed.** It carries the credentials that
bind the server to the WMSPanel account and whatever fifteen machines have
accumulated; writing a file we generated would be a remote `rm` with extra
steps. Existing keys change in place, new ones append in one labelled block,
every other byte survives — including comments, which are *not* settings.

## Three values, everywhere

`true`, `false`, and **not asked**. The third is not a shade of the second: "we
have not probed this edge" is fixed by a button, "this edge has no certificate"
is not. Rows draw `?` for it, and a button that would act on it is disabled —
because unknown once permitted an action and produced a 422 after the press.

Nothing rolls four indicators into one tick. A player without HTTP/2 falls back
to ordinary HLS in silence, and an application with the checkbox on keeps
producing the old output until its input restarts; a single green mark over
that would be a lie of exactly the kind the feature exists to prevent.

## Testing

`npm test` in `backend/` runs everything: unit checks with a custom
`check(name, fn)` runner, source audits, and gates that read the frontend and
the packaging.

Two habits matter more than coverage:

- **Gates are proven by contradiction.** Reintroduce the fault; the check must
  fail. A check that cannot fail has not been shown to work — seven were found
  that way, see `docs/FAILURES.md`.
- **Copies are held equal by tests.** The agent carries the helper's lists, the
  frontend carries the purpose rule, the standalone tools carry the LL-HLS
  constants and the playlist reader. None can import the panel, so each has a
  test that fails when it drifts.

## Delivery

`.deb` from `packaging/`, images on GHCR, a systemd unit running
`docker compose` with `--env-file /etc/nnm-control/nnm-control.env`. The
package pulls images, and **fails the install** if the panel is not running
afterwards — printing no banner and no setup token, because an outage that
reads as a successful install is how one lasted an hour.
