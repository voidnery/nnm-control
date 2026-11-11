# Getting started

English · [Русский](../ru/Getting-started.md)

## What you need

- An Ubuntu/Debian machine with internet access (the panel runs in Docker; the package installs it).
- A DNS name pointing at that machine — you will open the panel by it.
- The Nimble Streamer servers the panel will manage. If they are in WMSPanel — WMSPanel API keys.

## Install

```bash
wget -qO- https://voidnery.github.io/nnm-control/apt/gpg.key \
  | sudo gpg --dearmor -o /usr/share/keyrings/nnm-control.gpg
echo "deb [signed-by=/usr/share/keyrings/nnm-control.gpg] https://voidnery.github.io/nnm-control/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/nnm-control.list
sudo apt update && sudo apt install nnm-control
```

The installer asks for:

- the **panel domain** — a DNS name whose A record points at the machine;
- the **panel port** — `8090` by default.

It creates the secrets in `/etc/nnm-control/nnm-control.env` (root only), pulls the images and starts
the panel. Secrets are created once and kept across upgrades.

> `JWT_SECRET` in that file not only signs sign-ins but also encrypts secrets in the database (keys,
> server tokens). Do not change or lose it: without it the encrypted data cannot be read.

> There is a second install path — through Eterix DIST-Control (`eterix-updater` with a database
> snapshot and automatic rollback). Never add both sources on one machine.

## First sign-in

1. Get the setup token: `sudo nnm-control setup-token`.
2. Open `http://<domain>:<port>`. While there is no superadmin, the panel shows **First-run setup**.
3. **Setup token**, **Superadmin username**, **Password** (at least 8 characters), confirmation —
   **Create superadmin**.

After that the setup token opens nothing. There is one superadmin; create other users on the **Users**
page (see [Access](Access.md)). Turn on two-factor authentication for yourself right away:
**Profile → Set up 2FA**.

## Preparing the Nimble servers

On every server, in `/etc/nimble/nimble.conf`:

```
management_listen_interfaces = <IP the panel will reach the server on>
management_port = 8082
management_token = <long random token>
```

then `sudo service nimble restart`. Through this "own API" the panel reads server state, live streams
and statistics — without spending the WMSPanel limit.

> Never expose Nimble's management port to the internet. Only to the panel's address or inside a VPN.

## Connecting WMSPanel

If the servers are managed through WMSPanel (the usual case):

1. In WMSPanel: **Control → API setup → Pull API** — enable it, copy the Client ID, generate an API
   key, whitelist the panel's public IP.
2. In the panel: **System → Settings → WMSPanel API** — the API address (`https://api.wmspanel.com/v1`
   or `https://api.wmspanel.ru/v1`), Client ID, API key → **Test connection** lists the visible servers.
3. **Control plane → WMSPanel API** → **Save settings**. The panel immediately takes the server list from
   WMSPanel and keeps checking it every 10 minutes.

**The WMSPanel limit is 15 000 calls a day per account.** The panel spends them only on changes and
lists; statistics and checks come from Nimble's own API. Today's remainder is on the dashboard. The panel
counts only its own calls: if someone else uses the WMSPanel account, the real remainder is lower.

Without WMSPanel the panel runs in the backup **Native Nimble API** mode: changes are applied on the
server directly but are temporary — they are lost when Nimble reloads its configuration and are not
seen in WMSPanel.

## Servers

Servers from WMSPanel appear on their own. Open **Edit** on each and check:

- **Host** — the address the panel reaches Nimble's own API on;
- the **management token** — the one from `nimble.conf` (without it there is no live state and no
  statistics);
- **Playback endpoints** — where viewers watch from (for the Watch button and links);
- **HTTPS port** — for LL-HLS.

Details — [Servers and agents](Servers-and-agents.md). Playlists and logs need the agent on the server —
the same page says how to install it.

## What to turn on in Settings

What creates load is off by default:

| Setting | What for | Default |
|---|---|---|
| **Collect metrics** | charts of streams, RTMP Push, SRT and server counters | off; every 10 s, kept 3 days |
| **Host metrics from agents** | CPU, memory, network on the dashboard | off; every 10 s |
| **Nimble log collection** | the Logs page | off; file `nimble.log` |
| **Public address of this panel** | the agent install command and dashboard links, when the panel is behind a proxy | empty — taken from the browser address |

All sections are saved with one **Save settings** button at the bottom of the page.

## Updating

```bash
sudo apt update && sudo apt upgrade
```

New images are pulled before the restart. If the pull fails, the panel is not restarted and keeps
running the old version; fix the network and run `sudo systemctl restart nnm-control`. A backup before
updating is a good idea.

## Maintenance

```bash
nnm-control status          # service state
nnm-control logs [service]  # logs (backend, web, mongo)
nnm-control restart         # restart
nnm-control configure       # ask for the domain and port again
nnm-control backup          # database backup (also made every night)
nnm-control backups         # list of backups
nnm-control restore <file>  # restore — REPLACES the whole current database
nnm-control version
```

- Backups are in `/var/lib/nnm-control/backups`; the last 14 are kept (at most 20 GB). No backup is made
  if the disk has less free space than twice the last backup.
- `apt remove` keeps settings and data; `apt purge` removes the settings, while the data (Docker volumes
  `nnm-control_mongo_data`, `nnm-control_media_spool`, `nnm-control_geoip_db`) stays until you remove it
  by hand.
