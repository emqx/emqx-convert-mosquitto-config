#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

# Test-only PEM files for the TLS fixtures. User input is never silently given
# replacement certificates; test-emqx.sh accepts explicit read-only mounts.
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$scratch/server.key" \
  -out "$scratch/server.pem" -days 1 -subj /CN=localhost >/dev/null 2>&1
cp "$scratch/server.pem" "$scratch/ca.pem"
chmod 755 "$scratch"
chmod 644 "$scratch/"*

count=0
for config in "$repo/test/fixtures/mosquitto/"*.conf; do
  mode=live
  if [ -f "${config%.conf}.mode" ]; then
    read -r mode <"${config%.conf}.mode"
  fi
  options=()
  case "$mode" in
    live) ;;
    restart) options+=(--restart) ;;
    *) printf 'Unknown load mode %s for %s\n' "$mode" "$config" >&2; exit 1 ;;
  esac
  printf '\nTesting %s (%s)\n' "$(basename "$config")" "$mode"
  bash "$repo/scripts/test-emqx.sh" ${options[@]+"${options[@]}"} --mount "$scratch:/etc/mosquitto/certs" "$config"
  count=$((count + 1))
done
printf '\nAll %s EMQX runtime configuration cases passed.\n' "$count"
