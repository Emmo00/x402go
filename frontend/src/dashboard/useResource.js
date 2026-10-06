import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, EndpointUnavailableError } from '../api/client';
import { useAuth } from '../auth/AuthContext';

/**
 * Runs one async loader for a dashboard screen and normalises the states the UI
 * has to render.
 *
 * `endpoint_unavailable` is deliberately distinct from `error`: a screen whose
 * backend endpoint has not been built yet is not broken, it is simply not
 * built, and it reads very differently to a user than a failed request.
 *
 * A 401 anywhere in the dashboard means the session cookie is gone or expired,
 * so the auth context is told immediately and the user is sent back to sign-in.
 */
export function useResource(load) {
  const { notifyUnauthorized } = useAuth();
  const [state, setState] = useState({ status: 'loading', data: null, error: null });

  // Held in a ref so an inline arrow loader does not restart the request on
  // every render.
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback(async () => {
    setState({ status: 'loading', data: null, error: null });

    try {
      const data = await loadRef.current();
      setState({ status: 'ready', data, error: null });
    } catch (cause) {
      if (cause instanceof EndpointUnavailableError) {
        setState({ status: 'endpoint_unavailable', data: null, error: cause });
        return;
      }
      if (cause instanceof ApiError && cause.status === 401) {
        notifyUnauthorized();
      }
      setState({ status: 'error', data: null, error: cause });
    }
  }, [notifyUnauthorized]);

  useEffect(() => {
    run();
  }, [run]);

  return { ...state, reload: run };
}
