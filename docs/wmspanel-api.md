# WMSPanel API inventory

**This file is the answer to "does WMSPanel let us do X".** Read it; do not
recall it.

It is empty until somebody runs the inventory:

```
cd backend
node tools/wms-dump.mjs <client_id> <api_key> --probe-writes > ../docs/wmspanel-api.md
```

## Why this file exists

A note in `docs/STATE.md` recorded that DVR could not be managed through the
API. It was wrong. The probe behind it asked `GET` and `DELETE` on
`dvr_streams`, found no `POST`, and "we did not find a write method" was
written down as "there is no write method". That conclusion was then repeated
for weeks and used to decide what to build.

The same shape produced three more entries — `geo`, `asn`, and the transmuxing
settings — and at least one of them may be wrong for the same reason. **None of
them should be trusted until they appear in a table below with a status code
next to them.**

## The rule

Any question or decision that turns on what the WMSPanel API can do is answered
from this file. If the answer is not here, the inventory is re-run and the file
is regenerated — that costs a minute. Asserting an API limit from memory has
cost weeks.

Specifically:

- **Never say a family is read-only** without a `405` or a `404` in this table
  against the write methods.
- **`404` and `405` are different answers.** The first means no such route; the
  second means the route is there and refuses that method. A probe that only
  sends `GET` cannot tell them apart, which is exactly how the DVR entry went
  wrong.
- **A `403` on everything, including `/server`,** means the credentials or the
  IP allow-list — not the API. The inventory carries `/server` as a control for
  this reason.

## Safety of the inventory itself

Discovering which methods a route accepts means sending them. Two things make
that safe:

- `GET` only by default; write probing requires `--probe-writes`, typed
  deliberately.
- Write probes carry an **empty body**, so the API rejects them. A `400`
  "missing parameter" proves the route accepts the method as surely as a `201`
  would, and creates nothing.
