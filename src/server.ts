#!/usr/bin/env node
import { createServer, type IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { handleRequest, MAX_BODY } from './http-handler.js';

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    request.on('data', (chunk: Buffer) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        exceeded = true;
        chunks.length = 0;
        reject(new RangeError('Request body exceeds 1 MiB.'));
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      if (!exceeded) resolveBody(Buffer.concat(chunks));
    });
    request.on('error', reject);
    request.on('aborted', () => reject(new Error('Request aborted.')));
  });
}

/** The executable binds only 127.0.0.1; exporting the server allows real HTTP tests. */
export function createLocalServer() {
  const server = createServer(async (incoming, outgoing) => {
    const error = (status: number, message: string): void => {
      outgoing.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        Connection: 'close',
      });
      outgoing.end(JSON.stringify({ error: message }));
      incoming.resume();
    };
    try {
      // Reject DNS rebinding and browser requests from unrelated websites.
      const address = server.address();
      const port = address && typeof address !== 'string' ? address.port : 8787;
      const host = incoming.headers.host;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host ?? '')) {
        error(403, 'This server only accepts localhost requests.');
        return;
      }
      const origin = `http://${host}`;
      if (
        !['GET', 'HEAD', 'OPTIONS'].includes(incoming.method ?? 'GET') &&
        ((incoming.headers.origin && incoming.headers.origin !== origin) ||
          incoming.headers['sec-fetch-site'] === 'cross-site')
      ) {
        error(403, 'Cross-origin requests are not allowed.');
        return;
      }
      if (Number(incoming.headers['content-length']) > MAX_BODY) {
        error(413, 'Request body exceeds 1 MiB.');
        return;
      }
      const body = await readBody(incoming);
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const method = incoming.method ?? 'GET';
      const request = new Request(new URL(incoming.url ?? '/', origin), {
        method,
        headers,
        ...(method !== 'GET' && method !== 'HEAD'
          ? { body: new Uint8Array(body) }
          : {}),
      });
      const response = await handleRequest(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (cause) {
      if (!outgoing.headersSent)
        error(
          cause instanceof RangeError ? 413 : 400,
          cause instanceof RangeError
            ? cause.message
            : 'Could not process the request.'
        );
      else outgoing.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: node dist/server.js [--port 8787]\nStarts the converter on 127.0.0.1. PORT can also set the port.'
    );
    return;
  }
  if (args.length && (args.length !== 2 || args[0] !== '--port'))
    throw new Error('Expected --port <number> or --help.');
  const rawPort = args[1] ?? process.env.PORT ?? '8787';
  const port = Number(rawPort);
  if (
    !/^\d+$/.test(rawPort) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('Port must be an integer from 1 to 65535.');
  const server = createLocalServer();
  server.on('error', (error) => {
    console.error(`Server error: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () =>
    console.log(
      `Mosquitto → EMQX converter: http://127.0.0.1:${port}\nPress Ctrl+C to stop.`
    )
  );
  const stop = () => {
    server.close();
    server.closeAllConnections();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
