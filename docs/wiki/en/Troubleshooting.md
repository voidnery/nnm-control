# Troubleshooting

English · [Русский](../ru/Troubleshooting.md)

## The panel

**The panel does not open after an update.** `nnm-control status` and `nnm-control logs backend`. If the
images could not be pulled during the update, the panel stayed on the previous version — fix the network
and run `sudo systemctl restart nnm-control`.

**Forgot a password.** An administrator sets a user's password on the **Users** page. Only the
superadmin can edit the superadmin account, and the panel has no way to recover its password — keep it in
a password manager.

**Lost the phone with 2FA.** Sign in with a backup code. No codes — an administrator clicks **Reset 2FA**
(the superadmin's 2FA is reset only by the superadmin).

## Servers

**A server has no live state and no charts.** Check **Host**, the management port and token in the
server's card, and `management_listen_interfaces` in `nimble.conf`: the panel's address must be allowed.
On the charts tab **Why is data missing?** shows which request failed.

**No stream settings tabs.** The server is not mapped to a WMSPanel server — pick it in the card (the list
fills once WMSPanel API keys are set).

**The change is in the panel but not on the server.** WMSPanel delivers changes to Nimble on a cycle of
about 30 seconds. If it takes longer, check the server in WMSPanel itself.

**The WMSPanel limit is running out.** The remainder is on the dashboard. Do not poll `GET …/streams` often
from your programs — to follow streams there are the `stream.up` / `stream.down` events, which do not
spend the limit.

## The agent

Look at the message on the **Agents** page — the table of meanings is on
[Servers and agents](Servers-and-agents.md#when-the-agent-is-silent). Most often:

- the agent cannot reach the panel at the address in the install command — set **Public address of this
  panel** and issue the command again;
- `journalctl -u nnm-agent -n 50` on the server shows the cause.

## Playlists

**Deployed, but nothing changed on air.**

1. The right file? By default the panel writes `server_playlist.json`; if Nimble reads another, pick it in
   the **On the server** panel. Versions before 1.32.0 suggested `playlist.json` and
   `server-playlist.json` — after updating, check whether such files from earlier deploys are left on
   the server.
2. Did a changed block keep its old `Id`? The panel renews it on write; if the file was edited by hand,
   change the `Id` (the **New Id** button).

**The stream played once and went silent.** The block has no `MaxIterations` (Nimble's default is once).
Set `0` — endless.

**The file is there but does not play.** Nimble Playout plays only MP4 and MP3:
`ffmpeg -i file.mov -c copy -movflags +faststart file.mp4`.

**"Some files are missing on the server".** Upload them (**Upload a file**) or check the path. Files outside
the directory the agent may read are marked "cannot be checked", not "missing".

## API and webhooks

**`401`.** The token is revoked, expired, or the request came from an address that is not allowed. The
token's last use is on the **API tokens** page.

**`412 precondition_failed`.** The object was changed after you read it — read `details.current` and
repeat with the new `ETag`.

**Webhooks do not arrive.**

- **Webhooks → Deliveries** — the answer code and error of every attempt.
- "refused" in the error — the address is forbidden by the rules (loopback, link-local, the panel's own
  machine).
- The subscription turned itself off after 50 failures in a row — fix the receiver and **Turn on**.
- A `3xx` answer — redirects are not followed; give the final address.

**Duplicates arrive.** That is expected: delivery is "at least once". Drop repeats by `id`.

**`server.*` and `stream.*` do not arrive.** Is watching on? (**Webhooks → Watching servers and streams**.)
Is Nimble's own API set up for the server? Remember that the first poll after the panel starts gives no
events.
