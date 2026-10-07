/**
 * Failures the vault lifecycle can produce, and the HTTP status each one is.
 *
 * These carry a machine-readable `code` alongside a message. The code is for
 * this backend — it is what a caller branches on, and what a test asserts —
 * while the message is written for whoever reads the response. Keeping both on
 * one object is what stops the two from drifting: a caller that only had a
 * message to match on would end up string-matching the wording.
 *
 * The shape deliberately mirrors `HttpException` (`status` plus `message`), so
 * the existing error middleware renders these without a special case. The
 * middleware prints the message of anything carrying a status, which is why
 * every message below is safe to show a merchant: none of them names an
 * internal address, key or stack.
 */

export type VaultLifecycleErrorCode =
  /** The merchant address given is not a 20-byte address. */
  | 'invalid-merchant'
  /** The payout address given, or stored, is not a usable address. */
  | 'invalid-payout'
  /** The chain key is not one this deployment knows, or has no contracts. */
  | 'chain-config'
  /** The factory could not be read — the node is unreachable or erroring. */
  | 'factory-unreachable'
  /** A chain read outside the factory failed, so the answer is unknown. */
  | 'chain-unreachable'
  /** No account is on record for this merchant. */
  | 'no-account'
  /** This server has no usable operator key, so it cannot sign anything. */
  | 'operator-key-unusable'
  /** The address on record is not the address the factory derives. */
  | 'vault-address-mismatch'
  /** The operator key this server holds is not the factory's operator. */
  | 'operator-mismatch'
  /** The vault at that address belongs to a different merchant. */
  | 'merchant-mismatch'
  /** The vault's on-chain payout is not the payout this operation requires. */
  | 'payout-mismatch'
  /** The deployment transaction reverted. */
  | 'deployment-reverted'
  /** The transaction was mined but no contract exists at the address. */
  | 'deployment-not-confirmed'
  /** Another writer holds the deployment lock and did not finish in time. */
  | 'lock-timeout'
  /** Every retry was spent on a nonce that had already been consumed. */
  | 'nonce-retries-exhausted'
  /** A transaction with this nonce is already in flight; retrying is unsafe. */
  | 'transaction-ambiguous'
  /** The transaction was submitted but is not confirmed within the wait. */
  | 'transaction-pending';

/**
 * The HTTP status each failure is reported as.
 *
 * A missing or malformed input is the caller's to fix (400). A disagreement
 * between two records of the same fact is a conflict (409) — it needs a human
 * to reconcile, and retrying the same request will produce it again. A chain or
 * database problem is this server's (503), and retrying may well work.
 */
const STATUS: Readonly<Record<VaultLifecycleErrorCode, number>> = {
  'invalid-merchant': 400,
  'invalid-payout': 400,
  'chain-config': 500,
  'factory-unreachable': 503,
  'chain-unreachable': 503,
  'no-account': 404,
  'operator-key-unusable': 500,
  'vault-address-mismatch': 409,
  'operator-mismatch': 500,
  'merchant-mismatch': 409,
  'payout-mismatch': 409,
  'deployment-reverted': 502,
  'deployment-not-confirmed': 502,
  'lock-timeout': 503,
  'nonce-retries-exhausted': 503,
  'transaction-ambiguous': 409,
  'transaction-pending': 409,
};

/** Messages for the cases where the text carries no specifics. */
const DEFAULT_MESSAGE: Readonly<Record<VaultLifecycleErrorCode, string>> = {
  'invalid-merchant': 'The merchant address is not a valid address.',
  'invalid-payout': 'The payout address is not a valid address.',
  'chain-config': 'This network is not configured for vaults.',
  'factory-unreachable':
    'The vault factory could not be reached. Try again in a moment.',
  'chain-unreachable':
    'The network could not be reached, so the vault state is unknown. ' +
    'Try again in a moment.',
  'no-account': 'Account not found.',
  'operator-key-unusable':
    'This server is not configured to sign vault transactions.',
  'vault-address-mismatch':
    'The stored vault address does not match the one the factory derives, so ' +
    'the vault cannot be used until that is reconciled.',
  'operator-mismatch':
    'This server is not authorised to deploy vaults on that network.',
  'merchant-mismatch':
    'The vault at the predicted address belongs to a different account.',
  'payout-mismatch':
    'The vault payout address does not match the account’s payout address, ' +
    'so nothing will be withdrawn until that is reconciled.',
  'deployment-reverted': 'The vault deployment was rejected by the network.',
  'deployment-not-confirmed':
    'The vault deployment was submitted but the vault is not there yet.',
  'lock-timeout':
    'Another vault operation for this account is still running. Try again in a moment.',
  'nonce-retries-exhausted':
    'The vault operation could not be submitted because of a transaction ' +
    'ordering problem. Try again in a moment.',
  'transaction-ambiguous':
    'A transaction for this account is already in flight. It has not been ' +
    'resubmitted; check again before retrying.',
  'transaction-pending':
    'The transaction was submitted but has not been confirmed yet.',
};

export interface VaultLifecycleErrorOptions {
  /** Overrides the default message for the code. Must be safe to show a user. */
  readonly message?: string;
  /** Extra context for the log. Never sent to a client. */
  readonly details?: Record<string, unknown>;
  /** The underlying failure, kept for the stack trace. */
  readonly cause?: unknown;
}

export class VaultLifecycleError extends Error {
  public readonly status: number;
  public readonly code: VaultLifecycleErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;
  /** Declared here rather than relying on `Error.cause`, which this project's
   * `es2017` target does not type. */
  public readonly cause: unknown;

  constructor(code: VaultLifecycleErrorCode, options: VaultLifecycleErrorOptions = {}) {
    super(options.message ?? DEFAULT_MESSAGE[code]);

    this.name = 'VaultLifecycleError';
    this.code = code;
    this.status = STATUS[code];
    this.details = options.details ?? {};
    this.cause = options.cause;
  }
}

/** Narrows an unknown to this error, for a caller deciding how to report it. */
export function isVaultLifecycleError(value: unknown): value is VaultLifecycleError {
  return (
    value instanceof VaultLifecycleError ||
    (typeof value === 'object' &&
      value !== null &&
      (value as { name?: unknown }).name === 'VaultLifecycleError' &&
      typeof (value as { code?: unknown }).code === 'string')
  );
}

export default VaultLifecycleError;
