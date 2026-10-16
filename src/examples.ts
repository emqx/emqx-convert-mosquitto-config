export const examples = {
  basic: {
    label: 'TCP + WebSocket',
    content: `# Mosquitto 2.0: explicitly allow anonymous clients for this example.
allow_anonymous true
listener 1883 0.0.0.0
protocol mqtt
listener 9001 0.0.0.0
protocol websockets
max_inflight_messages 20
max_queued_messages 1000
queue_qos0_messages false
retain_available true
log_dest stdout
log_type information
`,
  },
  tls: {
    label: 'Mutual TLS',
    content: `listener 8883 0.0.0.0
certfile /etc/mosquitto/certs/server.pem
keyfile /etc/mosquitto/certs/server.key
cafile /etc/mosquitto/certs/ca.pem
tls_version tlsv1.2
require_certificate true
use_identity_as_username true
allow_anonymous false
max_connections 5000
`,
  },
  security: {
    label: 'Per-listener security',
    content: `per_listener_settings true

# Private listener: migrate users and ACLs before enabling in EMQX.
listener 1883 127.0.0.1
allow_anonymous false
password_file /etc/mosquitto/passwd
acl_file /etc/mosquitto/acl

# Anonymous listener, isolated under a topic prefix.
listener 1884 127.0.0.1
allow_anonymous true
mount_point public/
`,
  },
  persistence: {
    label: 'Persistence + limits',
    content: `listener 1883 127.0.0.1
allow_anonymous true
persistence true
max_packet_size 1048576
max_inflight_messages 100
max_queued_messages 10000
queue_qos0_messages true
persistent_client_expiration 14d
max_qos 1
max_topic_alias 32
sys_interval 10
`,
  },
};
