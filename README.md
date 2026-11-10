# NNM-Control

Self-hosted web panel for running a fleet of streaming media servers: channels,
delivery networks and routes, certificates, LL-HLS, transcoders, playlists,
logs and statistics, with a small agent on each server. Node.js (Express) +
React + MongoDB, running as a Docker Compose stack, installed as a `.deb`.

**Compatibility:** works with Nimble Streamer servers (Softvelum) through their
native management API and the WMSPanel API. Nimble Streamer, WMSPanel and
Softvelum are trademarks of their owners; NNM-Control is not affiliated with
them.

License: MIT (`LICENSE`). Third-party licences: `docs/LICENSES-AUDIT.md`.

## Before changing anything

`docs/STATE.md` — what exists, what was established against live systems, and
what is deliberately not built. It is the first thing to read: the
alternative kept happening, which was proposing to build something the panel
already had, or re-deriving a WMSPanel fact that had cost an afternoon two
iterations earlier. `CHANGELOG.md` says what changed and when; `docs/STATE.md`
says what *is*.

## Editions

Versions 1.x limit nothing. From 2.0, without a licence the panel runs as
**Free: one server**. Adding a second one
— by hand or by the WMSPanel import — is refused with «Редакция Free: серверов
— не больше 1…». A panel that already manages more servers keeps all of them;
nothing is removed. More servers come with the Pro edition (licence — later,
ETL2). The limits are read in one place: `backend/src/license/limits.js`.

## Install — Eterix (DIST-Control + eterix-updater)

The package `nnm-control` is published into DIST-Control (channel beta, then
stable after the owner's approval) and is updated by `eterix-updater` with a
snapshot of the database and automatic rollback.

1. Connect the host to the Eterix origin with the DIST-Control installer: it
   writes `/etc/apt/sources.list.d/eterix-nnm-control.sources`, the channel and
   the keyring.
2. `sudo apt update && sudo apt install nnm-control` — it pulls in
   `eterix-updater` and `eterix-keyring`.

The installer asks for the **panel domain** and **port**, generates the
secrets into `/etc/nnm-control/nnm-control.env` (0600), starts the stack and
prints the panel URL. Open `http://<domain>:<port>`: the first-run screen asks
for the **setup token** — `sudo nnm-control setup-token` — and creates the
superadmin. The token is never printed by the installer.

The package is thin: stock images (MongoDB, Node.js, nginx) pinned by digest,
the application itself in `/opt/nnm-control`, mounted read-only. The update
engine checks `http://127.0.0.1:8580/healthz`.

Hosts installed from the old APT repository carry versions with the Debian
epoch `1:` and cannot be updated by the engine as they are — see
`docs/EPOCH-MIGRATION.md`. Do not add both sources to one host.

## Install — old APT repository (existing installations)

Kept until the installed clients move to DIST-Control
(`.github/workflows/legacy-apt.yml`, run by hand).

```bash
wget -qO- https://<owner>.github.io/nnm-control/apt/gpg.key \
  | sudo gpg --dearmor -o /usr/share/keyrings/nnm-control.gpg
echo "deb [signed-by=/usr/share/keyrings/nnm-control.gpg] https://<owner>.github.io/nnm-control/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/nnm-control.list
sudo apt update && sudo apt install nnm-control
```

This package pulls the pre-built images from ghcr.io. Updates: `sudo apt update
&& sudo apt upgrade`.

## Service management

```bash
nnm-control status        # systemd + compose ps
nnm-control logs [svc]    # follow logs
nnm-control restart|stop|start
nnm-control configure     # re-ask domain/port (dpkg-reconfigure)
nnm-control setup-token   # print the first-run setup token
nnm-control backup        # mongodump into /var/lib/nnm-control/backups (also nightly)
nnm-control version
```

Layout: compose in `/opt/nnm-control`, config in
`/etc/nnm-control/nnm-control.env` (0600), unit `nnm-control.service`.
Removal: `apt remove` keeps config and data; `apt purge` removes the config,
the data volumes stay until `docker volume rm nnm-control_mongo_data
nnm-control_media_spool nnm-control_geoip_db`.

## Enabling the API on each Nimble Streamer server

`/etc/nimble/nimble.conf` on every managed instance:

```
management_listen_interfaces = <panel IP or VPN subnet iface IP>
management_port = 8082
management_token = <strong random token>
```

`sudo service nimble restart`, then add the server in the panel.
**Never expose the management port to the public internet.**

## Zabbix

- `GET /api/zabbix/app?token=<ZABBIX_TOKEN>` — app metrics.
- `GET /api/zabbix/system?token=<ZABBIX_TOKEN>` — machine metrics
  (loadavg, RAM, host root disk via read-only `/:/host` mount).

Token lives in `/etc/nnm-control/nnm-control.env`. Use Zabbix HTTP
Agent items + dependent items with JSONPath (`$.load_1m`,
`$.mem_used_percent`, `$.disk_root.used_percent`, `$.mongo_connected`).

## Releasing a version (maintainer)

The version lives in `VERSION` (X.Y.Z, no epoch); both `package.json` files
must carry the same number. A release is a push to `main` that brings a new
`VERSION` together with a `## X.Y.Z` section in `CHANGELOG.md` — nothing is
tagged by hand. CI (`.github/workflows/release.yml` → eterix-ci auto-release)
runs the tests (`bash ci/test.sh`), builds the package (`bash ./build.sh`),
checks it against the DIST-Control rules, installs it on Ubuntu 24.04
(`ci/e2e-deb.sh`), publishes it into DIST-Control **beta**, creates the GitHub
Release and sets the tag `vX.Y.Z` last. A push that does not change `VERSION`
only runs the tests and builds the package. Promotion to stable is done by the
owner in DIST-Control after 72 hours.

Repository settings: variables `DC_URL`, `DC_PRODUCT` (= `nnm-control`) and the
secret `DC_TOKEN`.

A DEFECTIVE build for the rollback test: branch `defective/X.Y.Z` (X.Y.Z =
`VERSION`) with a file `DEFECT` containing `version`, then Run workflow on that
branch.

## Development

```bash
bash ci/test.sh                      # every test and audit, TAP; SKIP_INSTALL=1 to skip npm ci
STAGE_ONLY=1 bash ./build.sh         # the package tree without dpkg (any OS)
docker compose -f docker-compose.dev.yml up -d --build   # builds from sources
# or natively: backend `npm start` (needs Mongo), frontend `npm run dev`
```

## Known architectural limits (Nimble Streamer native API, by design)

1. Republish rules created via the native API are **not persistent** across
   Nimble reloads (official docs); persistent rules need the WMSPanel API or
   host-side config management.
2. Persistent SRT/MPEG-TS/application settings creation is not exposed by
   the native API — read-only sections for now.
