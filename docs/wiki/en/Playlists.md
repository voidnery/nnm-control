# Playlists

English · [Русский](../ru/Playlists.md)

A Nimble server playlist (Nimble Playout) turns MP4/MP3 files on the server into an output stream on a
schedule. In the panel a playlist is built in an editor, stored, checked and written to the server —
without editing JSON by hand.

Rights: `playlist.view` — viewing; `playlist.manage` — creating, editing, deleting, deploying, stopping
and starting streams, rolling back, uploading and deleting media. Writing to a server needs the
[agent](Servers-and-agents.md#the-agent-on-the-server).

## How a playlist is built

**Task → Blocks → Sources.**

- **Task** — one output stream `application/stream` (e.g. `live/news`). `InactivityTimeout` — after how
  many seconds without data the stream counts as stopped (Nimble's default is 30; 0 — never).
- **Block** — a piece of the broadcast: `Id`, name, `Start` (GMT time `YYYY-MM-DD HH:MM:SS`), `Duration`,
  `TotalDuration`, `MaxIterations`, default source.
- **Source** — a file (`vod`) or a live stream (`live`): path, start offset, duration, Icecast titles,
  subtitles, SCTE-35 markers.

Two things people usually trip over:

1. **`MaxIterations`.** By Nimble's default a block plays **once**, and then the stream stays on air
   empty. `0` — endless loop. New blocks in the panel are created with `0`; a block with neither
   `MaxIterations` nor `TotalDuration` makes the editor warn.
2. **MP4 and MP3 only.** Nimble Playout does not play `.mov`, `.mkv`, `.ts`. Repackage without
   re-encoding: `ffmpeg -i file.mov -c copy -movflags +faststart file.mp4`.

## Create a playlist

1. **Broadcast → Playlists → New playlist**; the name is required.
2. **Check against server** — optional: the editor marks files missing on that server and offers that
   server's files to pick from.
3. Add a task, a block in it, sources in the block.
4. **Interleave adverts** — optional: the chosen files go before every Nth item. Applying it again
   replaces the earlier insertion.
5. **Save.** A saved playlist affects nothing until it is deployed.

**Import JSON**, **Show JSON** and **Download** are there for moving and checking.

## Upload media

On the server, in the **On the server** panel — **Upload a file**. The panel takes the file first, then
the agent fetches it in the background (up to 12 hours; while the panel still holds the file you can
**Retry**). Disk space is checked beforehand.

A file cannot be deleted while `server-playlist.json` on that server refers to it — that entry would
play silence.

## Deploy to a server

**Deploy** → server → file name in Nimble's config directory.

> Check the file name. The Deploy dialog suggests `playlist.json`, while the **On the server** panel and
> the API default to `server-playlist.json`. Nimble reads the file named in its own settings — writing
> another file changes nothing on air.

What the panel does when writing:

- writes a **clean file** — without the editor's own fields and empty values;
- **renews the `Id` of changed blocks.** Nimble does not re-read a block whose `Id` is unchanged — even
  if its content changed. The panel compares with what is already on the server: a block with the same
  `Id` but different content, without an `Id`, or with a repeated `Id` gets a new one. Unchanged blocks
  keep their `Id` and do not restart;
- keeps the previous version — in the panel's history and as `.bak` on the server.

After writing, the panel says how many blocks got a new `Id` and which blocks will play once.

### When the panel refuses to write

| Reason | Can it be overridden |
|---|---|
| the file does not parse (broken) | no, never |
| the agent on the server is off | no — turn the agent on first |
| some files are missing on the server — those entries would play silence | yes (if the file is about to arrive) |
| the media list on the server could not be read — nothing to check against | yes |
| sources that are not MP4/MP3 | yes, but Nimble will not play them |
| the playlist is empty — writing it stops every playlist stream on the server | yes, if that is the intent |

"Write anyway" is `force` in the [API](API.md#playlists); stopping a stream (below) does it by itself.

## On the server

The **On the server** panel (on the Playlists page) shows what actually lies and plays on the chosen
server:

- the current playlist and whether the file was found (if not — which files are next to it: a name one
  character off is a common cause);
- media files: which are missing (`missing`) and which cannot be checked because they are outside the
  directory the agent may read (`unverifiable` — not the same as "missing");
- a **drift warning**: the file was changed after the panel last wrote it — the next deploy overwrites
  that change;
- advice: whether a stream loops or ends and when; joins where resolution, frame rate, codec, sample
  rate or number of audio channels change — players stumble on such joins.

### Stop and start a stream

- **Stop** — the task is removed from the file, and the file is written again. Other streams are not
  touched.
- **Stopped streams** — the list is built from the history of the last 50 versions:
  - **Start from the top** — from the beginning of the block;
  - **Resume where it stopped** — roughly from where it was stopped (estimated from the deploy times and
    file durations, rewound 3 seconds). It fails if the duration of any file is unknown.

Both are ordinary deploys with all the checks.

### History and rollback

**Deploy history** — every write: who, when, marked "forced" and "files were missing". **Roll back**
writes the chosen version again, through the same checks.

**Import into the panel** — take the playlist from the server into the editor as a draft.

## Events

Deploying, stopping and starting a stream are the events `playlist.deployed`, `playlist.stream_stopped`,
`playlist.stream_started` (see [Events and reactions](Events-and-reactions.md)). `playlist.deployed`
carries `renewed_ids`, `plays_once` and `unsupported` — the same the panel showed the operator.
