# Mosquitto to EMQX Configuration Converter

Convert **Mosquitto 2.0.x** `mosquitto.conf` files into **EMQX 6.x** HOCON. Includes a local browser interface and HTTP API, CLI, migration diagnostics, examples, and automated tests. Follows the TypeScript service/converter structure of `emqx-convert-hivemq-config`.

## Quick start

Requires Node.js 22+ and pnpm. Docker is optional, for EMQX integration tests.

```bash
pnpm install
pnpm dev
# Open http://localhost:8787
```

Paste a configuration, upload a file, or choose an example. Convert, review the migration notes, then copy or download the HOCON. Editing the input clears the previous output so an outdated conversion cannot be downloaded accidentally.

The browser connects only to the local Node.js server. Configuration text stays on your machine: it is not logged, persisted, or sent to an external service. Referenced certificate and credential files are never fetched.

`pnpm dev` builds and starts the server at `http://127.0.0.1:8787`. After building, `pnpm start` starts it directly. Use `pnpm start --port 9000` or `PORT=9000 pnpm start` for a different port. The server binds only to loopback and rejects cross-origin requests. No cloud account or deployment is needed.

### CLI

```bash
pnpm build
node dist/cli.js conf/mosquitto.conf -o emqx.hocon
node dist/cli.js conf/examples/security.conf --json
cat mosquitto.conf | node dist/cli.js -
node dist/cli.js --help
```

HOCON goes to stdout unless `-o` is supplied. Diagnostics go to stderr and appear as comments in the HOCON. `--json` returns `hocon`, `warnings`, `disabledListeners`, and the structured `config`. `--strict` exits with code 2 and writes no output if any warning remains; regular errors exit with code 1. Strict mode deliberately includes behavioral differences, such as session expiry and queue overflow.

### Included configuration files

Use `--include-dir` to authorize local `.conf` file loading:

```bash
node dist/cli.js conf/examples/includes/mosquitto.conf --include-dir
node dist/cli.js /etc/mosquitto/mosquitto.conf \
  --include-dir --base-dir /etc/mosquitto -o emqx.hocon
```

Relative `include_dir` paths are resolved from the working directory, as in Mosquitto, or from `--base-dir`. Files are sorted case-sensitively. Each included file starts at the default listener; returning to the main file restores its listener context. Nested `include_dir` directives are ignored with a warning, as in Mosquitto. A directory containing the main configuration is rejected. The CLI limits input to 256 files / 4 MiB combined.

The web service rejects unresolved `include_dir` directives instead of returning an incomplete conversion. Inline those files or use the CLI.

## Conversion coverage

| Mosquitto setting                                        | EMQX output / behavior                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `listener`, legacy `port` / `bind_address`               | Named TCP, SSL, WS, or WSS listeners; literal IPv4/IPv6 addresses                   |
| No listener configured                                   | Localhost-only TCP listeners on `127.0.0.1` and `::1`                               |
| `protocol websockets`                                    | WS/WSS listener at `/mqtt`; client path change reported                             |
| `max_connections`, `mount_point`                         | Listener connection limit and mountpoint; zero connections disables the listener    |
| `max_qos`, `max_topic_alias`, `use_username_as_clientid` | Per-listener MQTT zones                                                             |
| `certfile`, `keyfile`, `cafile`, `dhparamfile`           | PEM paths in `ssl_options`; files are not copied                                    |
| `require_certificate`, certificate username options      | Peer verification and CN/DN username mapping                                        |
| `tls_version`                                            | Minimum TLS version; TLS 1.2 allows TLS 1.2 + 1.3, TLS 1.3 allows only 1.3          |
| `ciphers`, `ciphers_tls1.3`                              | Supported explicit cipher lists; expressions/incomplete lists require manual review |
| `max_packet_size`                                        | MQTT packet size in bytes; zero uses EMQX's protocol maximum                        |
| `max_inflight_messages`                                  | Inflight limit; unlimited or larger values capped at 65535 with a warning           |
| `max_queued_messages`, `queue_qos0_messages`             | Queue length and offline QoS 0 storage                                              |
| `retain_available`, `upgrade_outgoing_qos`               | MQTT capability switches                                                            |
| `persistent_client_expiration`                           | MQTT 3.x session expiry; months are converted to seconds, not minutes               |
| `persistence`                                            | Durable sessions and disk/RAM retained-message storage                              |
| `set_tcp_nodelay`                                        | TCP `nodelay` on listeners                                                          |
| `sys_interval`                                           | System message and heartbeat intervals; zero disables both                          |
| `log_dest`, `log_type`                                   | Console/file handlers and an approximate severity threshold                         |

The converter explicitly sets several differing defaults, including inflight messages (20), queued QoS 0 storage (false), maximum packet size, topic aliases (10), and TCP_NODELAY (false). A wildcard listener without `socket_domain` uses IPv4 and warns that an IPv6 listener may also be needed.

