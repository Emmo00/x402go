import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useAccount, useDisconnect, useSignMessage } from 'wagmi';
import { logout as logoutRequest, requestNonce, verifySignature } from '../api/auth';
import { ApiError } from '../api/client';
import { SESSION_TTL_MS } from '../env';
import { buildSiweMessage } from './siwe';

/**
 * Authentication state machine.
 *
 * The backend keeps the authoritative session in an httpOnly cookie; this
 * context only tracks what the UI needs to render. Nothing sensitive is stored
 * client-side — the persisted record holds the public wallet address and the
 * time the session was established, nothing else.
 *
 * There is no session-introspection endpoint in backend/src/docs/auth.yaml, so
 * on reload the client restores optimistically from that record and the TTL is
 * mirrored from the cookie's maxAge. Any 401 from a real API call clears it via
 * `notifyUnauthorized`.
 */
export const AuthStatus = {
  DISCONNECTED: 'disconnected',
  UNAUTHENTICATED: 'unauthenticated',
  AWAITING_SIGNATURE: 'awaiting_signature',
  VERIFYING: 'verifying',
  AUTHENTICATED: 'authenticated',
  EXPIRED: 'expired',
};

const STORAGE_KEY = 'x402go.session';

const AuthContext = createContext(null);

function readStoredSession() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed.address !== 'string' ||
      typeof parsed.authenticatedAt !== 'number'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredSession(session) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* storage unavailable (private mode) — session stays in memory only */
  }
}

function clearStoredSession() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function isExpired(session) {
  return Boolean(session) && Date.now() >= session.authenticatedAt + SESSION_TTL_MS;
}

/** wagmi surfaces a rejected signature as a user-rejection error. */
function isUserRejection(cause) {
  if (!cause) return false;
  const code = cause.code ?? cause.cause?.code;
  if (code === 4001) return true;
  const name = cause.name ?? cause.cause?.name ?? '';
  if (/UserRejected/i.test(name)) return true;
  return /user rejected|user denied|rejected the request/i.test(cause.message || '');
}

function toAuthError(cause) {
  if (cause instanceof ApiError) {
    return { message: cause.message, code: cause.code };
  }
  if (isUserRejection(cause)) {
    return {
      message: 'Signature request rejected in your wallet.',
      code: 'signature_rejected',
    };
  }
  return {
    message: cause?.shortMessage || cause?.message || 'Sign-in failed.',
    code: 'unexpected',
  };
}

export function AuthProvider({ children }) {
  const { address, chainId, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { disconnect } = useDisconnect();

  const [session, setSession] = useState(readStoredSession);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const [expired, setExpired] = useState(false);
  // Ticks when the session lapses so the derived status below re-evaluates.
  const [, setClock] = useState(0);

  const clearSession = useCallback(() => {
    clearStoredSession();
    setSession(null);
  }, []);

  /** Call from any API error handler that received a 401. */
  const notifyUnauthorized = useCallback(() => {
    clearSession();
    setExpired(false);
    setPending(null);
  }, [clearSession]);

  // Drop a restored session that has passed the cookie's maxAge.
  useEffect(() => {
    if (!session) return undefined;

    const remaining = session.authenticatedAt + SESSION_TTL_MS - Date.now();
    if (remaining <= 0) {
      clearSession();
      setExpired(true);
      return undefined;
    }

    const timer = setTimeout(() => {
      clearSession();
      setExpired(true);
      setClock((value) => value + 1);
    }, remaining);

    return () => clearTimeout(timer);
  }, [session, clearSession]);

  // A different wallet than the one that signed in invalidates the session.
  useEffect(() => {
    if (isConnected && session && address && session.address !== address) {
      clearSession();
      setExpired(false);
    }
  }, [address, isConnected, session, clearSession]);

  const signIn = useCallback(async () => {
    if (!address || !chainId) return;

    setError(null);
    setExpired(false);

    try {
      // 1. GET /auth/nonce
      const nonceResponse = await requestNonce(address);
      const nonce = nonceResponse?.nonce;
      if (!nonce) {
        throw new ApiError('The API did not return a nonce.', { code: 'no_nonce' });
      }

      // 2. Sign the EIP-4361 message built from that nonce.
      const message = buildSiweMessage({ address, chainId, nonce });

      setPending(AuthStatus.AWAITING_SIGNATURE);
      const signature = await signMessageAsync({ message });

      // 3. POST /auth/verify — sets the httpOnly session cookie.
      setPending(AuthStatus.VERIFYING);
      await verifySignature({ address, message, signature });

      const next = { address, authenticatedAt: Date.now() };
      writeStoredSession(next);
      setSession(next);
    } catch (cause) {
      setError(toAuthError(cause));
    } finally {
      setPending(null);
    }
  }, [address, chainId, signMessageAsync]);

  const signOut = useCallback(async () => {
    setError(null);
    try {
      await logoutRequest();
    } catch {
      // The cookie may already be gone; clearing local state is what matters.
    }
    clearSession();
    setExpired(false);
    disconnect();
  }, [clearSession, disconnect]);

  const value = useMemo(() => {
    let status;

    if (!isConnected) {
      status = AuthStatus.DISCONNECTED;
    } else if (pending) {
      status = pending;
    } else if (session && session.address === address && !isExpired(session)) {
      status = AuthStatus.AUTHENTICATED;
    } else if (expired) {
      status = AuthStatus.EXPIRED;
    } else {
      status = AuthStatus.UNAUTHENTICATED;
    }

    return {
      status,
      error,
      isAuthenticated: status === AuthStatus.AUTHENTICATED,
      isBusy:
        status === AuthStatus.AWAITING_SIGNATURE || status === AuthStatus.VERIFYING,
      address,
      chainId,
      signIn,
      signOut,
      dismissError: () => setError(null),
      notifyUnauthorized,
      sessionAddress: session?.address ?? null,
      authenticatedAt: session?.authenticatedAt ?? null,
    };
  }, [
    address,
    chainId,
    error,
    expired,
    isConnected,
    notifyUnauthorized,
    pending,
    session,
    signIn,
    signOut,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside an <AuthProvider>.');
  }
  return context;
}
