import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { ConversionService } from '../dist/conversion-service.js';
import { MosquittoParser } from '../dist/mosquitto-parser.js';
import { HOCONGenerator } from '../dist/hocon-generator.js';

const fixtureDirectory = new URL('./fixtures/mosquitto/', import.meta.url);
const fixture = (name) =>
  readFileSync(new URL(`${name}.conf`, fixtureDirectory), 'utf8');

const service = new ConversionService();
function convert(content, options) {
  const result = service.convertConfigToHocon(content, options);
  assert.equal(result.error, undefined, result.error);
  return result;
}
const listener = (result, name = 'mosquitto_1', type = 'tcp') =>
  result.config.listeners[type][name];
const warning = (result, code) => result.warnings.some((w) => w.code === code);

test('empty configuration preserves local-only access and closes stock listeners', () => {
  const result = convert('');
  assert.equal(listener(result).bind, '127.0.0.1:1883');
  assert.equal(listener(result, 'mosquitto_2').bind, '[::1]:1883');
  assert.equal(listener(result).enable_authn, false);
  assert.deepEqual(result.disabledListeners, []);
  for (const type of ['tcp', 'ssl', 'ws', 'wss', 'quic'])
    assert.equal(result.config.listeners[type].default.enable, false);
});

test('Mosquitto defaults are made explicit where EMQX differs', () => {
  const result = convert('allow_anonymous true\nlistener 1883 127.0.0.1');
  assert.equal(result.config.mqtt.max_inflight, 20);
  assert.equal(result.config.mqtt.max_packet_size, '268435455B');
  assert.equal(result.config.mqtt.mqueue_store_qos0, false);
  assert.equal(result.config.mqtt.max_topic_alias, 10);
  assert.equal(listener(result).tcp_options.nodelay, false);
  assert.equal(listener(result).max_connections, 'infinity');
  assert.equal(result.config.sys_topics.sys_msg_interval, '10s');
  assert.deepEqual(result.config.authorization, {
    no_match: 'allow',
    sources: [],
  });
  assert.ok(warning(result, 'SESSION_EXPIRY_DEFAULT'));
});

test('explicit listener defaults to denying anonymous access', () => {
  const result = convert('listener 1883');
  assert.equal(listener(result).enable, false);
  assert.equal(listener(result).enable_authn, true);
  assert.ok(warning(result, 'AUTHENTICATION_REQUIRED'));
  assert.deepEqual(result.disabledListeners, ['tcp.mosquitto_1']);
});

test('listeners on the same port keep distinct addresses and names', () => {
  const result = convert(
    'allow_anonymous true\nlistener 1883 127.0.0.1\nlistener 1883 ::1'
  );
  assert.equal(listener(result).bind, '127.0.0.1:1883');
  assert.equal(listener(result, 'mosquitto_2').bind, '[::1]:1883');
  assert.match(
    service.convertConfigToHocon('listener 1883\nlistener 1883').error,
    /Duplicate listener bind/
  );
});

test('legacy default listener is separate from explicit listener', () => {
  const result = convert(
    'port 1884\nbind_address 127.0.0.1\nallow_anonymous true\nlistener 1885 127.0.0.2'
  );
  assert.equal(listener(result).bind, '127.0.0.1:1884');
  assert.equal(listener(result, 'mosquitto_2').bind, '127.0.0.2:1885');
});

test('global security after a listener applies to all listeners', () => {
  const result = convert(
    'listener 1883\nallow_anonymous true\nlistener 1884\npassword_file /private/passwd'
  );
  assert.equal(result.disabledListeners.length, 2);
  assert.ok(warning(result, 'PASSWORD_FILE'));
  assert.ok(warning(result, 'MIXED_AUTHENTICATION'));
});

test('per-listener security does not leak to anonymous listener', () => {
  const result = convert(fixture('security'));
  assert.equal(listener(result).enable, false);
  assert.equal(listener(result, 'mosquitto_2').enable, true);
  assert.equal(listener(result, 'mosquitto_2').enable_authn, false);
  assert.equal(listener(result, 'mosquitto_2').mountpoint, 'public/');
  assert.ok(warning(result, 'ACL_FILE'));
});

test('TLS and mTLS identity skip ignored password_file and use a zone', () => {
  const result = convert(fixture('tls') + '\npassword_file /ignored/passwd');
  const ssl = listener(result, 'mosquitto_1', 'ssl');
  assert.equal(ssl.enable, true);
  assert.equal(ssl.enable_authn, false);
  assert.equal(ssl.ssl_options.verify, 'verify_peer');
  assert.equal(ssl.ssl_options.fail_if_no_peer_cert, true);
  assert.equal(ssl.ssl_options.cacertfile, '/etc/mosquitto/certs/ca.pem');
  assert.deepEqual(ssl.ssl_options.versions, ['tlsv1.2', 'tlsv1.3']);
  assert.equal(
    result.config.zones.mosquitto_1.mqtt.peer_cert_as_username,
    'cn'
  );
  assert.ok(!warning(result, 'PASSWORD_FILE'));
});

