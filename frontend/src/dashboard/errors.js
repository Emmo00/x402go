import { ApiError } from '../api/client';

/**
 * Turns a thrown API error into copy a merchant can act on.
 *
 * The backend's own `{ message }` strings are written for users, but they are
 * only surfaced where the meaning is unambiguous and useful — the documented
 * 409 conflicts, which tell the user the one thing they need to do next.
 * Everything else, including any 5xx and any unexpected status, becomes a
 * generic sentence: a raw backend or network error is never shown, because it
 * describes the failure to the server rather than the situation to the user.
 */
export const SESSION_EXPIRED_MESSAGE =
  'Your session has expired. Sign in again to continue.';

export function describeError(cause) {
  if (cause instanceof ApiError) {
    if (cause.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (cause.status === 409) {
      // Documented conflicts carry a purpose-written message naming the fix.
      return cause.message || 'That action conflicts with the account’s current state.';
    }
    if (cause.status === 400) {
      return 'The facilitator rejected that value. Check it and try again.';
    }
    if (cause.status >= 500) {
      return 'The facilitator could not complete that request. Try again in a moment.';
    }
    if (cause.code === 'network_error') {
      return 'Cannot reach the x402Go API. Check your connection and try again.';
    }
    return 'The request could not be completed. Try again.';
  }

  return 'Something went wrong. Try again.';
}

/** True when the failure means the session is no longer valid. */
export function isUnauthorized(cause) {
  return cause instanceof ApiError && cause.status === 401;
}