### Manual migration and behavioral differences

- **Authentication and ACLs:** `password_file`, `acl_file`, PSK files, and plugins are not imported. Affected listeners are disabled. Password-based listeners include a built-in database authenticator template; migrate users and select their hash algorithm before enabling it. Mosquitto password hashes are not treated as EMQX-ready hashes. Translate ACLs, including deny precedence, anonymous/user scopes, and `%u` / `%c` patterns, into an EMQX authorization policy with a deny fallback. Mixed anonymous/password authentication requires a separate policy. mTLS certificate identity bypasses `password_file` as it does in Mosquitto.
- **Source restrictions:** Unsupported bind-interface, CRL, CA-directory, TLS engine/PSK, empty-client-ID, client-ID-prefix, and literal mountpoint-template settings disable affected listeners. Unknown directives disable all generated listeners until reviewed. Hostnames produce disabled loopback placeholders; Unix socket listeners are omitted with a warning.
- **Bridges:** `connection` sections are reported for manual migration to MQTT connectors, sources/actions, and rules. Topic remapping, loop prevention, retained messages, and reconnect behavior need review. Bridge and plugin credentials are omitted from output and diagnostics.
- **Persistence:** `mosquitto.db` is not migrated. Durable-session retention, throughput, and checkpoints differ. MQTT 3.x persistent sessions never expire by default in Mosquitto; EMQX defaults to 2 hours, and the converter reports this. MQTT 5 clients control their session expiry in EMQX.
- **Limits:** EMQX drops the oldest message from a full queue; Mosquitto drops new arrivals. Payload-only size, inflight/queued byte limits, memory limits, and maximum keepalive cannot be mapped exactly and are reported. `max_keepalive` is deliberately not rewritten as `server_keepalive`, which would force a different MQTT 5 behavior.
- **Other settings:** Process users/PID files, snapshot timing, log formatting, syslog/topic logging, retained-source authorization, and static HTTP directories are reported for manual migration. System topic names and payloads differ.

Parsing preserves `#` in values, paths and topic filters. Only lines beginning with `#` are comments. Inline comments and shell-style quoting/expansion are not supported. Booleans and supported numeric values are validated with source file and line diagnostics. This is a migration tool, not a complete Mosquitto configuration validator; it targets the 2.0.x dialect rather than claiming compatibility with every later directive.

## Apply the result

Review warning comments and disabled listeners first. Copy referenced PEM files to the EMQX host and adjust paths. On a **fresh EMQX 6.3.2 instance**, place the reviewed configuration in `/opt/emqx/etc/base.hocon`, then run:

```bash
emqx check_config
```

All stock MQTT listeners (`tcp`, `ssl`, `ws`, `wss`, and `quic`) are explicitly disabled; source listeners use names such as `mosquitto_1`. This prevents an extra default MQTT endpoint from remaining open. The Dashboard/API endpoint is managed separately by EMQX.

For source listeners without ACLs, the output explicitly removes the shipped authorization sources and allows topics, matching Mosquitto's no-ACL behavior. Listeners with unmigrated ACLs remain disabled. Configure their authorization policy before re-enabling them.

Existing `cluster.hocon`, `emqx.conf`, environment variables, extra named listeners, or Dashboard changes may override/merge with this file. The generated configuration does not clean up an existing EMQX installation. Validate effective configuration and client behavior in staging before replacing a broker.

## HTTP API

```bash
curl http://localhost:8787/convert \
  -H 'Content-Type: text/plain' --data-binary @mosquitto.conf

curl http://localhost:8787/convert -F file=@mosquitto.conf
```

`POST /convert` also accepts JSON `{ "config": "..." }` and form field `config_content`. Empty configurations are valid. Responses contain HOCON plus structured migration warnings and disabled-listener IDs. Validation errors return 400; bodies larger than 1 MiB return 413; unsupported content types return 415. No filesystem resolver is available to HTTP requests.

## Development and tests

```bash
pnpm type-check
pnpm test           # parser, conversion, security, CLI and HTTP tests
pnpm format:check
pnpm test:emqx      # All .conf fixtures against a fresh EMQX 6.3.2 per case
pnpm test:emqx:config path/to/mosquitto.conf  # Test one input file
```

`scripts/test-emqx.sh` accepts one Mosquitto config as a file argument, `-`, or stdin with no argument. After `pnpm build`, it can be called directly, including from another working directory:

```bash
bash scripts/test-emqx.sh test/fixtures/mosquitto/basic.conf
cat mosquitto.conf | bash scripts/test-emqx.sh
bash scripts/test-emqx.sh - < mosquitto.conf
```

Each run stops at the first failed stage:

