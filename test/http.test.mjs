import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../dist/http-handler.js';

const request = (path, options) =>
  handleRequest(new Request(`http://localhost${path}`, options));
const post = (body, contentType = 'application/json') =>
  request('/convert', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });

test('root serves the complete converter UI without external scripts', async () => {
  const response = await request('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
  const html = await response.text();
  assert.match(html, /Mosquitto → EMQX/);
  assert.match(html, /Download .hocon/);
  assert.ok(!html.includes('<script src='));
  assert.ok(
    response.headers
      .get('Content-Security-Policy')
      .includes("frame-ancestors 'none'")
  );
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script));
});

test('JSON, raw text, multipart and urlencoded conversion routes work', async () => {
  const config = 'listener 1883 127.0.0.1\nallow_anonymous true';
  const form = new FormData();
  form.set(
    'file',
    new File([config], 'mosquitto.conf', { type: 'text/plain' })
  );
  const responses = await Promise.all([
    post(JSON.stringify({ config })),
    post(config, 'text/plain'),
    request('/convert', { method: 'POST', body: form }),
    request('/convert', {
      method: 'POST',
      body: new URLSearchParams({ config_content: config }),
    }),
  ]);
  const outputs = [];
  for (const response of responses) {
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.disabledListeners, []);
    assert.ok(Array.isArray(result.warnings));
    outputs.push(result.hocon);
  }
  assert.ok(outputs.every((value) => value === outputs[0]));
});

test('empty config is valid, missing or malformed input is not', async () => {
  assert.equal((await post(JSON.stringify({ config: '' }))).status, 200);
  for (const body of [
    '{',
    'null',
    '[]',
    '{}',
    '{"config":42}',
    '{"config":"listener nope"}',
  ]) {
    const response = await post(body);
    assert.equal(response.status, 400, body);
    assert.ok((await response.json()).error);
  }
  assert.equal((await post('hi', 'application/octet-stream')).status, 415);
});

test('HTTP API never resolves server files from include_dir', async () => {
  const response = await post(JSON.stringify({ config: 'include_dir /etc' }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /local files/);
});

test('routes return meaningful statuses without enabling cross-origin access', async () => {
  assert.equal((await request('/missing')).status, 404);
  assert.equal((await request('/convert')).status, 405);
  const response = await request('/convert', { method: 'OPTIONS' });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('both declared and streamed oversized request bodies are rejected', async () => {
  assert.equal(
    (await post('x'.repeat(1024 * 1024 + 1), 'text/plain')).status,
    413
  );
  const response = await request('/convert', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'Content-Length': '9999999' },
    body: '',
  });
  assert.equal(response.status, 413);
});
