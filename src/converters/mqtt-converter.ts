import { fail, integerValue } from '../mosquitto-parser.js';
import {
  BaseConverter,
  ConversionContext,
  Settings,
} from './base-converter.js';
import type { HoconObject } from '../types.js';

export class MqttConverter extends BaseConverter {
  convert(context: ConversionContext): void {
    const s = new Settings(
      context.source.globals.filter(
        (d) => !['log_dest', 'log_type'].includes(d.name)
      ),
      context
    );
    const maxInflight = s.int('max_inflight_messages', 20);
    const packetSize = s.int('max_packet_size', 0, 0, 268435455);
    if (packetSize > 0 && packetSize < 20)
      fail(s.get('max_packet_size')!, 'must be zero or at least 20 bytes.');
    const mqtt: HoconObject = {
      max_packet_size: `${packetSize || 268435455}B`,
      max_inflight: maxInflight === 0 ? 65535 : Math.min(maxInflight, 65535),
      max_mqueue_len: s.int('max_queued_messages', 1000),
      mqueue_store_qos0: s.bool('queue_qos0_messages', false),
      retain_available: s.bool('retain_available', true),
      upgrade_qos: s.bool('upgrade_outgoing_qos', false),
      max_topic_alias: 10,
    };
    if (maxInflight === 0 || maxInflight > 65535)
      context.warn(
        'INFLIGHT_LIMIT',
        'EMQX caps max_inflight at 65535; Mosquitto unlimited/larger inflight windows cannot be reproduced.',
        s.get('max_inflight_messages')
      );
    const expiry = s.get('persistent_client_expiration');
    if (expiry) {
      const match = /^(\d+)([hdwmy])$/.exec(expiry.value);
      if (!match || Number(match[1]) === 0)
        fail(
          expiry,
          'expected a positive duration ending in h, d, w, m (month), or y.'
        );
      const units: Record<string, number> = {
        h: 3600,
        d: 86400,
        w: 604800,
        m: 2592000,
        y: 31536000,
      };
      const seconds = Number(match[1]) * units[match[2]!]!;
      if (!Number.isSafeInteger(seconds))
        fail(expiry, 'duration is too large.');
      mqtt.session_expiry_interval = `${seconds}s`;
      context.warn(
        'SESSION_EXPIRY',
        'Session expiry is mapped for MQTT 3.x. MQTT 5 clients control their own Session-Expiry-Interval in EMQX.',
        expiry
      );
    } else {
      context.warn(
        'SESSION_EXPIRY_DEFAULT',
        'Mosquitto persistent sessions do not expire by default. EMQX uses a 2h MQTT 3.x session expiry; set mqtt.session_expiry_interval for your retention policy.'
      );
    }
    if (s.get('max_keepalive')) {
      s.int('max_keepalive', 65535, 0, 65535);
      context.warn(
        'KEEPALIVE_LIMIT',
        'max_keepalive is not mapped: EMQX server_keepalive overrides MQTT 5 clients instead of imposing Mosquitto’s upper bound, and does not enforce the MQTT 3.x cap.',
        s.get('max_keepalive')
      );
    }
    if (mqtt.max_mqueue_len !== 0)
      context.warn(
        'QUEUE_OVERFLOW',
        'Queue length is preserved, but EMQX drops the oldest queued message when full; Mosquitto drops new messages.',
        s.get('max_queued_messages')
      );
    const persistence = s.bool('persistence', false);
    context.config.mqtt = mqtt;
    context.config.durable_sessions = { enable: persistence };
    context.config.retainer = {
      backend: {
        type: 'built_in_database',
        storage_type: persistence ? 'disc' : 'ram',
      },
      max_payload_size: mqtt.max_packet_size!,
    };
    if (persistence)
      context.warn(
        'PERSISTENCE_MIGRATION',
        'Enabled EMQX durable sessions and disk-backed retained messages. mosquitto.db is not imported; migrate retained messages separately and review durable-session retention and performance.',
        s.get('persistence')
      );
    const interval = s.int('sys_interval', 10);
    context.config.sys_topics = {
      sys_msg_interval: interval ? `${interval}s` : 'disabled',
      sys_heartbeat_interval: interval ? `${interval}s` : 'disabled',
    };
    if (s.get('sys_interval'))
      context.warn(
        'SYS_TOPICS',
        'System publication intervals are mapped; EMQX uses different $SYS topic names and payloads.',
        s.get('sys_interval')
      );

    const mapped = new Set([
      'max_inflight_messages',
      'max_packet_size',
      'max_queued_messages',
      'queue_qos0_messages',
      'retain_available',
      'upgrade_outgoing_qos',
      'persistent_client_expiration',
      'persistence',
      'sys_interval',
      'set_tcp_nodelay',
      'max_keepalive',
      'log_dest',
      'log_type',
    ]);
    const manual: Record<string, string> = {
      max_inflight_bytes:
        'There is no equivalent inflight byte limit; review EMQX message and connection limits.',
      max_queued_bytes:
        'There is no equivalent queued byte limit; max_mqueue_len limits message count only.',
      message_size_limit:
        'Payload-only limits differ from MQTT packet limits. Configure application validation separately; mqtt.max_packet_size is not an equivalent.',
      memory_limit:
        'Configure container/process memory limits and EMQX memory protection separately.',
      autosave_interval:
        'EMQX durability does not use Mosquitto snapshot intervals.',
      autosave_on_changes:
        'EMQX durability does not use Mosquitto snapshot triggers.',
      persistence_file:
        'EMQX cannot read mosquitto.db; its data directory is managed separately.',
      persistence_location:
        'Configure the EMQX data directory separately; source data is not copied.',
      pid_file: 'Process PID files are managed by the EMQX service/container.',
      user: 'Configure the operating-system user for the EMQX service/container separately.',
      connection_messages:
        'Configure EMQX logging and event tracing separately.',
      log_timestamp:
        'EMQX logger formatting differs; configure timestamps separately.',
      log_timestamp_format: 'EMQX does not use strftime log formats.',
      log_facility: 'Configure syslog forwarding outside this converter.',
      check_retain_source:
        'Retained-message source authorization has different semantics in EMQX; review retained-message access.',
      allow_duplicate_messages:
        'Overlapping subscriptions and duplicate delivery differ between brokers.',
      websockets_log_level: 'EMQX does not use libwebsockets logging.',
      websockets_headers_size:
        'Review EMQX WebSocket HTTP header limits separately.',
      retry_interval:
        'Mosquitto 2.0 ignores retry_interval. EMQX retransmission behavior differs.',
      restart_timeout:
        'Bridge reconnect policy must be migrated with the MQTT connector.',
    };
    for (const d of context.source.globals) {
      if (mapped.has(d.name)) continue;
      if (
        [
          'max_inflight_bytes',
          'max_queued_bytes',
          'message_size_limit',
          'memory_limit',
        ].includes(d.name) &&
        integerValue(d) === 0
      )
        continue;
      if (
        [
          'autosave_on_changes',
          'connection_messages',
          'log_timestamp',
          'check_retain_source',
          'allow_duplicate_messages',
        ].includes(d.name)
      )
        s.bool(d.name, false);
      if (d.name === 'clientid_prefixes') {
        context.blockAllListeners = true;
        context.warn(
          'CLIENTID_RESTRICTION',
          'clientid_prefixes requires an EMQX client-ID authentication policy. All listeners are disabled until that policy is configured.',
          d
        );
      } else if (manual[d.name]) {
        context.warn('MANUAL_SETTING', `${d.name}: ${manual[d.name]}`, d);
      } else {
        context.blockAllListeners = true;
        context.warn(
          'UNSUPPORTED_DIRECTIVE',
          `Unsupported directive ${d.name}. All listeners are disabled because its effect cannot be determined; review it before enabling them.`,
          d
        );
      }
    }
  }
}
