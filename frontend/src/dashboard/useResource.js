import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, EndpointUnavailableError } from '../api/client';
import { useAuth } from '../auth/AuthContext';

/**
 * Retries are for a failure that might not repeat. A 4xx is the API's settled
 * answer — sending it again cannot change it — and a 401 has already ended the
 * session, so a retry would only be another doomed request behind the sign-in
 * screen. A transport failure (status 0) and a 5xx are worth one more attempt.
 */
function shouldRetry(failureCount, error) {
  if (error instanceof EndpointUnavailableError) return false;
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;

  return failureCount < 1;
}

/**
 * Reads one resource for a dashboard screen and normalises the states the UI
 * has to render.
 *
 * The result is the same `{ status, data, error, reload }` every screen already
 * consumes; what changed is where it comes from. The response is held in the
 * query cache, so leaving a tab and coming back inside the resource's
 * `staleTime` renders from cache — no request, no loading panel — and two
 * screens that name the same resource (the onboarding gate and Settings both
 * read `payout`) share one request instead of issuing one each.
 *
 * `endpoint_unavailable` is deliberately distinct from `error`: a screen whose
 * backend endpoint has not been built yet is not broken, it is simply not
 * built, and it reads very differently to a user than a failed request.
 *
 * A 401 anywhere in the dashboard means the session cookie is gone or expired,
 * so the auth context is told immediately and the user is sent back to sign-in.
 */
export function useResource(resource) {
  const { notifyUnauthorized } = useAuth();

  const load = useCallback(async () => {
    try {
      return await resource.load();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) notifyUnauthorized();
      throw cause;
    }
  }, [resource, notifyUnauthorized]);

  const { data, error, isError, isPending, refetch } = useQuery({
    queryKey: resource.key,
    queryFn: load,
    staleTime: resource.staleTime,
    retry: shouldRetry,
  });

  let status = 'ready';
  if (isPending) status = 'loading';
  // An error only takes the screen when there is nothing else to show: a
  // refetch that fails after a good response — the page was left open past the
  // stale time — leaves that response up rather than replacing a working page
  // with an error panel.
  if (isError && data === undefined) {
    status = error instanceof EndpointUnavailableError ? 'endpoint_unavailable' : 'error';
  }

  // Wrapped so a click's event object is never read as refetch options.
  const reload = useCallback(() => {
    void refetch();
  }, [refetch]);

  return { status, data: data ?? null, error: error ?? null, reload };
}
