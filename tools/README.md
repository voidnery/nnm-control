# Tools


## wmspanel-transcoder-dump.sh

Walks the whole WMSPanel **transcoder "Scenario"** API subtree — list →
scenario → video/audio pipeline → input/filter/output — plus the transcoder
license view, and emits both raw JSON and a **redacted field-schema summary**
(`_schema.txt`, values masked) so the pipeline editor can be built from the
real structure.

```
CLIENT_ID=xxx API_KEY=yyy BASE_URL=https://api.wmspanel.com/v1 \
  ./wmspanel-transcoder-dump.sh
# optional: MAX_TRANSCODERS=5
```

Transcoders live on the **.com** account in this deployment — set BASE_URL
accordingly. Share `_schema.txt` (safe); keep the raw `*.json` private (outputs
may carry stream keys / RTMP URLs).


### Fix: scenario needs ?details=true

`GET /transcoder/{id}` returns metadata only **unless** `?details=true` is
passed — then the response includes `video_pipelines[]` and `audio_pipelines[]`
(each with `inputs[]`/`filters[]`/`outputs[]`; inputs carry a `main` flag).
The dump script now always requests `details=true` and parses those arrays.
The earlier "no pipelines" result was this missing parameter, not empty data.

### Finding: pipeline schema needs a populated transcoder

A dump of 5 production transcoders (all "MultiWall*" passthrough) showed
`GET /transcoder/{id}` returns **metadata only** (id, name, description,
paused, server_id, tags, out_of_process) — **no `pipelines`**. WMSPanel embeds
pipeline ids in the scenario response only when pipelines exist, and there is
no separate "list pipelines" endpoint. So the input/filter/output field schema
can't be derived from passthrough transcoders.

To build the pipeline editor, dump ONE transcoder that actually transcodes:

```
CLIENT_ID=xxx API_KEY=yyy BASE_URL=https://api.wmspanel.com/v1 \
  TRANSCODER_ID=<id-with-pipelines> ./wmspanel-transcoder-dump.sh
```

The script now prints a per-transcoder pipeline count and says explicitly when
none of the sampled transcoders have pipelines.
