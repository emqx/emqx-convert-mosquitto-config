#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
image="${EMQX_IMAGE:-emqx/emqx-enterprise:6.2.3}"
scratch="$(mktemp -d)"
container="mosquitto-converter-test-$(date +%s)-$$"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT

mkdir -p "$scratch/certs" "$scratch/configs"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$scratch/certs/server.key" \
  -out "$scratch/certs/server.pem" -days 1 -subj /CN=localhost >/dev/null 2>&1
cp "$scratch/certs/server.pem" "$scratch/certs/ca.pem"
chmod 755 "$scratch" "$scratch/certs" "$scratch/configs"
chmod 644 "$scratch/certs/"*

node --input-type=module - "$scratch" <<'JS'
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { examples } from './dist/examples.js';
import { ConversionService } from './dist/conversion-service.js';
const cases = {
  ...Object.fromEntries(Object.entries(examples).map(([name, item]) => [name, item.content])),
  empty: '',
  denied: 'listener 1883\nallow_anonymous false',
  unlimited: 'listener 1883\nallow_anonymous true\nmax_inflight_messages 0\nmax_queued_messages 0\nsys_interval 0',
  logfile: 'listener 1883\nallow_anonymous true\nlog_dest file /opt/emqx/log/converted.log\nlog_type debug',
  no_logging: 'log_dest none\nlog_type none',
  wss: examples.tls.content + '\nprotocol websockets',
  psk: 'listener 8883\npsk_hint identity\npsk_file /etc/mosquitto/psk',
  escaped: 'listener 1883\nallow_anonymous true\nmount_point sensors/"quoted"/\\literal/',
};
for (const [name, text] of Object.entries(cases)) {
  const result = new ConversionService().convertConfigToHocon(text);
  if (result.error) throw new Error(result.error);
  writeFileSync(join(process.argv[2], 'configs', name + '.hocon'), result.hocon);
}
JS

docker run -d --name "$container" \
  -p 127.0.0.1::1883 \
  -v "$scratch/certs:/etc/mosquitto/certs:ro" \
  -v "$scratch/configs:/conversion:ro" \
  --entrypoint /bin/bash "$image" -ec \
  'cp /conversion/basic.hocon /opt/emqx/etc/base.hocon; exec /usr/bin/docker-entrypoint.sh /opt/emqx/bin/emqx foreground' >/dev/null

ready=false
for ((i=0; i<60; i++)); do
  if docker exec "$container" emqx ctl status >/dev/null 2>&1; then ready=true; break; fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$container")" != true ]; then
    docker logs "$container"
    exit 1
  fi
  sleep 2
done
if [ "$ready" != true ]; then docker logs "$container"; exit 1; fi

mapping="$(docker port "$container" 1883/tcp)"
node scripts/mqtt-smoke.mjs "${mapping##*:}"

for config in "$scratch/configs/"*.hocon; do
  name="$(basename "$config")"
  printf 'Checking %s with %s\n' "$name" "$image"
  docker exec "$container" /bin/bash -ec \
    'cp "/conversion/$1" /opt/emqx/etc/base.hocon; emqx check_config' -- "$name"
done
printf 'EMQX config validation and MQTT smoke test passed.\n'
