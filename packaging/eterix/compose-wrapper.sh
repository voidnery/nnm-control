#!/bin/sh
# /usr/lib/nnm-control/compose — docker compose for the packaged stack with fixed paths.
# One place for the project name, the compose file and the environment file: the hooks, maintainer
# scripts and the systemd unit all call this (P13: the compose project never changes between
# versions). The environment file is mandatory — without it compose would start a stack with blank
# secrets (docs/FAILURES.md: «docker compose by hand on production»).
# DOCKER_CONFIG (R4) is inherited: the engine and the unit set /etc/eterix/nnm-control/docker.
set -eu
export DOCKER_CONFIG="${DOCKER_CONFIG:-/etc/eterix/nnm-control/docker}"
exec docker compose --project-name nnm-control --project-directory /opt/nnm-control \
  -f /opt/nnm-control/docker-compose.yml --env-file /etc/nnm-control/nnm-control.env "$@"
