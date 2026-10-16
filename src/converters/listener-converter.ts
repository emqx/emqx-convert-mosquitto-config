import { fail } from '../mosquitto-parser.js';
import {
  BaseConverter,
  ConversionContext,
  Settings,
} from './base-converter.js';
import type { Directive, HoconObject, MosquittoListener } from '../types.js';

const CIPHERS = new Set([
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'TLS_AES_128_GCM_SHA256',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'DHE-RSA-AES256-GCM-SHA384',
  'DHE-RSA-AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  'AES128-GCM-SHA256',
]);

function ipVersion(host: string): 0 | 4 | 6 {
  if (
    /^(\d{1,3}\.){3}\d{1,3}$/.test(host) &&
    host.split('.').every((n) => Number(n) <= 255)
  )
    return 4;
  try {
    // URL also validates compressed and IPv4-mapped IPv6 literals.
    if (host.includes(':') && new URL(`http://[${host}]/`).hostname) return 6;
  } catch {
    /* Not a literal IP address. */
  }
  return 0;
}

export class ListenerConverter extends BaseConverter {
  convert(context: ConversionContext): void {
    const listeners: HoconObject = {};
    for (const type of ['tcp', 'ssl', 'ws', 'wss', 'quic'])
      listeners[type] = { default: { enable: false } };
    context.config.listeners = listeners;
    const zones: HoconObject = {};
    const global = new Settings(
      context.source.globals.filter((d) => d.name === 'set_tcp_nodelay'),
      context
    );
    const globalSecurity = new Settings(context.source.security, context);
    // Source configs without ACLs authorize all topics. Remove EMQX's shipped
    // ACL source explicitly; listeners with unmigrated ACLs remain disabled.
    context.config.authorization = { no_match: 'allow', sources: [] };
    context.config.authentication = [];
    const binds = new Set<string>();

    context.source.listeners.forEach((source, index) => {
      const s = new Settings(source.settings, context);
      const security = context.source.perListenerSettings
        ? new Settings(source.security, context)
        : globalSecurity;
      const protocol = s.text('protocol') ?? 'mqtt';
      if (!['mqtt', 'websockets'].includes(protocol))
        fail(s.get('protocol')!, 'expected mqtt or websockets.');
      const tls = !!(
        s.text('certfile') ||
        s.text('keyfile') ||
        s.text('psk_hint')
      );
      if (!!s.text('certfile') !== !!s.text('keyfile'))
        fail(
          (s.get('certfile') ?? s.get('keyfile'))!,
          'both certfile and keyfile are required for TLS.'
        );
      const type =
        protocol === 'websockets' ? (tls ? 'wss' : 'ws') : tls ? 'ssl' : 'tcp';
      const name = `mosquitto_${index + 1}`;
      const id = `${type}.${name}`;
      const zone: HoconObject = {
        max_qos_allowed: s.int('max_qos', 2, 0, 2),
        max_topic_alias: s.int('max_topic_alias', 10, 0, 65535),
        use_username_as_clientid: s.bool('use_username_as_clientid', false),
      };
      zones[name] = { mqtt: zone };
      const target: HoconObject = {
        enable: !context.blockAllListeners,
        zone: name,
        tcp_options: { nodelay: global.bool('set_tcp_nodelay', false) },
      };
      const block = (code: string, message: string, d?: Directive): void => {
        target.enable = false;
        context.warn(code, `${id} disabled: ${message}`, d ?? source.origin);
      };
      if (source.port === 0) {
        context.warn(
          'UNIX_LISTENER',
          'Unix-domain listener omitted: EMQX MQTT listeners require TCP/WebSocket endpoints. Configure a replacement manually.',
          source.origin
        );
        context.disabledListeners.push(`unix.mosquitto_${index + 1}`);
        delete zones[name];
        return;
      }
      const domain = s.text('socket_domain');
      if (domain && !['ipv4', 'ipv6'].includes(domain))
        fail(s.get('socket_domain')!, 'expected ipv4 or ipv6.');
      let host =
        source.host?.replace(/^\[(.*)\]$/, '$1') ??
        (domain === 'ipv6' ? '::' : '0.0.0.0');
      if (!ipVersion(host)) {
        block(
          'BIND_HOSTNAME',
          'EMQX requires a literal IP bind address; resolve the source hostname and replace the loopback placeholder.'
        );
        host = '127.0.0.1';
      }
      if (domain && (domain === 'ipv4') !== (ipVersion(host) === 4))
        fail(
          s.get('socket_domain')!,
          'socket_domain conflicts with the listener bind address.'
        );
      if (!source.host && !domain)
        context.warn(
          'IPV4_BIND',
          `${id} binds IPv4 on all interfaces. Mosquitto also listens on IPv6 by default; add an IPv6 listener if needed.`,
          source.origin
        );
      target.bind =
        ipVersion(host) === 6
          ? `[${host}]:${source.port}`
          : `${host}:${source.port}`;
      // All four transport types use TCP sockets; differing types cannot reuse a bind.
      if (binds.has(String(target.bind)))
        throw new Error(`Duplicate listener bind ${target.bind}.`);
      binds.add(String(target.bind));
      const maxConnections = s.int('max_connections', -1, -1);
      if (maxConnections === 0) {
        target.enable = false;
        context.warn(
          'ZERO_CONNECTIONS',
          `${id} disabled to preserve max_connections 0.`,
          s.get('max_connections')
        );
      } else
        target.max_connections =
          maxConnections === -1 ? 'infinity' : maxConnections;
      if (s.text('mount_point')) {
        target.mountpoint = s.text('mount_point')!;
        if (s.text('mount_point')!.includes('${'))
          block(
            'MOUNTPOINT_TEMPLATE',
            'EMQX interprets ${...} mountpoint placeholders; rewrite the literal source prefix.',
            s.get('mount_point')
          );
      }
      if (protocol === 'websockets') {
        target.websocket = {
          mqtt_path: '/mqtt',
          fail_if_no_subprotocol: false,
        };
        context.warn(
          'WEBSOCKET_PATH',
          `${id} uses /mqtt. Configure WebSocket clients to use that path; Mosquitto does not impose this path.`,
          source.origin
        );
      }
      const requireCertificate = s.bool('require_certificate', false);
      const identity = s.bool('use_identity_as_username', false);
      const subject = s.bool('use_subject_as_username', false);
      if ((requireCertificate || identity || subject) && !tls)
        fail(
          (s.get('require_certificate') ??
            s.get('use_identity_as_username') ??
            s.get('use_subject_as_username'))!,
          'certificate authentication requires a TLS listener.'
        );
      if ((identity || subject) && !requireCertificate)
        block(
          'CERTIFICATE_IDENTITY',
          'certificate-derived usernames require require_certificate true.',
          s.get(
            identity ? 'use_identity_as_username' : 'use_subject_as_username'
          )
        );
      if (identity || subject)
        zone.peer_cert_as_username = identity ? 'cn' : 'dn';
      if (tls) {
        const ssl: HoconObject = {
          verify: requireCertificate ? 'verify_peer' : 'verify_none',
          fail_if_no_peer_cert: requireCertificate,
        };
        target.ssl_options = ssl;
        for (const [from, to] of [
          ['certfile', 'certfile'],
          ['keyfile', 'keyfile'],
          ['cafile', 'cacertfile'],
          ['dhparamfile', 'dhfile'],
        ] as const) {
          if (s.text(from)) ssl[to] = s.text(from)!;
        }
        if (requireCertificate && !s.text('cafile') && !s.text('capath'))
          fail(s.get('require_certificate')!, 'requires cafile or capath.');
        const version = s.text('tls_version') ?? 'tlsv1.2';
        if (!['tlsv1', 'tlsv1.1', 'tlsv1.2', 'tlsv1.3'].includes(version))
          fail(s.get('tls_version')!, 'unsupported TLS version.');
        if (['tlsv1', 'tlsv1.1'].includes(version)) {
          block(
            'LEGACY_TLS',
            'TLS versions below 1.2 need manual migration. The generated minimum is TLS 1.2.',
            s.get('tls_version')
          );
          ssl.versions = ['tlsv1.2', 'tlsv1.3'];
        } else
          ssl.versions =
            version === 'tlsv1.3' ? ['tlsv1.3'] : ['tlsv1.2', 'tlsv1.3'];
        const cipherDirectives = [
          s.get('ciphers'),
          s.get('ciphers_tls1.3'),
        ].filter((d): d is Directive => !!d);
        if (cipherDirectives.length) {
          const cipherNames = cipherDirectives.flatMap((d) =>
            d.value.split(':')
          );
          if (cipherNames.every((c) => CIPHERS.has(c))) {
            // EMQX uses one list for TLS 1.2 and 1.3. Preserve the unspecified
            // protocol's defaults by requiring both lists when both are enabled.
            if (version !== 'tlsv1.3' && cipherDirectives.length !== 2)
              block(
                'TLS_CIPHERS',
                'EMQX combines TLS 1.2 and 1.3 cipher lists. Configure both explicitly before enabling this listener.',
                cipherDirectives[0]
              );
            else ssl.ciphers = cipherNames;
          } else
            block(
              'TLS_CIPHERS',
              'OpenSSL cipher expressions or unrecognized suites require an explicit EMQX cipher list.',
              cipherDirectives[0]
            );
        }
        context.warn(
          'TLS_FILES',
          `${id}: copy the PEM files to the EMQX host, update paths and verify permissions. Certificate files are not read or copied.`,
          source.origin
        );
      }
      for (const key of [
        'bind_interface',
        'capath',
        'crlfile',
        'psk_hint',
        'tls_engine',
        'tls_keyform',
        'tls_engine_kpass_sha1',
      ]) {
        if (s.get(key)) {
          if (key === 'tls_keyform' && s.text(key) === 'pem') continue;
          block(
            'MANUAL_LISTENER_SECURITY',
            `${key} cannot be mapped automatically. Configure the equivalent bind/TLS policy before enabling the listener.`,
            s.get(key)
          );
        }
      }
      if (s.get('http_dir'))
        context.warn(
          'HTTP_DIRECTORY',
          'EMQX MQTT WebSocket listeners do not serve Mosquitto http_dir files; host them separately.',
          s.get('http_dir')
        );
      this.authentication(
        context,
        source,
        security,
        target,
        block,
        requireCertificate && (identity || subject)
      );
      if (zone.use_username_as_clientid && target.enable_authn === false)
        target.enable_authn = 'quick_deny_anonymous';
      if (target.enable === false) context.disabledListeners.push(id);
      (listeners[type] as HoconObject)[name] = target;
    });
    if (Object.keys(zones).length) context.config.zones = zones;
  }

