# iter8 — transcoders: from config editor to operator console

## The constraint that shapes everything

Softvelum's own Transcoder API post states the intended workflow: build scenarios
in the WMSPanel web UI, then **clone** them and adjust via API. Concretely the API
can clone a scenario, apply it to several servers (`servers_to_apply`), pause,
resume, delete, delete pipelines, change app/stream names on decoders/encoders,
and change basic parameters of *existing* filters.

It cannot create new pipelines or new elements.

So a drag-and-drop authoring canvas is not implementable against this API — we
would be building an editor whose output cannot be saved. The design therefore
targets what the API does support, and what the incumbent does poorly:
**operating** scenarios rather than drawing them.

## Milestones
* **m1 (done, v0.8.0)** — scenario graph with live state, read-only.
* **m2 (done, v0.8.1)** — template → clone → specialise → apply to servers.
* **m3 (done, v0.8.2)** — fleet view across servers with bulk actions.
* **m4 (done, v0.8.3)** — guarded editing within API limits, with diff and rollback.

## Facts pinned from the real account dump
* A pipeline is `{ id, inputs[], filters[], outputs[] }` with **no edges** — the
  chain is implied by array order.
* `split` / `asplit` fans the chain out to the encoders, but the API does not say
  which post-split filter belongs to which branch. A real scenario has three
  filters after the split feeding two encoders, so the mapping is genuinely
  ambiguous; the graph shows them grouped and says so instead of guessing.
* Typical video pipeline: `format` → `bwdif` → `split` → `fps(60)` / `fps(25)` →
  `picture` → `hevc_nvenc` + `h264` encoders.

## The unverified write path, and how m2 handles it
Pipeline element writes (PUT .../input|output/{id}) had never been exercised
against the live API (flagged since v0.5.2). Rather than making that an
operator's homework, the wizard proves the path itself: right after cloning it
reads one element, writes it back **unchanged**, reads it again and compares.
A no-op on a fresh paused copy is safe, and it distinguishes four outcomes —
accepted, rejected, silently stored differently (drift), or the element
disappearing. Anything but success aborts before a single real change is made.

Clone and scenario update were already exercised in production (the Clone button
and name/tag editing), so only the element path needed proving.


## Quota shape of the fleet view (m3)
Listing transcoders is **one** API call, but the pipelines of each scenario are
**one call each**. Refreshing a whole fleet on every screen paint would be the
same mistake the metric collector avoided. So scenario shape is cached in the
panel (`TranscoderCache`) and refreshed on demand, with the cost stated in the
UI before the operator presses the button. Health is then computed from the
panel's own metrics at no API cost.

Bulk restart is deliberately absent: transcoders have no restart endpoint, so it
would mean pause + hold + resume per scenario — minutes of dead air, en masse,
with no per-step trace. Functions already do that properly.


## What m4 lets an operator change, and why only that
Softvelum documents exactly two editable areas: application/stream names on
decoders and encoders, and basic parameters of existing filters. A PUT may well
accept a codec change too, but presenting undocumented fields as supported is
how an operator ends up trusting a change that silently does nothing. So those
fields are shown read-only, and the API refuses them unless a caller explicitly
opts in.

Every change is guarded: snapshot the element, write, read it back, compare with
what was asked for, and restore the snapshot if it does not match. A wrong value
live is worse than no change, and a half-applied scenario is worse than both, so
a failure stops the batch instead of continuing.