test('WebSockets with certificates become WSS', () => {
  const result = convert(fixture('wss'));
  assert.equal(
    listener(result, 'mosquitto_1', 'wss').websocket.mqtt_path,
    '/mqtt'
  );
});

test('listener QoS, aliases, client identity are scoped through zones', () => {
  const result = convert(
    'allow_anonymous true\nlistener 1883 127.0.0.1\nmax_qos 1\nmax_topic_alias 4\nuse_username_as_clientid true\nlistener 1884 127.0.0.1'
  );
  assert.equal(result.config.zones.mosquitto_1.mqtt.max_qos_allowed, 1);
  assert.equal(result.config.zones.mosquitto_1.mqtt.max_topic_alias, 4);
  assert.equal(result.config.zones.mosquitto_2.mqtt.max_qos_allowed, 2);
  assert.equal(listener(result).enable_authn, 'quick_deny_anonymous');
});

test('unlimited queues and inflight windows do not emit invalid zeros', () => {
  const result = convert(
    'max_inflight_messages 0\nmax_queued_messages 0\nsys_interval 0'
  );
  assert.equal(result.config.mqtt.max_inflight, 65535);
  assert.equal(result.config.mqtt.max_mqueue_len, 0);
  assert.equal(result.config.sys_topics.sys_msg_interval, 'disabled');
  assert.equal(result.config.sys_topics.sys_heartbeat_interval, 'disabled');
  assert.ok(warning(result, 'INFLIGHT_LIMIT'));
});

test('zero maximum connections disables the listener', () => {
  const result = convert(
    'listener 1883\nallow_anonymous true\nmax_connections 0'
  );
  assert.equal(listener(result).enable, false);
  assert.equal(listener(result).max_connections, undefined);
});

test('Mosquitto m means months, not HOCON minutes', () => {
  const result = convert('persistent_client_expiration 2m\npersistence true');
  assert.equal(result.config.mqtt.session_expiry_interval, '5184000s');
  assert.equal(result.config.durable_sessions.enable, true);
  assert.equal(result.config.retainer.backend.storage_type, 'disc');
});

test('payload-size and keepalive limits are not falsely mapped to packet/override limits', () => {
  const result = convert(
    'message_size_limit 100\nmax_packet_size 1000\nmax_keepalive 120'
  );
  assert.equal(result.config.mqtt.max_packet_size, '1000B');
  assert.equal(result.config.mqtt.server_keepalive, undefined);
  assert.ok(warning(result, 'KEEPALIVE_LIMIT'));
  assert.ok(result.warnings.some((w) => w.directive === 'message_size_limit'));
});

test('comment handling preserves topic wildcards, hashes, spaces and backslashes', () => {
  const result = convert(
    '\uFEFF# comment\r\nlistener 1883 127.0.0.1\r\nallow_anonymous true\r\nmount_point a/#/b/\r\nlog_dest file C:\\log folder\\broker#1.log\r\n'
  );
  assert.equal(listener(result).mountpoint, 'a/#/b/');
  assert.equal(
    result.config.log.file.default.path,
    'C:\\log folder\\broker#1.log'
  );
  assert.ok(result.hocon.includes('"C:\\\\log folder\\\\broker#1.log"'));
});

test('dangerous or unknown settings never produce an enabled listener', () => {
  for (const directive of [
    'acl_file /acl',
    'psk_file /psk',
    'clientid_prefixes allowed-',
    'allow_anonymos false',
    'allow_zero_length_clientid false',
  ]) {
    const result = convert(
      `allow_anonymous true\nlistener 1883 127.0.0.1\n${directive}`
    );
    assert.equal(listener(result).enable, false, directive);
  }
  for (const directive of [
    'bind_interface eth0',
    'crlfile /revoked.pem',
    'ciphers HIGH:!aNULL',
  ]) {
    const result = convert(fixture('tls') + '\n' + directive);
    assert.equal(
      listener(result, 'mosquitto_1', 'ssl').enable,
      false,
      directive
    );
  }
});

test('hostname and Unix listeners are never broadened to all interfaces', () => {
  const host = convert('listener 1883 private.internal\nallow_anonymous true');
  assert.equal(listener(host).bind, '127.0.0.1:1883');
  assert.equal(listener(host).enable, false);
  const unix = convert('listener 0 /tmp/mqtt.sock\nallow_anonymous true');
  assert.ok(warning(unix, 'UNIX_LISTENER'));
  assert.equal(Object.keys(unix.config.listeners.tcp).length, 1);
});

