import { ConversionService } from './conversion-service.js';
import { frontend } from './frontend.js';

export const MAX_BODY = 1024 * 1024;
const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });

async function readBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY) {
      await reader.cancel();
      throw new RangeError(
        'Request body exceeds 1 MiB. Use the CLI for larger configurations.'
      );
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

export async function handleRequest(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!['/', '/index.html', '/convert'].includes(path))
    return json({ error: 'Not found' }, 404);
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers });
  if ((path === '/' || path === '/index.html') && request.method === 'GET') {
    return new Response(frontend(), {
      headers: {
        ...headers,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
      },
    });
  }
  if (path !== '/convert' || request.method !== 'POST')
    return json({ error: 'Method not allowed' }, 405);
  try {
    if (Number(request.headers.get('Content-Length')) > MAX_BODY)
      return json({ error: 'Request body exceeds 1 MiB.' }, 413);
    const body = await readBody(request);
    const contentType = request.headers.get('Content-Type') ?? '';
    let content: unknown;
    if (contentType.includes('application/json')) {
      let payload;
      try {
        payload = JSON.parse(new TextDecoder().decode(body));
      } catch {
        return json({ error: 'Invalid JSON body.' }, 400);
      }
      content = payload?.config ?? payload?.config_content;
    } else if (
      contentType.includes('multipart/form-data') ||
      contentType.includes('application/x-www-form-urlencoded')
    ) {
      let form;
      try {
        form = await new Response(body, {
          headers: { 'Content-Type': contentType },
        }).formData();
      } catch {
        return json({ error: 'Invalid form body.' }, 400);
      }
      const file = form.get('file');
      content =
        file && typeof file !== 'string'
          ? await file.text()
          : form.get('config_content');
    } else if (contentType.includes('text/plain'))
      content = new TextDecoder().decode(body);
    else return json({ error: 'Use JSON, a form upload, or text/plain.' }, 415);
    // Empty configuration is valid: Mosquitto's local-only default mode.
    if (typeof content !== 'string')
      return json(
        { error: 'Provide a configuration string or upload a file.' },
        400
      );
    const result = new ConversionService().convertConfigToHocon(content);
    return json(result, result.error ? 400 : 200);
  } catch (error) {
    if (error instanceof RangeError) return json({ error: error.message }, 413);
    return json({ error: 'Could not process the request.' }, 400);
  }
}
