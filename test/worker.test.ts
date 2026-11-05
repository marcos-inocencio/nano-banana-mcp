import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker from '../src/index.js';
import type { Env } from '../src/config.js';
import { MAX_REQUEST_BYTES, readLimited } from '../src/config.js';
import { base64Bytes, imageSchema, MAX_IMAGE_BYTES } from '../src/schema.js';

// A real 1x1 PNG fixture, not a credential.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const reference = { data: png, mime_type: 'image/png' };
const env: Env = {
  PUBLIC_URL: 'https://nano.test', OAUTH_ISSUER: 'https://issuer.test/',
  OAUTH_JWKS_URL: 'https://issuer.test/jwks', ALLOWED_ORIGINS: 'https://claude.ai',
  GEMINI_API_KEY: 'test-only-not-a-real-key', ALLOWED_SUBJECTS: '["owner"]',
  IMAGE_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
  IMAGE_BUCKET: { put: vi.fn(), get: vi.fn() } as unknown as R2Bucket,
};
let privateKey: CryptoKey;
let jwks: unknown;
let upstream: Mock<(url: string, init: RequestInit) => Promise<Response>>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  jwks = { keys: [{ ...await exportJWK(pair.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' }] };
});
beforeEach(() => {
  vi.mocked(env.IMAGE_RATE_LIMITER.limit).mockResolvedValue({ success: true });
  upstream = vi.fn(async () => Response.json({
    status: 'completed',
    steps: [
      { type: 'thought', summary: [{ type: 'image', data: png, mime_type: 'image/png' }] },
      { type: 'model_output', content: [{ type: 'image', data: png, mime_type: 'image/png' }] },
    ],
  }));
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (String(url) === env.OAUTH_JWKS_URL) return Promise.resolve(Response.json(jwks));
    if (String(url) === 'https://generativelanguage.googleapis.com/v1beta/interactions' && init) return upstream(url, init);
    throw new Error('Unexpected external request in test');
  }));
});
afterEach(() => vi.unstubAllGlobals());

