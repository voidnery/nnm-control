# The privileged helper, directive by directive

Written after five releases lost to the same class of fault: assuming something
about the machine that turned out to be decided elsewhere. Each fix was
correct, each was one layer deep, and each was shipped with "it should install
now". This is the pass that should have come first.

The question for every line is the same one: **what does this require of a
clean Ubuntu, and is it there at the moment it is required?**

---

## The unit

| Directive | Requires | On a fresh machine | Verdict |
|---|---|---|---|
| `User=root` | nothing | — | fine |
| `EnvironmentFile=` | the file, at start | written by the installer first | fine |
| `ExecStart=$NODE_BIN $BIN` | both binaries | both located and verified before writing the unit | fine |
| `StateDirectory=` | nothing | systemd creates it, and it is **read-write even under `ProtectSystem=strict`** | fine |
| `ProtectSystem=strict` | nothing | — | fine |
| `ProtectHome=yes` | nothing | — | fine |
| `PrivateTmp=yes` | nothing | — | fine |
| `ReadWritePaths=` | **every path to exist at start** | five of ten do not | **this is what failed** |

---

## The failure, in full

```
Failed to set up mount namespacing: /etc/letsencrypt: No such file or directory
status=226/NAMESPACE
restart counter is at 740
```

systemd builds the mount namespace *before* the process runs. A path in
`ReadWritePaths` that does not exist fails the unit outright.

Five of the ten only appear once nginx and certbot are installed — by this very
helper, which cannot start in order to install them. A service that cannot run
until it has done the thing it runs to do.

### Why `-` alone is not the fix

A `-` prefix makes systemd ignore a missing path. That stops the crash and
achieves nothing else, because **the namespace is fixed at start**. certbot
runs *inside* it as a child of the helper, so on a machine where
`/etc/letsencrypt` was absent at start, certbot cannot create it: everything
outside the allow-list is read-only.

This is the part that would have caught me twice.

### Why `ExecStartPre` is not the fix either

It runs inside the namespace too — after it has already failed to be built.
There is no hook late enough to be useful and early enough to help.

### What is the fix

The installer creates every path with `mkdir -p` **before writing the unit**,
while the filesystem is still ordinary. The `-` prefixes stay as a second line
for a path the list gains and the script forgets.

---

## The restart loop

`RestartSec=2` with no limit meant 740 restarts before anyone looked. A unit
that cannot start should be **visibly stopped**, not quietly spinning: ten
seconds, five attempts, then it stays down where somebody will see it.

---

---

## Two agents, one machine

The helper runs the same binary and inherits the agent's whole environment —
including `NNM_AGENT_SERVER_ID`, without which it could not reach the panel at
all. So a gateway has two agents polling as the same server, and that has three
consequences worth writing down.

**The queue handed tasks to whichever asked first.** A system change went to the
ordinary agent about half the time and came back "this agent is not the
privileged helper", surfacing as `apply-failed` with the reason discarded.
Tasks are targeted now: an ordinary agent cannot *see* a system task, rather
than being bad at running one.

**One `lastHealth` per server was overwritten by whichever polled last**, so the
`privileged` flag flapped — the panel said "no helper" and then stopped, with
nothing having changed on the machine. The helper has its own record.

**Two instance ids alternating read as a restart every time**, and that counter
climbed forever. Only the ordinary agent's identity counts now.

And a machine with no helper is refused immediately rather than waiting thirty
seconds for a task nothing can claim — a timeout reads as a network problem,
which is the wrong place to look.

---

## Why the filesystem sandbox came off

`ReadWritePaths` was the point of the separate unit, and it turned out to be
incompatible with the unit's job.

`apt-get install nginx` writes `/usr/sbin`, `/usr/share`, `/var/cache/debconf`,
`/var/lib/update-notifier`, `/var/log/apt` — and whatever else the package's
maintainer scripts touch. That set belongs to the package, not to us, and it
differs per package. **Every value of `ProtectSystem` makes `/usr` read-only**,
`true` included, so there is no setting that permits installing software and
also constrains where it writes.

Enumerating paths was a treadmill: each attempt added the ones the previous
failure had named, and the next package would name more.

### What the limits are now

| Lock | Where it lives | Holds against |
|---|---|---|
| Six permitted binaries | the helper's own code | a compromised panel |
| File writes to ten paths | the helper's own code | a compromised panel |
| Loopback only | the unit | anything off the machine |
| Installed per machine, on purpose | the operator | itself |
| One command to remove | the operator | itself |

Both allow-lists were always in the helper as well as in systemd — systemd was
the belt, not the trousers. What is lost is defence against a **malicious
package**, and nothing in this design could have provided that: root running
`apt-get` can do anything a package tells it to.

So the honest description changed. It is no longer "root scoped to ten
directories". It is **root that can run six named programs**, which is what
installing software has always meant. Claiming the stronger property was the
mistake, and it survived four releases because nothing tested it against a real
package install.

## The rule this leaves behind

Anything the helper assumes about the machine must be **derived from what
creates it**, not written down twice:

| Assumption | Where it actually comes from |
|---|---|
| the agent binary path | `STATE_DIR` in the installer |
| node's path | `STATE_DIR` in the installer |
| environment variable names | what the agent reads |
| writable directories | the same list that the installer creates |

Every one of those is now a check that reads both sides and compares them. Not
one of them was, and each cost a release.