1. Convert the input with the CLI. Conversion errors stop before Docker starts; migration warnings are recorded and do not fail the test.
2. Start a fresh EMQX container with its shipped default configuration. Temporarily overlay the generated HOCON on `base.hocon`, run `emqx check_config`, then restore the original file. This validates the candidate without loading it into the running broker.
3. In the default **live** mode, apply the generated MQTT settings and zones with `emqx ctl conf load --replace`, then load the complete generated file. EMQX loads roots alphabetically, so zones must exist before their listeners can start. Either load failing stops the test; there is no retry after a partial failure. With explicit **`--restart`** mode, overlay the checked HOCON on `base.hocon` and restart the container instead, then wait for EMQX to become ready.
4. Read each generated root using `emqx ctl conf show <root>`, including `zones` (omitted by the unqualified command). Parse the generated and runtime HOCON with EMQX's bundled parser, require every generated path to be present, normalize values with its schema, and compare every explicitly generated value. Missing paths, changed values, and array length/order differences fail. Additional default fields in runtime objects are allowed; equivalent byte-size/duration representations compare equal.

The container is removed on success or failure. Generated HOCON, dependency HOCON, runtime dumps, and command/container logs remain in the printed `test-results/emqx/run.*` directory, which is ignored by Git. No host ports are published. Override `EMQX_IMAGE` to test an additional version without changing the supported target.

The suite discovers individual inputs in `test/fixtures/mosquitto/*.conf`: basic TCP/WebSocket, TLS, per-listener security, persistence, empty/default input, denied anonymous access, unlimited limits, file logging, disabled logging, WSS, unsupported PSK, and escaped mount points. It generates temporary test certificates and runs each fixture through the same four stages in its own container. The browser's interactive samples are independent of these test fixtures.

Fixtures default to live loading. A sibling `<name>.mode` file containing `restart` opts into restart loading. `persistence.mode` does this because EMQX 6.3.2 does not support changing `durable_sessions.enable` live. This fixture still receives full runtime verification after restart. To test your own configuration this way:

```bash
pnpm test:emqx:config --restart conf/examples/persistence.conf
```

`pnpm test` also checks stdin/file handling and failure gating with a Docker stub. `pnpm test:emqx` first tests the real verifier with equivalent units/log paths and deliberately changed, missing, reordered, and malformed runtime values, then runs the Mosquitto fixtures. Log paths are resolved using EMQX's own environment interpolation; other strings, including mountpoints, are compared literally.

For your own TLS configuration, mount the real supporting files explicitly at the paths referenced by the generated config:

```bash
bash scripts/test-emqx.sh \
  --mount /absolute/local/certs:/etc/mosquitto/certs mosquitto.conf
```

Mounts are read-only and may be repeated. The single-input runner does not substitute certificates or import password/ACL files. `include_dir` must be inlined for this runner. Passing this test verifies configuration acceptance and runtime values; it does not prove MQTT traffic, TLS handshakes, ACL behavior, or persistence across a restart.

For an optional MQTT 3.1.1 TCP CONNECT/SUBSCRIBE/PUBLISH check against a separately running broker, use `node scripts/mqtt-smoke.mjs <localhost-port>`.

```text
src/
  mosquitto-parser.ts           # Line-oriented parser, scopes and include handling
  converters/                  # Listener/TLS/auth, MQTT/storage, and logging mappings
  hocon-generator.ts           # Escaped deterministic HOCON and warning comments
  conversion-service.ts        # Shared CLI/HTTP conversion API
  cli.ts                       # Local file access, stdin and output handling
  http-handler.ts              # HTTP routing, uploads and size limits
  server.ts                    # Localhost Node.js server
  frontend.ts                  # Web interface
  examples.ts                  # Interactive samples
conf/                          # Runnable example input files
test/                          # Node test runner suites and .conf fixtures
scripts/                       # EMQX integration runner and HOCON verifier
```

Conversion code has no runtime npm dependencies. A library caller can import `ConversionService` and call `convertConfigToHocon(text, options)`; errors are returned as `result.error` with an empty HOCON string.

The Test workflow runs formatting, unit/API tests, and real EMQX validation.

## References

- [Mosquitto 2.0.22 sample configuration](https://github.com/eclipse-mosquitto/mosquitto/blob/v2.0.22/mosquitto.conf) and [parser implementation](https://github.com/eclipse-mosquitto/mosquitto/blob/v2.0.22/src/conf.c)
- [Mosquitto configuration manual](https://mosquitto.org/man/mosquitto-conf-5.html) (current manual may include newer directives)
- [EMQX 6.3.2 schema source](https://github.com/emqx/emqx/blob/6.3.2/apps/emqx/src/emqx_schema.erl) and [release](https://github.com/emqx/emqx/releases/tag/6.3.2)