async function token(claims: Record<string, unknown> = {}) {
  return new SignJWT({ scope: 'images:write', sub: 'owner', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(typeof claims.iss === 'string' ? claims.iss : env.OAUTH_ISSUER)
    .setAudience(typeof claims.aud === 'string' ? claims.aud : `${env.PUBLIC_URL}/mcp`)
    .setExpirationTime(typeof claims.exp === 'number' ? claims.exp : '5m')
    .sign(privateKey);
}
async function rpc(method: string, params: unknown = {}, accessToken?: string) {
  return worker.fetch(new Request(`${env.PUBLIC_URL}/mcp`, {
    method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), env);
}
async function call(args: unknown, name = 'generate_image') {
  return (await rpc('tools/call', { name, arguments: args }, await token())).json() as Promise<{
    result: { isError?: boolean; content: Array<{ type: string; text?: string; data?: string }> };
    error?: unknown;
  }>;
}

describe('authentication and transport', () => {
  it('fails closed with missing configuration', async () => {
    const response = await worker.fetch(new Request(`${env.PUBLIC_URL}/mcp`), { ...env, ALLOWED_SUBJECTS: '[]' });
    expect(response.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('advertises protected resource metadata without a token', async () => {
    const response = await worker.fetch(new Request(`${env.PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`), env);
    expect(await response.json()).toMatchObject({ resource: `${env.PUBLIC_URL}/mcp`, authorization_servers: [env.OAUTH_ISSUER] });
  });
  it('rejects anonymous calls before contacting Gemini', async () => {
    const response = await rpc('tools/call', { name: 'generate_image', arguments: { prompt: 'banana' } });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each([
    [{ aud: 'https://other.test/mcp' }, 401],
    [{ iss: 'https://other.test/' }, 401],
    [{ exp: 1 }, 401],
    [{ scope: 'profile' }, 403],
    [{ sub: 'stranger' }, 403],
  ])('rejects invalid claims %j', async (claims, status) => {
    expect((await rpc('tools/list', {}, await token(claims))).status).toBe(status);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('rejects tampered tokens', async () => {
    expect((await rpc('tools/list', {}, `${await token()}tampered`)).status).toBe(401);
  });
  it('initializes and lists both tools on independent requests', async () => {
    const access = await token();
    const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }, access);
    expect(init.status).toBe(200);
    expect(await init.json()).toMatchObject({ result: { serverInfo: { name: 'nano-banana-mcp' } } });
    expect(init.headers.has('mcp-session-id')).toBe(false);
    const list = await (await rpc('tools/list', {}, access)).json() as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map(t => t.name)).toEqual(['generate_image', 'edit_image']);
  });
  it('rejects untrusted browser origins', async () => {
    const response = await worker.fetch(new Request(`${env.PUBLIC_URL}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://evil.test' } }), env);
    expect(response.status).toBe(403);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
  });
  it('allows preflight only for configured origins', async () => {
    const response = await worker.fetch(new Request(`${env.PUBLIC_URL}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://claude.ai' } }), env);
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://claude.ai');
  });
  it('bounds the body before JSON parsing', async () => {
    const response = await worker.fetch(new Request(`${env.PUBLIC_URL}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json', 'content-length': String(MAX_REQUEST_BYTES + 1) }, body: '{}',
    }), env);
    expect(response.status).toBe(413);
  });
  it('rejects malformed JSON and stateless GET', async () => {
    const headers = { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' };
    expect((await worker.fetch(new Request(`${env.PUBLIC_URL}/mcp`, { method: 'POST', headers, body: '{' }), env)).status).toBe(400);
    expect((await worker.fetch(new Request(`${env.PUBLIC_URL}/mcp`, { headers }), env)).status).toBe(405);
  });
});

describe('Gemini tools', () => {
  it('sends 4K options and returns MCP image content without thoughts', async () => {
    const result = await call({ prompt: 'A banana', resolution: '4K', aspect_ratio: '16:9' });
    expect(result.result.content).toEqual([{ type: 'image', data: png, mimeType: 'image/png' }]);
    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/v1beta/interactions');
    expect(new Headers(init.headers).get('x-goog-api-key')).toBe(env.GEMINI_API_KEY);
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'gemini-nano-banana-2.1', store: false,
      response_format: { image_size: '4K', aspect_ratio: '16:9' },
    });
  });
  it('forwards validated reference images for editing', async () => {
    expect((await call({ prompt: 'Make it blue', reference_images: [reference] }, 'edit_image')).result.isError).not.toBe(true);
    const body = JSON.parse(upstream.mock.calls[0][1].body as string);
    expect(body.input[1]).toEqual({ type: 'image', ...reference });
  });
  it.each([
    [{ prompt: 'banana', model: 'gemini-2.5-flash-image', resolution: '4K' }, 'generate_image'],
    [{ prompt: 'banana', reference_images: [] }, 'edit_image'],
    [{ prompt: 'banana', reference_images: [{ data: 'AAAA', mime_type: 'image/png' }] }, 'edit_image'],
    [{ prompt: 'banana', reference_images: [{ url: 'http://localhost/private' }] }, 'edit_image'],
    [{ prompt: ' ' }, 'generate_image'],
  ])('rejects invalid input without an upstream request', async (args, name) => {
    const result = await call(args, name);
    expect(result.result?.isError || result.error).toBeTruthy();
    expect(upstream).not.toHaveBeenCalled();
  });
  it('enforces the per-user generation rate limit', async () => {
    vi.mocked(env.IMAGE_RATE_LIMITER.limit).mockResolvedValueOnce({ success: false });
    expect((await call({ prompt: 'banana' })).result.isError).toBe(true);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 404, 429, 500])('sanitizes upstream errors (%s)', async status => {
    upstream.mockResolvedValueOnce(new Response('sensitive provider diagnostic', { status }));
    const result = await call({ prompt: 'banana' });
    expect(result.result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('sensitive provider diagnostic');
  });
  it('handles refusal and malformed provider output', async () => {
    upstream.mockResolvedValueOnce(Response.json({ status: 'completed', steps: [] }));
    expect((await call({ prompt: 'banana' })).result.isError).toBe(true);
    upstream.mockResolvedValueOnce(new Response('not json'));
    expect((await call({ prompt: 'banana' })).result.isError).toBe(true);
  });
  it('handles timeout without retrying a billable operation', async () => {
    vi.useFakeTimers();
    upstream.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    try {
      const pending = call({ prompt: 'banana' });
      // Let JWT verification and request dispatch finish before advancing timers.
      await vi.waitFor(() => expect(upstream).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(120_000);
      expect((await pending).result.isError).toBe(true);
      expect(upstream).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});

describe('size and capability validation', () => {
  it('delivers large images via expiring private R2 download capabilities', async () => {
    const largePng = btoa('\x89PNG\r\n\x1a\n' + 'a'.repeat(100_000));
    upstream.mockResolvedValueOnce(Response.json({ status: 'completed', steps: [
      { type: 'model_output', content: [{ type: 'image', data: largePng, mime_type: 'image/png' }] },
    ] }));
    const result = await call({ prompt: '4K banana', resolution: '4K' });
    expect(JSON.stringify(result).length).toBeLessThan(150_000);
    const url = /https:\/\/nano.test\/images\/[a-f0-9]{64}/.exec(JSON.stringify(result))?.[0];
    expect(url).toBeTruthy();
    const put = vi.mocked(env.IMAGE_BUCKET.put).mock.calls.at(-1)!;
    expect(put[0]).not.toContain(url!.split('/').at(-1));
    const bytes = put[1] as Uint8Array;
    const metadata = put[2]!;
    vi.mocked(env.IMAGE_BUCKET.get).mockImplementation(async () => ({
      body: new Response(new Uint8Array(bytes).buffer).body, size: bytes.length,
      customMetadata: metadata.customMetadata, httpMetadata: metadata.httpMetadata,
    }) as unknown as R2ObjectBody);
    const download = await worker.fetch(new Request(url!), env);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('image/png');
    expect((await download.arrayBuffer()).byteLength).toBe(bytes.length);
    vi.mocked(env.IMAGE_BUCKET.get).mockResolvedValueOnce({ body: new Response(new Uint8Array(bytes).buffer).body, customMetadata: { expires: '1' } } as unknown as R2ObjectBody);
    expect((await worker.fetch(new Request(url!), env)).status).toBe(404);
    vi.mocked(env.IMAGE_BUCKET.get).mockResolvedValueOnce(null);
    expect((await worker.fetch(new Request(`${env.PUBLIC_URL}/images/${'0'.repeat(64)}`), env)).status).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it('bounds a streamed body without Content-Length', async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.enqueue(new Uint8Array(10)); c.close(); } });
    await expect(readLimited(new Response(stream), 15)).rejects.toThrow('size limit');
  });
  it('validates large base64 without regex stack overflow', () => {
    const data = btoa('\x89PNG\r\n\x1a\n' + 'a'.repeat(MAX_IMAGE_BYTES - 8));
    expect(base64Bytes(data)).toBe(MAX_IMAGE_BYTES);
    expect(imageSchema.safeParse({ prompt: 'test', reference_images: [{ data, mime_type: 'image/png' }] }).success).toBe(true);
    expect(imageSchema.safeParse({ prompt: 'test', reference_images: Array(3).fill({ data, mime_type: 'image/png' }) }).success).toBe(false);
  });
  it('restricts resolution, aspect ratio and reference count by model', () => {
    expect(imageSchema.safeParse({ prompt: 'test', model: 'gemini-3.1-flash-image', resolution: '512px', aspect_ratio: '8:1' }).success).toBe(true);
    expect(imageSchema.safeParse({ prompt: 'test', resolution: '512px' }).success).toBe(false);
    expect(imageSchema.safeParse({ prompt: 'test', model: 'gemini-3-pro-image', aspect_ratio: '8:1' }).success).toBe(false);
    expect(imageSchema.safeParse({ prompt: 'test', model: 'gemini-2.5-flash-image', reference_images: Array(4).fill(reference) }).success).toBe(false);
    expect(base64Bytes('@@==')).toBe(-1);
    expect(base64Bytes('abc')).toBe(-1);
  });
});
