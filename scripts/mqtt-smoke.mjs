// No MQTT library needed: an actual MQTT 3.1.1 CONNECT / SUBSCRIBE / PUBLISH
// exchange verifies that the generated listener accepts and routes traffic.
import net from 'node:net';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const port = Number(process.argv[2]);
const socket = net.createConnection({ host: '127.0.0.1', port });
const timer = setTimeout(() => {
  socket.destroy(new Error('MQTT smoke test timed out'));
}, 15000);
const text = (value) => {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
};
const packet = (header, body) => {
  assert.ok(body.length < 128);
  return Buffer.concat([Buffer.from([header, body.length]), body]);
};
const topic = `converter-test/${randomUUID()}`;
const payload = 'conversion-verified';
let buffer = Buffer.alloc(0);
let step = 0;
socket.once('connect', () =>
  socket.write(
    packet(
      0x10,
      Buffer.concat([
        text('MQTT'),
        Buffer.from([4, 2, 0, 30]),
        text(`test-${randomUUID()}`),
      ])
    )
  )
);
await new Promise((resolve, reject) => {
  socket.on('error', reject);
  socket.on('close', () => {
    if (step !== 3)
      reject(new Error('Connection closed before publish/subscribe completed'));
  });
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (buffer.length >= 2 && buffer.length >= buffer[1] + 2) {
        const response = buffer.subarray(0, buffer[1] + 2);
        buffer = buffer.subarray(response.length);
        if (step === 0) {
          assert.deepEqual(
            [...response],
            [0x20, 2, 0, 0],
            'MQTT CONNACK must succeed'
          );
          step = 1;
          socket.write(
            packet(
              0x82,
              Buffer.concat([
                Buffer.from([0, 1]),
                text(topic),
                Buffer.from([0]),
              ])
            )
          );
        } else if (step === 1) {
          assert.deepEqual(
            [...response],
            [0x90, 3, 0, 1, 0],
            'MQTT SUBACK must succeed'
          );
          step = 2;
          socket.write(
            packet(0x30, Buffer.concat([text(topic), Buffer.from(payload)]))
          );
        } else if (step === 2) {
          assert.equal(response[0] >> 4, 3);
          assert.equal(
            response.subarray(4, 4 + response.readUInt16BE(2)).toString(),
            topic
          );
          assert.equal(
            response.subarray(4 + response.readUInt16BE(2)).toString(),
            payload
          );
          step = 3;
          socket.end(Buffer.from([0xe0, 0]));
          resolve();
        }
      }
    } catch (error) {
      reject(error);
      socket.destroy();
    }
  });
}).finally(() => {
  clearTimeout(timer);
  socket.destroy();
});
console.log('MQTT CONNECT, SUBSCRIBE and publish/receive passed.');
