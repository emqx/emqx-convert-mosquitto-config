#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${EMQX_IMAGE:-emqx/emqx-enterprise:6.3.2}"
input='-'
input_set=false
mode=live
mounts=()

usage() {
  cat <<'HELP'
Usage: scripts/test-emqx.sh [--restart] [--mount HOST_DIR:CONTAINER_DIR] [mosquitto.conf|-]

Read one Mosquitto config from a file or stdin (the default). Stops on the
first failed stage: convert, check_config, load, or runtime verification.
Run pnpm build first, or use pnpm test:emqx:config [arguments].

  --mount HOST_DIR:CONTAINER_DIR  Mount certificate/support files read-only;
                                  may be repeated. Use absolute paths.
  --restart                     Load by restarting with the generated HOCON,
                                  for settings that cannot be changed live.
  -h, --help                     Show this help.

EMQX_IMAGE defaults to emqx/emqx-enterprise:6.3.2.
Artifacts are saved in test-results/emqx/. No container ports are published.
HELP
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --restart) mode=restart; shift ;;
    --mount)
      if [ "$#" -lt 2 ] || [[ "$2" != /*:/* ]]; then
        printf 'Error: --mount requires absolute HOST_DIR:CONTAINER_DIR paths.\n' >&2
        exit 2
      fi
      mounts+=(--volume "$2:ro")
      shift 2
      ;;
    *)
      if [ "$input_set" = true ] || { [[ "$1" == -* ]] && [ "$1" != '-' ]; }; then
        usage >&2
        exit 2
      fi
      input="$1"
      input_set=true
      shift
      ;;
  esac
done

if [ "$input_set" = false ] && [ -t 0 ]; then
  usage >&2
  exit 2
fi
if [ ! -f "$repo/dist/cli.js" ]; then
  printf 'Error: run pnpm build before testing a configuration.\n' >&2
  exit 1
fi

mkdir -p "$repo/test-results/emqx"
artifacts="$(mktemp -d "$repo/test-results/emqx/run.XXXXXX")"
printf '%s\n' "$mode" >"$artifacts/mode.txt"
container="mosquitto-converter-test-$(date +%s)-$$"
started=false
stage='conversion'
cleanup() {
  status=$?
  trap - EXIT
  if [ "$started" = true ]; then
    docker logs "$container" >"$artifacts/container.log" 2>&1 || true
    docker rm -f "$container" >/dev/null 2>&1 || true
  fi
  if [ "$status" -ne 0 ]; then
    printf 'FAILED at %s. Artifacts: %s\n' "$stage" "$artifacts" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Keep all command output for diagnosis, but only print it when a stage fails.
run_logged() {
  local log="$1"
  shift
  local status=0
  "$@" >"$artifacts/$log" 2>&1 || status=$?
  if [ "$status" -ne 0 ]; then
    cat "$artifacts/$log" >&2
    return "$status"
  fi
}

wait_ready() {
  local status_log="$1"
  local i
  for ((i=0; i<60; i++)); do
    if docker exec "$container" emqx ctl status >"$artifacts/$status_log" 2>&1; then
      return 0
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$container")" != true ]; then
      docker logs "$container" >&2
      return 1
    fi
    sleep 2
  done
  cat "$artifacts/$status_log" >&2
  docker logs "$container" >&2
  return 1
}

printf '[1/4] Converting %s to HOCON\n' "$input"
node "$repo/dist/cli.js" "$input" -o "$artifacts/generated.hocon" \
  2>"$artifacts/conversion.log" || { cat "$artifacts/conversion.log" >&2; exit 1; }

stage='startup and check_config'
printf '[2/4] Starting %s with its default configuration\n' "$image"
# EMQX boots with the untouched files shipped in the image. No host ports
# are exposed. The candidate is mounted separately from the boot config.
chmod 755 "$artifacts"
chmod 644 "$artifacts/generated.hocon"
started=true
run_logged startup.log docker run -d --name "$container" \
  --volume "$artifacts:/conversion:ro" \
  --volume "$repo/scripts/verify-emqx.escript:/opt/emqx/verify-emqx.escript:ro" \
  ${mounts[@]+"${mounts[@]}"} "$image"

wait_ready startup-status.log

# Check the candidate against the stock base config, restoring the original
# file even on failure. This does not load anything into the running broker.
run_logged check-config.log docker exec "$container" /bin/bash -ec '
  cp /opt/emqx/etc/base.hocon /opt/emqx/etc/base.hocon.converter-backup
  trap '\''mv /opt/emqx/etc/base.hocon.converter-backup /opt/emqx/etc/base.hocon'\'' EXIT
  cat /conversion/generated.hocon >> /opt/emqx/etc/base.hocon
  emqx check_config
'

if [ "$mode" = restart ]; then
  stage='config restart'
  printf '[3/4] Restarting EMQX with the generated HOCON\n'
  run_logged prepare-restart.log docker exec "$container" /bin/bash -ec \
    'cat /conversion/generated.hocon >> /opt/emqx/etc/base.hocon'
  run_logged restart.log docker restart "$container"
  wait_ready restart-status.log
else
  stage='conf load'
  printf '[3/4] Loading generated HOCON into the running broker\n'
  # EMQX loads roots alphabetically, so listeners would be started before their
  # zones exist. Apply those dependencies first, without rewriting the candidate.
  docker exec "$container" emqx escript verify-emqx.escript dependencies /conversion/generated.hocon \
    >"$artifacts/dependencies.hocon"
  chmod 644 "$artifacts/dependencies.hocon"
  run_logged load-dependencies.log docker exec "$container" emqx ctl conf load --replace /conversion/dependencies.hocon
  # Replace explicitly supplied roots, including authentication/authorization
  # arrays, rather than merging them with EMQX's shipped ACL source.
  run_logged load.log docker exec "$container" emqx ctl conf load --replace /conversion/generated.hocon
fi

stage='runtime verification'
printf '[4/4] Reading runtime configuration and comparing generated settings\n'
# Query each root explicitly: a plain "conf show" omits roots such as zones.
docker exec "$container" emqx escript verify-emqx.escript keys /conversion/generated.hocon \
  >"$artifacts/keys.txt"
test -s "$artifacts/keys.txt"
: >"$artifacts/runtime.hocon"
while IFS= read -r key; do
  run_logged "runtime-$key.hocon" docker exec "$container" emqx ctl conf show "$key"
  cat "$artifacts/runtime-$key.hocon" >>"$artifacts/runtime.hocon"
done <"$artifacts/keys.txt"
chmod 644 "$artifacts/runtime.hocon"
run_logged verify.log docker exec "$container" emqx escript verify-emqx.escript \
  compare /conversion/generated.hocon /conversion/runtime.hocon
cat "$artifacts/verify.log"
printf 'PASS: conversion, check_config, %s load, and runtime values. Artifacts: %s\n' "$mode" "$artifacts"
