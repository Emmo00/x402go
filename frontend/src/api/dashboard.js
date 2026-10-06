import { apiFetch, EndpointUnavailableError } from './client';

/**
 * Merchant data surfaces for the dashboard.
 *
 * Every function here corresponds to a path in `backend/src/docs/`. The
 * specification is the contract: a call is only added once the path is
 * documented there, and the request and response shapes below are copied from
 * it rather than guessed. Do not add a call without a matching entry in the
 * spec, and do not invent a path for an endpoint that does not exist.
 */

/** Overview screen: balances, fee totals and the payment feed. */
export async function fetchOverview() {
  // No path for this in backend/src/docs/ yet. Needs, for the connected
  // merchant: { availableBalance, totalReceived, totalFees, transactionCount }
  // plus a time series for the payment-activity chart and a recent transaction
  // list of { id, amount, fee, status, token, timestamp }.
  throw new EndpointUnavailableError('merchant overview');
}

/* -------------------------------------------------------------------------- */
/* Payout wallet — backend/src/docs/payout.yaml                               */
/* -------------------------------------------------------------------------- */

/**
 * `GET /payout` → 200 `{ payTo: string | null }`
 *
 * `payTo` is `null` until the account has set one, which is the state the
 * onboarding step keys off. 401 when the session is gone.
 */
export function fetchPayoutAddress() {
  return apiFetch('/payout');
}

/**
 * `PUT /payout` — `{ payTo }` → 200 `{ payTo }` (lowercased)
 *
 * The account comes from the session cookie, never from the body, so there is
 * no user identifier to send and no way to address another account.
 */
export function updatePayoutAddress(payTo) {
  return apiFetch('/payout', { method: 'PUT', body: { payTo } });
}

/* -------------------------------------------------------------------------- */
/* API keys — backend/src/docs/apiKeys.yaml                                   */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api-keys` → 201 `{ apiKey, suffix, maskedKey, createdAt, rotatedAt? }`
 *
 * `apiKey` is the plaintext key and this is the only response that carries it.
 * 401 when the session is gone; 409 when the account already holds a key — an
 * account may have exactly one, so a second call is a conflict rather than a
 * replacement, and the caller rotates instead.
 */
export function createApiKey() {
  return apiFetch('/api-keys', { method: 'POST' });
}

/**
 * `POST /api-keys/rotate` → 200 `{ apiKey, suffix, maskedKey, createdAt, rotatedAt }`
 *
 * Same one-time disclosure as create. The previous key stops authenticating as
 * a side effect of the same write, so there is never a moment when both work.
 * 409 when the account has no key to replace.
 */
export function rotateApiKey() {
  return apiFetch('/api-keys/rotate', { method: 'POST' });
}

/**
 * The account's current key, for display. Never the secret.
 *
 * There is no `GET /api-keys` in the specification. The plaintext is disclosed
 * exactly once by create/rotate and the stored hash is never returned, so the
 * suffix and dates of a key that already exists cannot be read back yet.
 *
 * Rather than invent a path, this throws the same `EndpointUnavailableError`
 * the Overview screen uses, and the API-key page renders its "not available
 * yet" panel. When `GET /api-keys` is documented, implement it here — it should
 * return `{ suffix, createdAt, rotatedAt? }` — and the page needs no changes.
 */
export async function fetchApiKey() {
  throw new EndpointUnavailableError('API key metadata');
}
