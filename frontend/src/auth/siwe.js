import { createSiweMessage } from 'viem/siwe';

/**
 * Shown to the user in their wallet while signing. The backend does not
 * validate the statement, but the prompt should say what is being authorised.
 */
const STATEMENT = 'Sign in to x402Go.';

/**
 * Builds the EIP-4361 message that POST /auth/verify expects in `message`.
 *
 * Uses viem's SIWE implementation, which is already part of the stack through
 * wagmi — the standalone `siwe` package would additionally require ethers.
 *
 * The backend runs `new SiweMessage(message).verify({ signature, nonce })`
 * with no `domain` argument, so the domain is not cross-checked server-side;
 * it is still set to the real host so the user sees an honest prompt. The nonce
 * must be the one just issued by GET /auth/nonce.
 */
export function buildSiweMessage({ address, chainId, nonce }) {
  return createSiweMessage({
    address,
    chainId,
    domain: window.location.host,
    nonce,
    uri: window.location.origin,
    version: '1',
    statement: STATEMENT,
  });
}
