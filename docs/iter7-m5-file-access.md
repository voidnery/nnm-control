# iter7 m5 — file access on Nimble servers (decisions, not yet implemented)

Answers given by the operator on 2026-07-23; recorded so the milestone starts
from facts rather than assumptions.

## Transport
A **small agent on each server** exposing an HTTP endpoint protected by a token
(option "b"). The panel connects a server to its agent from a small menu on the
Playlists page — i.e. agent access is opt-in per server, not required for the
panel to work.

## Paths
- Playlist / config files: `/srv/nimble/conf/`
  The agent must create the directory and the file when they do not exist.
- Uploaded media: `/srv/nimble/media/gallery/`

## Status: implemented in v0.7.5 (see agent/README.md)

## Open items for the milestone
- Agent auth model (token issue/rotation, transport security over the LAN/WAN).
- Upload limits: max size, allowed types, disk-space guard on the streaming box.
- Whether the agent is packaged with the existing APT repo or shipped separately.

## Decisions made while implementing
- Upload transport is a raw-body PUT keyed by filename, not multipart: no parser
  to get wrong, and the panel streams the body through without buffering it.
- Uploads are limited by size (default 2 GB) and an extension allow-list; a
  refused upload leaves no partial file.
- Config writes are atomic and keep one `.bak` generation.
- The agent refuses to start without a token of at least 24 characters.
- Still open: packaging the agent into the APT repo, and token rotation.
