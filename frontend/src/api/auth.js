import { apiFetch } from './client';

/**
 * The three endpoints defined in backend/src/docs/auth.yaml — nothing more.
 * Do not add calls here without a matching entry in that spec.
 */

/** GET /auth/nonce?address= — 200 { nonce } */
export function requestNonce(address) {
  return apiFetch(`/auth/nonce?address=${encodeURIComponent(address)}`);
}

/** POST /auth/verify — { address, message, signature } → 200 { success: true } */
export function verifySignature({ address, message, signature }) {
  return apiFetch('/auth/verify', {
    method: 'POST',
    body: { address, message, signature },
  });
}

/** POST /auth/logout — 200 { success: true } */
export function logout() {
  return apiFetch('/auth/logout', { method: 'POST' });
}
