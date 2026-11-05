import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Env } from './config.js';

export const DOWNLOAD_TTL_SECONDS = 15 * 60;
const INLINE_BASE64_LIMIT = 100_000;

async function objectKey(token: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return `images/${Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Keep the entire MCP result below Claude's ~150k character limit. */
export async function deliverImages(result: CallToolResult, env: Env): Promise<CallToolResult> {
  const content: CallToolResult['content'] = [];
  let inlineBudget = INLINE_BASE64_LIMIT;
  let textBudget = 8000;
  for (const block of result.content) {
    if (block.type === 'text') {
      const text = block.text.slice(0, textBudget);
      textBudget -= text.length;
      if (text) content.push({ type: 'text', text });
    } else if (block.type === 'image') {
      if (block.data.length <= inlineBudget) {
        inlineBudget -= block.data.length;
        content.push(block);
        continue;
      }
      // A 256-bit bearer capability authorizes only this download, never generation.
      // Store its hash, not the capability itself, as the private R2 object key.
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
      const expires = Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS;
      const bytes = Uint8Array.from(atob(block.data), c => c.charCodeAt(0));
      await env.IMAGE_BUCKET.put(await objectKey(token), bytes, {
        httpMetadata: { contentType: block.mimeType },
        customMetadata: { expires: String(expires) },
      });
      const url = `${new URL(env.PUBLIC_URL).origin}/images/${token}`;
      content.push({ type: 'text', text: `Image generated at the requested native resolution. [Download image](${url}) (private bearer link, expires in 15 minutes; anyone with this link can download until expiry).` });
    }
  }
  return { ...result, content };
}

export async function downloadImage(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
  const token = /^\/images\/([a-f0-9]{64})$/.exec(new URL(request.url).pathname)?.[1];
  if (!token) return new Response('Not found', { status: 404 });
  const object = await env.IMAGE_BUCKET.get(await objectKey(token));
  if (!object) return new Response('Not found', { status: 404 });
  const expires = Number(object.customMetadata?.expires);
  if (!Number.isFinite(expires) || expires <= Math.floor(Date.now() / 1000)) {
    await object.body.cancel();
    return new Response('Not found', { status: 404 });
  }
  const mime = object.httpMetadata?.contentType;
  const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  return new Response(object.body, { headers: {
    'Content-Type': mime ?? 'application/octet-stream',
    'Content-Length': String(object.size),
    'Content-Disposition': `attachment; filename="nano-banana.${extension}"`,
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  } });
}
