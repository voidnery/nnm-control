# NNM Control agent

The only component that touches a Nimble box's filesystem. Deliberately
dependency-free (`node:http` + `node:fs`) so the whole trust surface can be read
in one sitting.

## What it can do
* read/write files in the **config directory** (playlists, configs)
* list/upload/delete files in the **media directory**
* **read, and only read, files in the log directory** (`iter10 m1`)
* report its own health

It cannot run commands, reach any other path, or list anything outside those
three directories. Names are single filenames — a name containing `/`, `..` or a
NUL byte is refused. The log directory has no write route at all, only
`GET /logs` and `GET /logs/read`, and only `.log`/`.txt` files are served, so a
key or certificate sitting next to a log cannot be fetched through it.

## Log reading

Nimble writes ~13 KB/s per server at debug level and rotates by size, so logs
are read as byte ranges rather than whole files:

    GET /logs                                  -> [{ name, size, mtime, ino, dev }]
    GET /logs/read?name=nimble.log&offset=N    -> { data, nextOffset, size, ino, eof }

Two properties the panel relies on:

* **a read is always trimmed to a whole number of lines.** Nimble writes
  multi-line records (raw HTTP dumps follow their header line with no
  timestamp), and a range split mid-line would corrupt the panel's framing.
* **`ino` identifies the file generation.** After rotation the same name is a
  different inode, which is how the collector notices instead of guessing from
  sizes. An `offset` past the end returns `truncated: true` rather than data
  from the middle of a fresh file.

Rotated copies (`nimble.log.1` …) are not served — their extension is not a log
extension. The panel follows the live file and reports any gap a rotation
caused rather than pretending the tail is continuous.

## Install

The panel installs this for you: **Agents → Install agent** issues a one-time
ticket and gives you a single command to run on the server. The agent's token is
generated on that machine and reported back; the panel never sends a credential
to a server and never holds an SSH key. Read the generated script first — the
dialog links to it — since you are being asked to run it as root.

The manual procedure below remains valid and is what the generated script does.

### Manual

    install -m 0755 nnm-agent.mjs /usr/local/bin/nnm-agent
    install -d -o nimble -g nimble /srv/nimble/conf /srv/nimble/media/gallery

    printf 'NNM_AGENT_TOKEN=%s\nNNM_AGENT_BIND=127.0.0.1\nNNM_AGENT_PORT=8090\n' \
      "$(openssl rand -hex 24)" > /etc/nnm-agent.env
    chmod 600 /etc/nnm-agent.env

Add `NNM_AGENT_LOG_DIR=/var/log/nimble` to that file to enable log reading. The
`nimble` user must be able to read it — on a stock install it already can, but
verify rather than assume:

    sudo -u nimble test -r /var/log/nimble/nimble.log && echo readable

Set `NNM_AGENT_LOGS=0` to disable log access entirely on a given box.

`/etc/systemd/system/nnm-agent.service`:

    [Unit]
    Description=NNM Control file agent
    After=network.target

    [Service]
    User=nimble
    EnvironmentFile=/etc/nnm-agent.env
    ExecStart=/usr/bin/node /usr/local/bin/nnm-agent
    Restart=on-failure
    # The agent only ever needs these two trees for writing...
    ReadWritePaths=/srv/nimble/conf /srv/nimble/media/gallery
    # ...and the log tree strictly for reading. Enforced by systemd as well as
    # by the code, so a bug in the agent still cannot damage a log.
    ReadOnlyPaths=/var/log/nimble
    ProtectSystem=strict
    ProtectHome=yes
    PrivateTmp=yes
    NoNewPrivileges=yes

    [Install]
    WantedBy=multi-user.target

Then `systemctl enable --now nnm-agent` and paste the URL and token into
**Playlists -> Server agents** in the panel.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `NNM_AGENT_TOKEN` | - | required, at least 24 chars; the agent refuses to start without it |
| `NNM_AGENT_BIND` | `0.0.0.0` | set to `127.0.0.1` if the panel reaches it through a tunnel |
| `NNM_AGENT_PORT` | `8090` | |
| `NNM_AGENT_CONF_DIR` | `/srv/nimble/conf` | created on first write |
| `NNM_AGENT_MEDIA_DIR` | `/srv/nimble/media/gallery` | created on first write |
| `NNM_AGENT_MAX_UPLOAD_MB` | `2048` | oversized uploads are refused and leave no partial file |
| `NNM_AGENT_MEDIA_EXT` | media/image types | extension allow-list for uploads |
| `NNM_AGENT_LOG_DIR` | `/var/log/nimble` | read-only; never created, never written |
| `NNM_AGENT_LOGS` | `1` | `0` removes the log routes entirely |
| `NNM_AGENT_LOG_CHUNK_KB` | `1024` | ceiling on one read; ~80s of output at the measured rate |
| `NNM_AGENT_LOG_EXT` | `log,txt` | only these are listed or served |

## Exposure - read this before opening a port

The token is the only thing standing between the internet and write access to a
live streaming server, and plain HTTP sends it in the clear. Expose the agent on
a private network, a VPN, or behind a TLS reverse proxy - not on a public
interface. Give each server its own token; the panel stores them encrypted and
never shares one between servers.

## Behaviour worth knowing
* Config writes are **atomic** (temp file + rename), so Nimble never reads a
  half-written playlist, and the previous version is kept as `<name>.bak`.
* Uploads stream to a `.part` file and are renamed on completion; a failed or
  oversized upload leaves nothing behind.

## Tests
`node tests/agent.test.mjs` starts a real agent on a temp directory and checks
auth, path confinement, size and extension limits, atomic writes, the `.bak`
generation, and log reading — including that a read is trimmed to whole lines,
that an offset past the end reports truncation, and that nothing can be written
to the log directory.
