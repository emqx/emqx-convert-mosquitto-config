import type {
  Directive,
  MosquittoBridge,
  MosquittoConfig,
  MosquittoListener,
  ParseOptions,
} from './types.js';

const SECURITY = new Set([
  'allow_anonymous',
  'password_file',
  'acl_file',
  'psk_file',
  'allow_zero_length_clientid',
  'auto_id_prefix',
  'plugin',
  'auth_plugin',
  'auth_plugin_deny_special_chars',
]);
const LISTENER = new Set([
  'protocol',
  'socket_domain',
  'bind_interface',
  'http_dir',
  'max_connections',
  'mount_point',
  'max_qos',
  'max_topic_alias',
  'use_username_as_clientid',
  'cafile',
  'capath',
  'certfile',
  'keyfile',
  'ciphers',
  'ciphers_tls1.3',
  'crlfile',
  'dhparamfile',
  'tls_version',
  'require_certificate',
  'use_identity_as_username',
  'use_subject_as_username',
  'psk_hint',
  'tls_engine',
  'tls_keyform',
  'tls_engine_kpass_sha1',
]);
const BRIDGE = new Set([
  'address',
  'addresses',
  'topic',
  'remote_clientid',
  'clientid',
  'local_clientid',
  'remote_username',
  'username',
  'local_username',
  'remote_password',
  'password',
  'local_password',
  'cleansession',
  'local_cleansession',
  'keepalive_interval',
  'try_private',
  'start_type',
  'restart_timeout',
  'idle_timeout',
  'threshold',
  'notifications',
  'notification_topic',
  'round_robin',
]);

export function fail(d: Directive, message: string): never {
  // Values may be credentials. Diagnostics intentionally name only the directive.
  throw new Error(`${d.source}:${d.line}: ${d.name}: ${message}`);
}

export function booleanValue(d: Directive): boolean {
  if (d.value !== 'true' && d.value !== 'false') {
    fail(d, 'expected true or false (inline comments are not supported).');
  }
  return d.value === 'true';
}

export function integerValue(
  d: Directive,
  min = 0,
  max = Number.MAX_SAFE_INTEGER
): number {
  if (!/^-?\d+$/.test(d.value)) fail(d, 'expected an integer.');
  const value = Number(d.value);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(d, `expected an integer between ${min} and ${max}.`);
  }
  return value;
}

export function tokenize(content: string, source: string): Directive[] {
  if (content.includes('\0'))
    throw new Error(`${source}: input contains a NUL byte.`);
  return content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .flatMap((raw, index) => {
      if (!raw.trim() || raw.startsWith('#')) return [];
      // Do not treat # inside a password, path or MQTT topic as a comment.
      const match = /^[ \t]*([a-z][a-z0-9_.]*)[ \t]+(.*)$/.exec(raw);
      if (!match || !match[2]?.trim()) {
        throw new Error(
          `${source}:${index + 1}: expected a directive and a value; comments must start in column 1.`
        );
      }
      return [
        { name: match[1]!, value: match[2].trim(), source, line: index + 1 },
      ];
    });
}

export class MosquittoParser {
  parse(content: string, options: ParseOptions = {}): MosquittoConfig {
    const result: MosquittoConfig = {
      globals: [],
      security: [],
      listeners: [],
      bridges: [],
      perListenerSettings: false,
      warnings: [],
    };
    const defaultListener: MosquittoListener = {
      port: 1883,
      settings: [],
      security: [],
    };
    let defaultConfigured = false;
    let securitySeen = false;
    let perListenerSeen = false;
    let bytes = 0;
    let fileCount = 0;

    const read = (text: string, source: string, included = false): void => {
      bytes += new TextEncoder().encode(text).length;
      if (++fileCount > 256 || bytes > 4 * 1024 * 1024) {
        throw new Error(
          'Configuration exceeds 256 files or 4 MiB of combined input.'
        );
      }
      // Mosquitto starts each included file at the default listener, and restores
      // the main file's current listener when returning from include_dir.
      let current = defaultListener;
      let bridge: MosquittoBridge | undefined;
      let pluginSeen = false;
      for (const d of tokenize(text, source)) {
        if (d.name === 'include_dir') {
          if (included) {
            result.warnings.push({
              code: 'NESTED_INCLUDE_IGNORED',
              message: 'Mosquitto ignores include_dir inside included files.',
              source,
              line: d.line,
              directive: d.name,
            });
            continue;
          }
          if (!options.resolveInclude) {
            fail(
              d,
              'requires local files. Use the CLI with --include-dir, or inline the included configuration.'
            );
          }
          const files = options.resolveInclude(d.value, source);
          // Mosquitto uses case-sensitive byte order (strcmp), not locale sorting.
          files.sort((a, b) =>
            a.name < b.name ? -1 : a.name > b.name ? 1 : 0
          );
          for (const file of files) read(file.content, file.name, true);
        } else if (d.name === 'per_listener_settings') {
          if (perListenerSeen || securitySeen)
            fail(d, 'must occur once, before all security settings.');
          result.perListenerSettings = booleanValue(d);
          perListenerSeen = true;
        } else if (d.name === 'listener') {
          const parts = d.value.split(/\s+/);
          if (parts.length > 2)
            fail(d, 'expected a port and optional bind address.');
          const port = integerValue({ ...d, value: parts[0]! }, 0, 65535);
          if (port === 0 && !parts[1])
            fail(d, 'a Unix socket listener requires a socket path.');
          current = {
            port,
            host: parts[1],
            origin: d,
            settings: [],
            security: [],
          };
          result.listeners.push(current);
        } else if (d.name === 'port' || d.name === 'bind_address') {
          defaultConfigured = true;
          defaultListener.origin ??= d;
          if (d.name === 'port')
            defaultListener.port = integerValue(d, 1, 65535);
          else defaultListener.host = d.value;
        } else if (d.name === 'connection') {
          if (result.bridges.some((b) => b.origin.value === d.value))
            fail(d, 'duplicate bridge name.');
          bridge = { origin: d, settings: [] };
          result.bridges.push(bridge);
        } else if (BRIDGE.has(d.name) || d.name.startsWith('bridge_')) {
          if (!bridge) fail(d, 'must follow a connection directive.');
          bridge.settings.push(d);
        } else if (SECURITY.has(d.name) || /^(auth|plugin)_opt_/.test(d.name)) {
          securitySeen = true;
          if (/^(auth|plugin)_opt_/.test(d.name) && !pluginSeen)
            fail(d, 'must follow a plugin directive in the same file.');
          if (d.name === 'plugin' || d.name === 'auth_plugin')
            pluginSeen = true;
          const security = result.perListenerSettings
            ? current.security
            : result.security;
          security.push(d);
          if (
            current === defaultListener &&
            result.perListenerSettings &&
            ['password_file', 'psk_file', 'plugin', 'auth_plugin'].includes(
              d.name
            )
          )
            defaultConfigured = true;
        } else if (LISTENER.has(d.name)) {
          current.settings.push(d);
          if (current === defaultListener) {
            defaultConfigured = true;
            defaultListener.origin ??= d;
          }
        } else {
          result.globals.push(d);
        }
      }
    };
    read(content, options.source ?? 'mosquitto.conf');
    if (defaultConfigured) result.listeners.unshift(defaultListener);
    else if (result.listeners.length === 0) {
      defaultListener.host = '127.0.0.1';
      defaultListener.implicit = true;
      result.listeners.push(defaultListener, {
        ...defaultListener,
        host: '::1',
      });
    }
    return result;
  }
}
