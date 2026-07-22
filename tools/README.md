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
