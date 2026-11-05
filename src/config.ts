export interface Env {
  GEMINI_API_KEY: string;
  ALLOWED_SUBJECTS: string;
  PUBLIC_URL: string;
  OAUTH_ISSUER: string;
  OAUTH_JWKS_URL: string;
  ALLOWED_ORIGINS: string;
  IMAGE_BUCKET: R2Bucket;
  IMAGE_RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

export const SCOPE = 'images:write';
export const MiB = 1024 * 1024;
export const MAX_REQUEST_BYTES = 16 * MiB;
export const MAX_RESPONSE_BYTES = 24 * MiB;

export class PublicError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      /YOUR-|example\.com/i.test(url.hostname)) throw new Error('Invalid configuration');
  return url;
}

export function config(env: Env) {
  const publicUrl = httpsUrl(env.PUBLIC_URL);
  if (publicUrl.pathname !== '/') throw new Error('PUBLIC_URL must be an origin');
  const issuer = httpsUrl(env.OAUTH_ISSUER);
  const jwks = httpsUrl(env.OAUTH_JWKS_URL);
  const subjects: unknown = JSON.parse(env.ALLOWED_SUBJECTS);
  if (!Array.isArray(subjects) || !subjects.length ||
      !subjects.every(s => typeof s === 'string' && s.length > 0) || !env.GEMINI_API_KEY?.trim() ||
      !env.IMAGE_RATE_LIMITER || !env.IMAGE_BUCKET) throw new Error('Missing configuration');
  const origins = env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
  if (!origins.every(s => httpsUrl(s).origin === s)) throw new Error('Invalid origins');
  return {
    resource: `${publicUrl.origin}/mcp`,
    metadata: `${publicUrl.origin}/.well-known/oauth-protected-resource/mcp`,
    issuer: issuer.href,
    jwks,
    subjects: subjects as string[],
    origins,
  };
}

/** Bound streams even when Content-Length is absent or dishonest. */
export async function readLimited(message: Request | Response, max: number): Promise<string> {
  const declared = message.headers.get('content-length');
  if (declared && Number(declared) > max) {
    await message.body?.cancel();
    throw new PublicError(413, 'Payload exceeds the size limit.');
  }
  if (!message.body) return '';
  const reader = message.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new PublicError(413, 'Payload exceeds the size limit.');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
