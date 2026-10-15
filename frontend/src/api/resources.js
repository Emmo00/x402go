import { fetchAccount, fetchOverview, fetchPayoutAddress } from './dashboard';

/**
 * The dashboard's cached reads, described once each.
 *
 * A screen names a resource rather than a loader, so screens that show the same
 * thing share one cache entry — and, while a request is in flight, one request.
 * `staleTime` is the age at which an entry stops being trusted: inside it a
 * screen renders from cache with no request at all, which is what makes a tab
 * switch instant.
 */

/**
 * Every query this app owns sits under this prefix, so the cache can be dropped
 * in one call when a session ends without touching the entries wagmi keeps in
 * the same client.
 */
export const CACHE_SCOPE = ['x402go'];

export const RESOURCES = {
  // Changes only when the merchant acts — issuing or rotating a key — and those
  // actions invalidate it, so a long stale time costs nothing.
  account: {
    key: [...CACHE_SCOPE, 'account'],
    load: fetchAccount,
    staleTime: 5 * 60_000,
  },
  // Onboarding writes this one, so it is trusted for far less time.
  payout: {
    key: [...CACHE_SCOPE, 'payout'],
    load: fetchPayoutAddress,
    staleTime: 30_000,
  },
  // Nothing serves this yet — the loader throws `EndpointUnavailableError` — but
  // it is named here so the screen it feeds has the same shape as the others,
  // and caches the moment the endpoint exists.
  overview: {
    key: [...CACHE_SCOPE, 'overview'],
    load: fetchOverview,
    staleTime: 30_000,
  },
};
