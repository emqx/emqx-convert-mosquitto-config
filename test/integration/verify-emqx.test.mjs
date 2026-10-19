import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const verifier = fileURLToPath(
  new URL('../../scripts/verify-emqx.escript', import.meta.url)
);
const image = process.env.EMQX_IMAGE ?? 'emqx/emqx-enterprise:6.3.2';

function compare(t, expected, actual) {
  const directory = mkdtempSync(join(tmpdir(), 'emqx-verifier-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  chmodSync(directory, 0o755);
  writeFileSync(join(directory, 'expected.hocon'), expected, { mode: 0o644 });
  writeFileSync(join(directory, 'actual.hocon'), actual, { mode: 0o644 });
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--volume',
      `${directory}:/comparison:ro`,
      '--volume',
      `${verifier}:/opt/emqx/verify-emqx.escript:ro`,
      '--entrypoint',
      '/opt/emqx/bin/emqx',
      image,
      'escript',
      'verify-emqx.escript',
      'compare',
      '/comparison/expected.hocon',
      '/comparison/actual.hocon',
    ],
    // A fresh CI worker may need to download the image on the first case.
    { encoding: 'utf8', timeout: 120000 }
  );
  assert.ifError(result.error);
  return { ...result, output: result.stdout + result.stderr };
}

test('runtime verifier accepts extra defaults and equivalent size/duration units', (t) => {
  const result = compare(
    t,
    'mqtt { max_packet_size = "1048576B", session_expiry_interval = "1209600s" }',
    'mqtt { max_packet_size = "1MB", session_expiry_interval = "14d", retain_available = true }'
  );
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Verified 2 generated values/);
});

test('runtime verifier resolves EMQX log paths using the CLI environment', (t) => {
  const result = compare(
    t,
    'log.file.default.path = "/opt/emqx/log/converted.log"',
    'log.file.default.path = "${EMQX_LOG_DIR}/converted.log"'
  );
  assert.equal(result.status, 0, result.output);
});

for (const [name, expected, actual, error] of [
  [
    'changed value',
    'mqtt.max_inflight = 17',
    'mqtt.max_inflight = 18',
    /value_mismatch.*max_inflight/s,
  ],
  [
    'missing field even when the default matches',
    'mqtt.retain_available = true',
    'mqtt {}',
    /missing_runtime_path.*retain_available/s,
  ],
  [
    'missing zones root',
    'zones.custom.mqtt.max_qos_allowed = 1',
    'mqtt {}',
    /missing_runtime_path.*zones/s,
  ],
  [
    'changed nested zone value',
    'zones.custom.mqtt.max_qos_allowed = 1',
    'zones.custom.mqtt.max_qos_allowed = 2',
    /value_mismatch.*max_qos_allowed/s,
  ],
  [
    'extra authorization source',
    'authorization.sources = []',
    'authorization.sources = [{type = file, path = "/tmp/acl.conf"}]',
    /array_length_mismatch.*authorization.sources/s,
  ],
  [
    'array order change',
    'listeners.ssl.custom.ssl_options.versions = ["tlsv1.2", "tlsv1.3"]',
    'listeners.ssl.custom.ssl_options.versions = ["tlsv1.3", "tlsv1.2"]',
    /value_mismatch.*versions/s,
  ],
  [
    'literal mountpoint change',
    'listeners.tcp.custom.mountpoint = "${EMQX_LOG_DIR}/prefix"',
    'listeners.tcp.custom.mountpoint = "/opt/emqx/log/prefix"',
    /value_mismatch.*mountpoint/s,
  ],
  [
    'malformed runtime HOCON',
    'mqtt.max_inflight = 17',
    'mqtt {',
    /Verification failed/,
  ],
]) {
  test(`runtime verifier rejects ${name}`, (t) => {
    const result = compare(t, expected, actual);
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, error);
    assert.doesNotMatch(result.output, /Verified \d/);
  });
}
