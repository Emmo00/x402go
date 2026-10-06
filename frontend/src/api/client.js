import { API_BASE_URL } from '../env';

/** Normalised error shape for every call that goes through apiFetch. */
export class ApiError extends Error {
  constructor(message, { status = 0, code = 'api_error', payload = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

/** Raised when a screen needs data the backend does not expose yet. */
export class EndpointUnavailableError extends Error {
  constructor(endpoint, detail) {
    super(detail || `The backend does not expose ${endpoint} yet.`);
    this.name = 'EndpointUnavailableError';
    this.endpoint = endpoint;
  }
}

/**
 * Thin fetch wrapper.
 *
 * The backend authenticates with an httpOnly session cookie (`connect.sid`),
 * so every request must be sent with `credentials: 'include'`. No token is ever
 * held in JS, and nothing sensitive is persisted client-side.
 */
export async function apiFetch(path, { method = 'GET', body, signal, timeoutMs = 20000 } = {}) {
  let response;

  // The caller's signal wins; otherwise cap the wait so a stalled backend
  // cannot leave the UI in a loading state forever.
  const requestSignal =
    signal || (typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined);

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: requestSignal,
    });
  } catch (cause) {
    if (cause && cause.name === 'AbortError') throw cause;
    throw new ApiError('Cannot reach the x402Go API.', { code: 'network_error' });
  }

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : null;

  if (!response.ok) {
    const message =
      (payload && (payload.error || payload.message)) ||
      `Request failed with status ${response.status}.`;

    throw new ApiError(message, {
      status: response.status,
      code: response.status === 401 ? 'unauthorized' : 'api_error',
      payload,
    });
  }

  return payload;
}
