import { NextFunction, Request, Response } from 'express';
import ApiKeyService from '../services/apiKeys.service';

/**
 * Header a client presents its API key in.
 *
 * `Authorization: Bearer` is the canonical form — it is the standard HTTP
 * credential header, so every client library can set it without special
 * support. `x-api-key` is accepted as an alias because plenty of server-side
 * tooling and gateway configurations expose only that one. If both are present
 * the `Authorization` header wins, so a client can never downgrade itself by
 * leaving a stale `x-api-key` in place.
 */
const AUTHORIZATION_HEADER = 'authorization';
const API_KEY_HEADER = 'x-api-key';
const BEARER_SCHEME = 'bearer';

/**
 * Reads the presented key without ever recording it.
 *
 * Nothing in this function logs, and the value it returns is only ever handed
 * to the verifier. The key must not be copied into an error message, a request
 * log, or an error object — an exception carrying it would end up in the
 * central error handler's stack trace.
 */
function readApiKey(req: Request): string | null {
  const authorization = req.get(AUTHORIZATION_HEADER);

  if (authorization) {
    const [scheme, ...rest] = authorization.split(' ');

    if (scheme?.toLowerCase() === BEARER_SCHEME && rest.length > 0) {
      const value = rest.join(' ').trim();

      return value.length > 0 ? value : null;
    }
  }

  const headerValue = req.get(API_KEY_HEADER);

  return headerValue && headerValue.trim().length > 0 ? headerValue.trim() : null;
}

/**
 * Authenticates a request from its API key.
 *
 * Deliberately the same shape as `requireAuth`: it resolves the account, puts
 * the user document on `req.user`, and hands off. Both middlewares therefore
 * leave the route handler looking at the same thing, and a route can be moved
 * between them without any other change.
 *
 * Every failure returns the same 401 with the same message. A missing key, a
 * malformed key, an unknown key and a rotated-away key are indistinguishable
 * from outside, so the response cannot be used to probe which keys once
 * existed.
 */
async function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const presented = readApiKey(req);

  if (!presented) {
    return res.status(401).json({ message: 'API key required' });
  }

  const user = await new ApiKeyService().findUserByApiKey(presented);

  if (!user) {
    return res.status(401).json({ message: 'Invalid API key' });
  }

  req.user = user;

  next();
}

export default apiKeyAuth;
