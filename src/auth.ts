import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { config } from './config.js';
import { PublicError, SCOPE } from './config.js';

type Config = ReturnType<typeof config>;
// Cache only public verification keys; never cache tokens or authorization decisions.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticate(request: Request, cfg: Config): Promise<string> {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '');
  if (!match || match[1].length > 8192) throw new PublicError(401, 'Authentication required.');
  let keys = keySets.get(cfg.jwks.href);
  if (!keys) {
    keys = createRemoteJWKSet(cfg.jwks, { timeoutDuration: 5000 });
    keySets.set(cfg.jwks.href, keys);
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(match[1], keys, {
      algorithms: ['RS256'],
      issuer: cfg.issuer,
      audience: cfg.resource,
      requiredClaims: ['exp', 'sub', 'iss', 'aud'],
      clockTolerance: 5,
    }));
  } catch {
    throw new PublicError(401, 'Invalid or expired access token.');
  }
  if (!payload.sub || !cfg.subjects.includes(payload.sub)) {
    throw new PublicError(403, 'User is not authorized.');
  }
  if (typeof payload.scope !== 'string' || !payload.scope.split(' ').includes(SCOPE)) {
    throw new PublicError(403, 'Required scope is missing.');
  }
  return payload.sub;
}