  private authentication(
    context: ConversionContext,
    source: MosquittoListener,
    security: Settings,
    target: HoconObject,
    block: (code: string, message: string, d?: Directive) => void,
    certificateIdentity: boolean
  ): void {
    const anonymous = security.bool(
      'allow_anonymous',
      source.implicit ?? false
    );
    target.enable_authn = !(anonymous || certificateIdentity);
    const password = security.get('password_file');
    if (password && !certificateIdentity) {
      target.authentication = [
        {
          mechanism: 'password_based',
          backend: 'built_in_database',
          user_id_type: 'username',
          password_hash_algorithm: { name: 'sha256', salt_position: 'suffix' },
        },
      ];
      target.enable_authn = true;
      block(
        'PASSWORD_FILE',
        'password_file is not imported. A built-in database authenticator template is provided; migrate users and select their hash algorithm before enabling. Mosquitto hashes are not directly interchangeable.',
        password
      );
      if (anonymous)
        context.warn(
          'MIXED_AUTHENTICATION',
          'Anonymous access combined with password authentication needs a separate EMQX authentication policy; enable_authn false would bypass password checks.',
          security.get('allow_anonymous')
        );
    } else if (!anonymous && !certificateIdentity) {
      block(
        'AUTHENTICATION_REQUIRED',
        'Mosquitto denies anonymous access. Configure an EMQX authenticator before enabling this listener; an empty authentication chain allows connections.',
        security.get('allow_anonymous')
      );
    }
    for (const d of context.source.perListenerSettings
      ? source.security
      : context.source.security) {
      if (d.name === 'acl_file')
        block(
          'ACL_FILE',
          'translate acl_file into EMQX authorization rules with deny fallback before enabling. Mosquitto ACL syntax cannot be used as an EMQX ACL file.',
          d
        );
      else if (d.name === 'psk_file')
        block(
          'PSK_FILE',
          'configure EMQX PSK authentication and cipher suites separately.',
          d
        );
      else if (
        ['plugin', 'auth_plugin', 'auth_plugin_deny_special_chars'].includes(
          d.name
        ) ||
        /^(plugin|auth)_opt_/.test(d.name)
      )
        block(
          'AUTH_PLUGIN',
          `${d.name} requires a replacement EMQX authentication/authorization integration. Plugin values are intentionally omitted.`,
          d
        );
      else if (
        d.name === 'allow_zero_length_clientid' &&
        !security.bool(d.name, true)
      )
        block(
          'CLIENTID_RESTRICTION',
          'configure a policy rejecting empty client IDs before enabling.',
          d
        );
      else if (d.name === 'auto_id_prefix')
        context.warn(
          'CLIENTID_PREFIX',
          'EMQX generates its own client IDs; auto_id_prefix is not preserved.',
          d
        );
    }
  }
}
