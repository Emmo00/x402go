import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * API-key generation and verification.
 *
 * ## Key format
 *
 * `x402go_` followed by 32 bytes from the CSPRNG, base64url-encoded. The
 * prefix is a public, non-secret marker that makes a leaked key recognisable in
 * scanners and secret-detection tooling — it carries no entropy and is never
 * treated as one. All 256 bits of entropy come from `randomBytes`, so the key
 * is not derived from anything an attacker could predict or replay: not the
 * wallet address, not a timestamp, not a UUID, and not `Math.random()`.
 *
 * ## Hash choice
 *
 * Keys are hashed with **HMAC-SHA-256 under a server-side pepper**, and
 * compared with `timingSafeEqual`.
 *
 * A slow password KDF (bcrypt, scrypt, argon2) is the right answer for
 * human-chosen passwords, because its cost is what makes guessing a
 * low-entropy secret expensive. An API key is the opposite case: 256 bits of
 * CSPRNG output cannot be brute-forced at any KDF cost, so the slowness buys
 * nothing while making every authenticated request pay for it. What a fast
 * unkeyed digest would lose is protection against an attacker who reads the
 * database — they could confirm a guessed key offline. Keying the digest with a
 * pepper that lives in the environment and never in the database removes that:
 * a dump of the `users` collection alone is not enough to verify a single
 * candidate key.
 *
 * This needs no new dependency — `crypto` is in the runtime — and no salt
 * column, since the key is unique per account and never reused.
 */

/** Public, non-secret marker. Recognisable, and never used as entropy. */
export const API_KEY_PREFIX = 'x402go_';

/**
 * Number of characters of the plaintext kept in the clear, so a key can be
 * identified in the UI (`••••••••••••a91f`) without storing anything that
 * could be used to authenticate.
 */
export const API_KEY_SUFFIX_LENGTH = 4;

const API_KEY_ENTROPY_BYTES = 32;
const API_KEY_HASH_ALGORITHM = 'sha256';

/**
 * Fixed width of the mask. A fixed width rather than one bullet per hidden
 * character, so the display form does not disclose the length of the key.
 */
const MASK_WIDTH = 12;

/** 256 bits of `randomBytes` is 43 base64url characters. 7 + 43 = 50. */
const API_KEY_LENGTH = API_KEY_PREFIX.length + 43;

/**
 * The pepper is deliberately separate from `SESSION_SECRET`. Sharing one secret
 * across two purposes means rotating either one silently invalidates the other.
 * The fallback keeps existing deployments booting, but it is a fallback, not
 * the intended configuration.
 */
function pepper(): string {
  const dedicated = process.env.API_KEY_PEPPER;

  if (dedicated) {
    return dedicated;
  }

  const fallback = process.env.SESSION_SECRET;

  if (!fallback) {
    // Failing loudly here is the safe direction: issuing keys under a
    // well-known default pepper would make every stored hash verifiable by
    // anyone who reads this source file.
    throw new Error(
      'API_KEY_PEPPER is not configured and no SESSION_SECRET is available to fall back to',
    );
  }

  return fallback;
}

/** Issues a fresh plaintext API key. The only place a key comes into existence. */
export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(API_KEY_ENTROPY_BYTES).toString('base64url');
}

/**
 * The non-secret tail of a key, stored alongside the hash so the key can be
 * shown in the UI and looked up without exposing anything usable.
 */
export function apiKeySuffix(apiKey: string): string {
  return apiKey.slice(-API_KEY_SUFFIX_LENGTH);
}

/** Renders the storage form of a key for display: `••••••••••••a91f`. */
export function maskApiKey(apiKey: string): string {
  return '•'.repeat(MASK_WIDTH) + apiKeySuffix(apiKey);
}

/**
 * HMAC-SHA-256 of the key under the server pepper, hex-encoded.
 *
 * The result is what gets persisted. It is deterministic — which is what lets
 * verification be a single comparison rather than a search — but it is only
 * reproducible by something that also holds the pepper.
 */
export function hashApiKey(apiKey: string): string {
  return createHmac(API_KEY_HASH_ALGORITHM, pepper()).update(apiKey, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of a presented key against a stored hash.
 *
 * The plaintext is never compared to anything, and the comparison never
 * short-circuits on the first differing byte, so the time taken does not reveal
 * how much of a guess was correct.
 */
export function verifyApiKey(apiKey: string, storedHash: string): boolean {
  if (typeof storedHash !== 'string' || storedHash.length === 0) {
    return false;
  }

  const expected = Buffer.from(storedHash, 'hex');
  const candidate = Buffer.from(hashApiKey(apiKey), 'hex');

  // `timingSafeEqual` throws on a length mismatch, so the lengths are checked
  // first. A stored hash of the wrong length is a corrupted record, not a match.
  if (expected.length !== candidate.length) {
    return false;
  }

  return timingSafeEqual(expected, candidate);
}

/**
 * Cheap structural check applied before any database work.
 *
 * Rejecting malformed input here keeps arbitrary strings from being turned into
 * a suffix lookup, and keeps obviously-not-a-key values from reaching the
 * hashing path at all.
 */
export function isWellFormedApiKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === API_KEY_LENGTH &&
    value.startsWith(API_KEY_PREFIX) &&
    /^[A-Za-z0-9_-]+$/.test(value.slice(API_KEY_PREFIX.length))
  );
}
