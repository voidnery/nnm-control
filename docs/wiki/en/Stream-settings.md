# Streams: settings, transcoders, categories, functions

English · [Русский](../ru/Stream-settings.md)

## Where stream settings live

In WMSPanel mode, stream settings (UDP/SRT outputs, MPEG-TS inputs, RTMP Pull and Push, hot swap,
applications) are kept in WMSPanel. The panel reads and writes them through the WMSPanel API — on the
tabs of the [server page](Servers-and-agents.md#the-server-page), in functions, in categories and through
the [API](API.md#stream-settings). Nimble gets the change on the next WMSPanel sync cycle — about 30
seconds later.

Every change is a `stream_object.*` event (see [Events and reactions](Events-and-reactions.md)).

## Transcoders

**Broadcast → Transcoders** (viewing — `wmsobjects.view`, actions — `wmsobjects.manage`; WMSPanel mode
only).

- **A transcoder cannot be created from the panel**: the WMSPanel API has no such method. Create it in
  WMSPanel; here you view, clone and edit it.
- **Pause**, **Resume**, **Clone** (the copy is created paused), edit, delete (pipelines are removed for
  good). Pause and resume work in bulk too.
- There is deliberately no bulk restart — use a [function](#functions) for that.
- State: flowing, partial, no output, paused, unknown.
- **Refresh scenario details** spends WMSPanel API calls.

## WMSPanel objects

**Infrastructure → WMSPanel objects** — account-level settings, applied to the servers you tick:

- **ABR** ladders;
- application **aliases** (HTTP, RTMP, RTSP, SRT by default);
- **origin apps** — put an application in HTTP Origin mode. Such an edge does not cache — the
  distribution page shows it as a blocker.

## Categories

**Infrastructure → Categories** (`category.view` / `category.manage`) — named groups of streams from
different servers, to handle them together. They hold: SRT Out, SRT in Nimble, SRT In, RTMP Pull,
RTMP Push, Hotswap.

1. **New category**.
2. **Add streams**: server and kind → **Load objects** → tick.
3. Each stream shows its state: running, stopped, not found on the server.

Actions — **Start**, **Stop**, **Restart** — apply to the ticked streams, or to all if none are ticked,
after a confirmation. Restart exists only where WMSPanel has it (SRT in Nimble, RTMP Push, RTMP Pull); for
the others use a "stop — wait — start" function. The result can be partial — each stream shows what
happened. Everything goes to the audit log.

## Functions

**Broadcast → Functions** — engineering macros: a sequence of steps over WMSPanel streams with the result
verified and automatic rollback. Building — `functions.manage`, running — `functions.execute` (a custom
role can run only the functions assigned to it). WMSPanel mode only.

### Build

1. **New function** → **Add a step**:
   - change (object fields);
   - pause, resume, restart;
   - wait;
   - ready-made steps: switch the video/audio source of SRT in Nimble, switch the RTMP Push destination.
2. **Execution variants** — the same steps with different values (say, "main" and "reserve"). A function
   with variants is run with a variant picked.

### What happens on a run

1. **Preflight**: the server is mapped, the object exists, the fields to change exist. If not, nothing is
   changed.
2. Each step: snapshot → change → **verification** that Nimble actually applied it (polled every 5 s, up
   to 180 s — WMSPanel delivers changes in cycles of about 30 s). For SRT in Nimble, also the "synced"
   status.
3. A restart where WMSPanel cannot restart is done as "stop — hold — start"; the default hold is 40 s
   (**Hold stopped for (seconds)**). Too short a hold can be batched away, and the stream never stops.
4. **If a step fails, all steps done so far are rolled back in reverse order.** Result: rolled back, or
   "rollback failed". Restart and wait cannot be rolled back.

**Run history** — the last 50 runs, with a live trace. **Clear runs older than 3 days** leaves running
ones alone.