test('bridge and plugin credentials never appear in HOCON or diagnostics', () => {
  const result = convert(
    'listener 1883\nplugin /dynsec.so\nplugin_opt_password TOP_SECRET_1\nconnection remote\naddress remote:1883\nremote_password TOP_SECRET_2\ntopic # both 1'
  );
  assert.ok(warning(result, 'BRIDGE_MIGRATION'));
  assert.ok(warning(result, 'AUTH_PLUGIN'));
  assert.ok(!JSON.stringify(result).includes('TOP_SECRET'));
});

test('log_dest none and log_type none reset previous selections in order', () => {
  const destinations = convert(
    'log_dest stdout\nlog_dest file /tmp/mqtt.log\nlog_dest none'
  );
  assert.equal(destinations.config.log.console.enable, false);
  assert.equal(destinations.config.log.file.default.enable, false);
  const types = convert('log_dest stdout\nlog_type debug\nlog_type none');
  assert.equal(types.config.log.console.enable, false);
  const restarted = convert(
    'log_dest none\nlog_dest stdout\nlog_type none\nlog_type information'
  );
  assert.equal(restarted.config.log.console.enable, true);
  assert.equal(restarted.config.log.console.level, 'info');
});

test('service is stateless across conversions', () => {
  const first = convert('listener 1883\nplugin /auth.so');
  assert.ok(warning(first, 'AUTH_PLUGIN'));
  const next = convert('');
  assert.equal(next.disabledListeners.length, 0);
  assert.ok(!warning(next, 'AUTH_PLUGIN'));
});

test('include_dir requires an explicit resolver and sorts .conf inputs', () => {
  assert.match(
    service.convertConfigToHocon('include_dir conf.d').error,
    /--include-dir/
  );
  const result = convert('allow_anonymous true\ninclude_dir conf.d', {
    resolveInclude: () => [
      { name: 'z.conf', content: 'listener 1884 127.0.0.1' },
      { name: 'A.conf', content: 'listener 1883 127.0.0.1' },
    ],
  });
  assert.equal(listener(result).bind, '127.0.0.1:1883');
  assert.equal(listener(result, 'mosquitto_2').bind, '127.0.0.1:1884');
});

test('include scopes reset to the default listener and restore the main-file scope', () => {
  let calls = 0;
  const result = convert(
    'allow_anonymous true\nlistener 1883 127.0.0.1\ninclude_dir parts\nmax_qos 1',
    {
      resolveInclude: () => {
        calls++;
        return [
          {
            name: 'child.conf',
            content:
              'port 1884\nbind_address 127.0.0.2\nmax_qos 0\ninclude_dir ignored',
          },
        ];
      },
    }
  );
  assert.equal(calls, 1);
  assert.equal(result.config.zones.mosquitto_1.mqtt.max_qos_allowed, 0);
  assert.equal(result.config.zones.mosquitto_2.mqtt.max_qos_allowed, 1);
  assert.ok(warning(result, 'NESTED_INCLUDE_IGNORED'));
});

test('parsing diagnoses invalid values with source and line, without exposing values', () => {
  for (const content of [
    'listener 99999',
    'listener abc',
    'listener 1883 extra extra',
    'allow_anonymous yep',
    'allow_anonymous true # inline comment',
    'max_qos 3',
    'max_queued_messages -1',
    'max_packet_size 19',
    'max_topic_alias 65536',
    'max_keepalive 65536',
    'persistent_client_expiration 1x',
    'listener',
    'max_packet_size 4KB',
    ' # not a Mosquitto comment',
    'allow_anonymous true\nper_listener_settings true',
    'plugin_opt_secret secretvalue',
    'topic # out',
    'listener 1883\ncertfile /cert',
  ]) {
    const result = service.convertConfigToHocon(content, {
      source: 'broken.conf',
    });
    assert.match(result.error, /broken.conf:\d+:/, content);
    assert.equal(result.hocon, '');
    assert.ok(!result.error.includes('secretvalue'));
  }
});

test('HOCON writer escapes all user strings and quotes non-identifier keys', () => {
  const generated = new HOCONGenerator().generate({
    'a.b': { value: 'a"\\b\n${SECRET}', list: ['x"y', true, 4] },
  });
  assert.ok(generated.includes('"a.b" {'));
  assert.ok(generated.includes('value = "a\\"\\\\b\\n${SECRET}"'));
  assert.ok(generated.includes('list = ["x\\"y", true, 4]'));
});

test('all Mosquitto integration fixtures convert', () => {
  for (const name of readdirSync(fixtureDirectory).filter((name) =>
    name.endsWith('.conf')
  ))
    assert.ok(
      convert(readFileSync(new URL(name, fixtureDirectory), 'utf8')).hocon
    );
});

test('input size and binary content are rejected', () => {
  assert.match(service.convertConfigToHocon('a\0b').error, /NUL byte/);
  assert.throws(
    () => new MosquittoParser().parse('#'.repeat(4 * 1024 * 1024 + 1)),
    /exceeds/
  );
});
