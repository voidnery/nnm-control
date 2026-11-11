# Dashboard and logs

English · [Русский](../ru/Dashboard-and-logs.md)

## Dashboard

**Dashboard** — what each server is doing now and what it has been doing.

- At the top: how many servers are **reporting**, how many are **silent** (no agent contact for more than
  70 s) and how many are **without an agent**.
- A card per server: CPU (warning above 85%), memory (above 90%), swap (above 5%), network; charts of
  CPU, memory, network and the busiest streams.
- **WMSPanel API left today**: spent, limit, when it resets, projection to midnight. The panel counts only
  its own calls — the real remainder may be lower.
- **Range** 15 min … 24 h, **Dashboard settings** (which charts, 1–3 columns, refresh, streams per
  server) — each user has their own.

The machine data comes from agents: an agent and **Host metrics from agents** turned on in Settings are
needed, otherwise the charts are empty.

## Logs

**Logs** — the Nimble log from every server in one place. Viewing — `streams.view`. Needed: the agent on
the server and **Nimble log collection** in Settings (anyone with `settings.manage` can switch it on right
from the page with **Turn it on**; agents pick it up in about half a minute).

- `nimble.log` is collected (more files can be added in Settings). Storage is capped (512 MB by default)
  — old records are pushed out by themselves. At debug level one server writes about 1 GB a day.
- Filters: server, range (up to **Everything held**), text, level (E/W/I/V/D), subsystems.
- **Grouped** (default) — identical messages fold into templates; click for samples.
- **Chronological** — the lines as they are; **Follow** — refresh every 5 s.
- A search is capped at 60 000 records and 8 seconds; when it hits the cap, the panel says to narrow
  the range.

### Log windows

**Log windows** sort the log by topic: SRT, RTMP, Transcoder, Playback/HTTP, Pull ingest, DVR, Core,
Other — with record and error counts. Empty windows are shown, not hidden; anything that fits no window
goes to Other.

### Log dashboards and links

**Log dashboards** (`logs.manage`): **New dashboard** → **Add window** → 1–4 columns, height, width,
range → **Save changes**.

**Issue link (7 days)** or **(no expiry)** — for people without a panel account. The link is shown once;
**Revoke** works at once. The link shows only that dashboard's windows. Stream keys are hidden in it, but
IP addresses, stream names and error text are **not** — think about who you give it to.
