import { authenticate } from './auth.js';
import { config, MAX_REQUEST_BYTES, PublicError, readLimited, SCOPE } from './config.js';
import type { Env } from './config.js';
import { handleMcp } from './mcp.js';
import { downloadImage } from './images.js';

async function route(request: Request, env: Env, cfg: ReturnType<typeof config>): Promise<Response> {
  const path = new URL(request.url).pathname;
  const origin = request.headers.get('origin');
  if (origin && !cfg.origins.includes(origin)) throw new PublicError(403, 'Origin is not allowed.');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (path.startsWith('/images/')) return downloadImage(request, env);
  if (['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(path)) {
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
    return Response.json({
      resource: cfg.resource,
      authorization_servers: [cfg.issuer],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Nano Banana MCP',
    });
  }
  if (path !== '/mcp') return new Response('Not found', { status: 404 });
  const subject = await authenticate(request, cfg);
  // Stateless Streamable HTTP: no unsolicited SSE stream or session deletion.
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new PublicError(415, 'Use application/json.');
  }
  let body: unknown;
  const text = await readLimited(request, MAX_REQUEST_BYTES);
  try { body = JSON.parse(text); }
  catch { throw new PublicError(400, 'Invalid JSON.'); }
  if (Array.isArray(body)) throw new PublicError(400, 'JSON-RPC batches are not supported.');
  return handleMcp(request, body, env, subject);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let cfg: ReturnType<typeof config>;
    try { cfg = config(env); }
    catch { return Response.json({ error: 'Server configuration is incomplete.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
    let response: Response;
    try { response = await route(request, env, cfg); }
    catch (error) {
      const status = error instanceof PublicError ? error.status : 500;
      const headers = new Headers();
      if (status === 401 || status === 403) {
        const reason = status === 401 ? 'invalid_token' : 'insufficient_scope';
        headers.set('WWW-Authenticate', `Bearer error="${reason}", resource_metadata="${cfg.metadata}", scope="${SCOPE}"`);
      }
      response = Response.json({ error: error instanceof PublicError ? error.message : 'Internal server error.' }, { status, headers });
    }
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Vary', 'Origin');
    const origin = request.headers.get('origin');
    if (origin && cfg.origins.includes(origin)) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id');
      headers.set('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Protocol-Version, MCP-Session-Id');
    }
    return new Response(response.body, { status: response.status, headers });
  },
};
