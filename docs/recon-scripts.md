# Reconnaissance scripts

A reconnaissance script is copied to somebody else's machine and run there
once. Everything below follows from that one sentence, and every rule here was
paid for by a script that failed on its first run.

## It is standalone

**No imports beyond Node's own modules.** The first version of `wms-recon.mjs`
imported `mongoose` and the panel's models, to read credentials out of the
database. Those exist together only inside the container — which is not where
anybody runs a one-off script. It died on its import line.

**No arguments it can find for itself.** Credentials come from the command
line, not from the panel's settings: a script that reads the database needs the
database, its models, and a decryption key. `apiKey` is stored encrypted with
the decryption on a schema getter, so a driver-level read returns ciphertext,
every request comes back 403, and the output reads as "the API refuses us" when
in truth nothing was asked properly.

**No assumption of a repository.** The second version told the operator to
redirect its output into `../docs/`, which exists in a clone and nowhere else.
The shell answered `No such file or directory` and the run was lost.

## It writes its report beside itself

Not to stdout alone, and not to a path derived from the current directory. The
script knows where its own file is; that is the one location it can be certain
about. It prints the path afterwards so nobody has to guess.

**The report is written whichever way the run ends.** An early `process.exit`
skipped it entirely, so a run that failed at the first request left nothing
behind — not even the record of why. Failures throw; the report is written in
both branches.

## It cannot change anything by accident

**Read-only by default.** Discovering which methods a route accepts means
sending them, and a POST that succeeds changes something. Write probing is
behind a flag that has to be typed.

**An empty body does not guarantee refusal.** This was the reasoning behind
probing writes with `{}` — the API would reject it, a `400` would prove the
method, nothing would change. WMSPanel answered `200`: the `PUT` was
*executed*. It happened to be harmless because every update field there is
optional, so an empty body is a no-op. That is luck, and a safety argument that
depends on luck is not one.

What is actually safe: `POST` to a collection with an empty body, which cannot
create a valid object; and reading the documentation for anything else. If a
write must genuinely be tested, create an object of your own to test against
and remove it by hand — never probe one that belongs to somebody.

**DELETE is never sent.** Unlike POST and PUT, no body makes it harmless:
against a real id it either fails or removes something real. Whether a family
accepts DELETE is read from the vendor's documentation, which lists it beside
the POST and PUT it documents.

**Write methods are asked where they live.** `PUT /collection/{id}`, not
`PUT /collection`. An inventory that asked the collections recorded 404 for
almost every write and looked conclusive; a collection is supposed to refuse
them, so the whole column meant nothing.

**Paths are a written-down list, never generated.** A script that explores an
API by permutation is one that eventually sends a request nobody meant.

## Its list of paths comes from the vendor's documentation

Not from what the paths ought to be called. The first WMSPanel inventory tried
`/settings` and never `/global` — and `global` is the spelling Softvelum's own
RTSP control API article uses. An entire family read as absent because of a
word.

The documented pattern is `/server/<id>/<protocol>/<object>`; deriving the list
from that covers combinations nobody would have thought to type, while every
path is still named rather than crawled.

**Cite the source next to the list.** The next person should be able to check
it rather than trust it.

## It removes secrets from its own output

A live application carries `push_login` and `push_password` in plain text. The
report is a file, and the file gets pasted into a chat window — so credentials
are replaced in the object before anything is printed, not hidden at the point
of printing. Removing them at the source means no later addition to the script
can leak them by forgetting.

`wms-apps-recon.mjs` reports `<set, 7 chars>` or `<empty>`: enough to answer
"are credentials configured on this application", which is a real question,
without carrying the answer to a different one.

## Its logic is testable without a network

The verdicts are the part of a recon script that gets believed, and they are
exactly the part that never runs before the one real run. So the reasoning is
exported and tested against fixtures and a stub server — see
`backend/tests/apps-recon.test.mjs`.

Which means the script must be importable: `main()` runs behind a check that
the file is the one being executed. An earlier draft exited on its usage line
during the import and took the whole test file with it.

**And the test has to exercise the path it checks.** The masking check first
ran without `--full`, so the application JSON was never printed and the check
passed with masking removed entirely. A check that cannot fail is not one.

## It says what it will cost before it runs

The WMSPanel account has a ceiling of 15000 API calls a day. A tool that
consumes somebody's quota without warning is one they cannot afford to run
twice.

## It distinguishes "no" from "not asked"

This is what the whole exercise is for. A probe that sends one method and finds
nothing has learned that it found nothing — not that the thing is absent.

- `404` — no such route.
- `405` — the route exists and refuses that method.
- `400` / `422` — the route exists and the request was wrong.
- `403` on everything, including a known-good control probe — credentials or an
  IP allow-list, and nothing else in the output means anything.

Every reconnaissance script carries a **control probe**: one request known to
work. Without it, a blanket failure is indistinguishable from a missing
feature — and that mistake has been made here more than once.

## What a wrong conclusion costs

`docs/STATE.md` recorded that DVR could not be managed through the WMSPanel
API. It can. The probe behind that note sent `GET` and `DELETE`, found no
`POST`, and "we did not find a write method" was written down as "there is no
write method". It was repeated for weeks and used to decide what to build.

Three more families — `geo`, `asn`, transmuxing settings — were recorded the
same way and are suspect for the same reason.
