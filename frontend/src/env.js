/**
 * Runtime configuration.
 *
 * VITE_API_URL must point at the Express backend. It defaults to the port
 * documented in backend/.env.example (8000).
 */
export const API_BASE_URL = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/+$/, '');

/**
 * WalletConnect Cloud project id, used by RainbowKit for the WalletConnect
 * connector. Empty when unset: the connector is then left out of the wallet
 * list rather than initialised with a placeholder, which would only produce
 * failed API calls. Injected wallets (MetaMask, Rabby, …) work regardless.
 */
export const WALLETCONNECT_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '';

if (import.meta.env.DEV && !WALLETCONNECT_PROJECT_ID) {
  console.warn(
    '[x402Go] VITE_WALLETCONNECT_PROJECT_ID is not set. Injected wallets ' +
      'will work; WalletConnect-based mobile wallets will not be offered.',
  );
}

/**
 * The backend session cookie is issued with maxAge 3600000 (1 hour) — see
 * App.initSession() in backend/src/app.ts. There is no session-introspection
 * endpoint, so the client mirrors that TTL to expire its own UI state.
 */
export const SESSION_TTL_MS = 60 * 60 * 1000;
