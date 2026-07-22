# NNM Control (network-nimble-media-control)

Open-source, self-hosted web panel for managing **Nimble Streamer** instances
via their native management API. Node.js (Express) + React + MongoDB, running
as a Docker Compose stack, distributed as a **.deb package** from this
repository's own APT repo (GitHub Pages).

License: MIT.

## Install (Ubuntu Server)

```bash
# 1. Add the signing key and the APT repository
wget -qO- https://<owner>.github.io/nnm-control/apt/gpg.key \
  | sudo gpg --dearmor -o /usr/share/keyrings/nnm-control.gpg
echo "deb [signed-by=/usr/share/keyrings/nnm-control.gpg] https://<owner>.github.io/nnm-control/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/nnm-control.list

# 2. Install (Docker is pulled in as a dependency if missing)
sudo apt update
sudo apt install nnm-control
```

During installation the package asks for the **panel domain** and **port**
(debconf prompts in the terminal). It then generates secrets, pulls the
pre-built images from ghcr.io, starts the systemd service and prints:

- the panel URL, and
- a one-time **setup token**.

Point a DNS A-record of the chosen domain at this machine, open
`http://<domain>:<port>` — the panel shows the **first-run setup screen**
where you enter the setup token and create the superadmin login/password.
The token protects against someone else claiming superadmin before you;
re-print it any time with `nnm-control setup-token`.

## Updates

Standard apt flow — updates arrive like any other package:

```bash
sudo apt update && sudo apt upgrade
# or explicitly:
sudo apt install --only-upgrade nnm-control
```

`postinst` re-pulls the matching image versions and restarts the stack.
Config (`/etc/nnm-control/nnm-control.env`) and the Mongo data volume
survive upgrades. Rollback: `sudo apt install nnm-control=<old-version>`
(old versions stay in the repo pool), then the stack restarts on those images.

## Service management

```bash
nnm-control status        # systemd + compose ps
nnm-control logs [svc]    # follow logs
nnm-control restart|stop|start
nnm-control configure     # re-ask domain/port (dpkg-reconfigure)
nnm-control setup-token   # print the first-run setup token
nnm-control version
```

Layout: compose in `/opt/nnm-control`, config in
`/etc/nnm-control/nnm-control.env` (0600), unit
`nnm-control.service`. Removal: `apt remove` keeps config & data;
`apt purge` removes config, Mongo volume is kept until
`docker volume rm nnm-control_mongo_data`.

## Enabling the API on each Nimble server

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

## Release engineering (maintainer)

One-time repo setup:
1. GitHub Pages: deploy from branch `gh-pages`, folder `/`.
2. Secrets: `APT_GPG_PRIVATE_KEY` (ASCII-armored private key),
   `APT_GPG_KEY_ID` (key id/email).
3. After the first release, set both ghcr packages
   (`nnm-control-api`, `nnm-control-web`) to **public** visibility.

Release = push a tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

CI then: builds multi-arch api/web images → ghcr; builds the .deb; rebuilds
the signed APT repo on `gh-pages`; attaches the .deb to a GitHub Release.

Local packaging (no CI): `packaging/build-deb.sh 0.2.0 <owner>` and
`packaging/build-apt-repo.sh <gpg-key-id>`.

## Development

```bash
docker compose -f docker-compose.dev.yml up -d --build   # builds from sources
# or natively: backend `npm start` (needs Mongo), frontend `npm run dev`
```

## Iteration journal

- **iter3 (v0.4.x, CLOSED at v0.4.3)** — UX & design overhaul: theme system
  (dark/light/system), per-user profile settings (theme, language EN/RU with
  an i18n scaffold, function-dialog width, self-service password change),
  optional TOTP two-factor auth (QR setup, backup codes, two-step login,
  admin reset), a custom themed Select used everywhere, safe-close modals
  across the app, clearer function builder (shows the picked app/stream), and
  operator-friendly server tab names.

- **iter2 (v0.3.x, CLOSED at v0.3.17)** — WMSPanel control plane epic:
  manageable API base (.com/.ru), strict control-plane separation, fleet
  auto-sync, transactional engineering functions (preflight / snapshot /
  verify / rollback, per-function role permissions), full object management
  (republish, MPEGTS in/out, UDP/SRT, hotswap, live pull, apps, interfaces),
  real Live Streams view, account-level transcoders and distribution
  (ABR/aliases/origins), audit log, at-rest encryption, mongodump backups
  with nightly timer, Zabbix panel-status item. API ground truth pinned by
  live dump + full-reference inventory tooling (tools/).

- **iter2 m1 (v0.3.0)** — WMSPanel control plane: system Settings page
  (WMSPanel API creds, manageable base URL .com/.ru, control-plane switch
  primary/backup), server↔WMSPanel mapping, persistent Republish management
  incl. "Switch source". See CHANGELOG.md.

- **iter1** — foundation: JWT auth; roles (superadmin / admin / custom with
  granular per-function permissions); Nimble servers CRUD + connectivity
  test; native API client (salt/md5 token auth); per-server views: Streams,
  Sessions, SRT stats, Republish (ephemeral — native API limit), MPEG-TS,
  Playout, Control; Zabbix endpoints; shell-script deployment.
- **iter1_r2** — deployment rework: open-source (MIT); APT distribution
  (deb + signed repo on GitHub Pages, built by CI); debconf domain/port
  prompts at install; ghcr pre-built images; systemd unit + `nnm-control`
  CLI; superadmin moved from env bootstrap to web first-run setup guarded by
  a one-time setup token.

## Known architectural limits (Nimble native API, by design)

1. Republish rules created via the native API are **not persistent** across
   Nimble reloads (official docs); persistent rules need WMSPanel API or
   host-side config management — planned iteration.
2. Persistent SRT/MPEG-TS/application settings creation is not exposed by
   the native API — read-only sections for now.
