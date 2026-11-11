# Access: users, roles, audit

English · [Русский](../ru/Access.md)

## Who is who

| Type | What they can do |
|---|---|
| **Superadmin** | Everything. There is one, created at first start. Its role cannot change and the account cannot be deleted; only the superadmin edits it. Only the superadmin creates and deletes admins and resets their own 2FA. |
| **Admin** | Every permission. |
| **Custom role** | Only the permissions of its role. |

## Users

**Access and audit → Users** (`users.manage`).

- **New user** — username, password, role. Use a password of at least 8 characters: this form does not
  check the length; only the password change in the profile does.
- Untick **Active** — the user loses access at once, on the very next request.
- **Reset 2FA** — for someone who lost their phone. The action goes to the audit log.

A sign-in lasts 12 hours (`JWT_TTL` in `/etc/nnm-control/nnm-control.env`). Changing a password does not
end sign-ins already issued — to lock someone out right away, untick **Active**.

## Roles

**Access and audit → Roles** (`roles.manage`). A role is a name, a description and a set of permissions.
For `functions.execute` you also pick which functions the role may run. A role assigned to users cannot be
deleted — reassign them first.

### Permissions

| Permission | What it gives |
|---|---|
| `servers.view` / `servers.manage` | see servers and their state / add, change, delete |
| `streams.view` | live streams and RTMP settings; the dashboard and logs |
| `sessions.view` / `sessions.manage` | viewer sessions / disconnect viewers |
| `srt.view` | SRT statistics |
| `republish.view` / `republish.manage` | RTMP republish rules |
| `mpegts.view` | MPEG-TS state and settings |
| `wmsobjects.view` / `wmsobjects.manage` | WMSPanel objects: UDP/SRT outputs, MPEG-TS, hot swap, live pull, applications, transcoders |
| `playlist.view` / `playlist.manage` | Nimble playlists |
| `logs.manage` | log dashboards and their links |
| `category.view` / `category.manage` | stream categories and bulk actions |
| `functions.manage` / `functions.execute` | build functions / run the allowed ones |
| `cdn.view` / `cdn.manage` | delivery networks, node roles, geography |
| `control.manage` | reload Nimble config and certificates, sync with WMSPanel |
| `zabbix.view` | addresses for Zabbix |
| `settings.manage` | system settings and WMSPanel API keys |
| `audit.view` / `audit.manage` | the audit log / removing machine entries |
| `users.manage` / `roles.manage` | users / roles |
| `apitokens.manage` | API tokens |
| `webhooks.manage` | webhook subscriptions and server watching |

## Profile

**System → Profile** — everyone has their own:

- theme (system, dark, light) and language (EN/RU);
- **Change password** — needs the current one; the new one at least 8 characters.

### Two-factor authentication

1. **Set up 2FA** — scan the QR code with an authenticator app (or enter the key by hand).
2. Enter the **Authentication code** → **Enable 2FA**.
3. The panel shows **10 backup codes — once**. Each works once. Save them and click **I saved them**.

From then on, sign-in asks for the 6-digit code or a backup code (within 5 minutes of the password).
Turning 2FA off needs both the password and a code. "Code did not match" usually means the phone's clock
is off.

## API tokens and webhooks

Programs get not people's accounts but [API tokens](API.md#token): a token has its own rights, its own
list of allowed addresses and an expiry, and can be revoked without touching people. Sending events out —
[Webhooks](Webhooks.md).

## Audit log

**Access and audit → Audit** (`audit.view`).

- Every change is recorded (views are not), sign-ins — successful and failed — 2FA actions, function runs.
  Passwords, tokens and keys are hidden in the records.
- Program actions are recorded as `token:<name>#<id>`.
- Filters: **User** (exact match), **Action contains…**, outcome. 200 records at a time; **Load older**
  — further.
- Records are kept 30 days.
- **Clean up the log** (`audit.manage`) removes only the machine entries of agent polling, never people's
  actions. After removal the log is compacted and may be unavailable for a few minutes.

## Zabbix

**Infrastructure → Zabbix** (`zabbix.view`) — addresses for Zabbix HTTP items:

| Address | What it returns |
|---|---|
| `GET /api/zabbix/panel` | version, database link, servers total / mapped, age of the WMSPanel sync (`fleet_sync_age_sec`, -1 — never yet), function runs in 24 h |
| `GET /api/zabbix/app` | uptime, process memory, database link, number of servers |
| `GET /api/zabbix/system` | load 1/5/15 min, cores, memory used %, root disk fill |

The token goes as `?token=…` or the `X-Zabbix-Token` header. The page shows only the placeholder
`<ZABBIX_TOKEN>`; the token itself is in `/etc/nnm-control/nnm-control.env`, line `ZABBIX_TOKEN`. One HTTP
item plus dependent items with JSONPath works well (`$.load_1m`, `$.mem_used_percent`,
`$.disk_root.used_percent`). Alert: `fleet_sync_age_sec` above 900 in WMSPanel mode — the panel has not
synced for a long time.
