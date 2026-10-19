import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { createLocalServer } from '../dist/server.js';

test('local server serves the UI and API, bounds streaming input and restricts origins', async (t) => {
  const server = createLocalServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  assert.match(await (await fetch(base)).text(), /Mosquitto → EMQX/);
  assert.equal(
    (await fetch(base, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status,
    200,
    'top-level navigation from another page may open the UI'
  );
  const response = await fetch(base + '/convert', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', Origin: base },
    body: 'listener 1883\nallow_anonymous true',
  });
  assert.equal(response.status, 200);
  assert.match((await response.json()).hocon, /EMQX 6.3.2/);
  assert.equal(
    (
      await fetch(base + '/convert', {
        method: 'POST',
        headers: { Origin: 'https://external.example' },
        body: '',
      })
    ).status,
    403
  );
  // fetch normalizes Host; use the raw HTTP client to exercise rebinding checks.
  const foreignHost = await new Promise((resolve, reject) => {
    const req = request(
      base,
      { headers: { Host: `external.example:${port}` } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(foreignHost, 403);
  assert.equal(
    (
      await fetch(base + '/convert', {
        method: 'POST',
        body: 'x'.repeat(1024 * 1024 + 1),
      })
    ).status,
    413
  );
  const streamed = await new Promise((resolve, reject) => {
    const req = request(
      base + '/convert',
      { method: 'POST', headers: { 'Content-Type': 'text/plain' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    for (let i = 0; i < 17; i++) req.write(Buffer.alloc(65536, 120));
    req.end();
  });
  assert.equal(streamed, 413);
  assert.equal(
    (await fetch(base)).status,
    200,
    'server still responds after oversized requests'
  );
});
