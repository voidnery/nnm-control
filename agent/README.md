# NNM Control agent

The only component that touches a Nimble box's filesystem. Deliberately
dependency-free (`node:http` + `node:fs`) so the whole trust surface can be read
in one sitting.

## What it can do
* read/write files in the **config directory** (playlists, configs)
* list/upload/delete files in the **media directory**
* report its own health

It cannot run commands, reach any other path, or list anything outside those two
directories. Names are single filenames — a name containing `/`, `..` or a NUL
byte is refused.

## Install

    install -m 0755 nnm-agent.mjs /usr/local/bin/nnm-agent
    install -d -o nimble -g nimble /srv/nimble/conf /srv/nimble/media/gallery

    printf 'NNM_AGENT_TOKEN=%s\nNNM_AGENT_BIND=127.0.0.1\nNNM_AGENT_PORT=8090\n' \
      "$(openssl rand -hex 24)" > /etc/nnm-agent.env
    chmod 600 /etc/nnm-agent.env

`/etc/systemd/system/nnm-agent.service`:

    [Unit]
    Description=NNM Control file agent
    After=network.target

    [Service]
    User=nimble
    EnvironmentFile=/etc/nnm-agent.env
    ExecStart=/usr/bin/node /usr/local/bin/nnm-agent
    Restart=on-failure
    # The agent only ever needs these two trees.
    ReadWritePaths=/srv/nimble/conf /srv/nimble/media/gallery
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
auth, path confinement, size and extension limits, atomic writes and the `.bak`
generation.
