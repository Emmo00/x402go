/**
 * Failures the x402 facilitator proxy can produce, and the HTTP status each is.
 *
 * The same shape as `VaultLifecycleError`, for the same reasons: a
 * machine-readable `code` for this backend to branch on and for a test to
 * assert, a human-readable `message` for whoever reads the response, and a
 * `status` that lets the existing error middleware render it without knowing
 * this class exists. `details` and `code` are for logs and tests only — the
 * middleware sends the message and nothing else, so every message below is
 * written to be safe for a payer to read and names no internal address or
 * credential.
 *
 * The statuses are chosen for what a caller should *do*:
 *
 *   400  the request is malformed; retrying it unchanged will fail again
 *   402  the request is well-formed and the payment is too small to accept
 *   403  the request is well-formed and addressed to somewhere it may not go
 *   404  the authenticated merchant has no vault to be paid at
 *   409  two records of the same payment disagree, or a settlement's outcome
 *        is genuinely unknown — a human has to look, and a blind retry is the
 *        one thing that could make it worse
 *   500  this server is misconfigured; the caller cannot fix it
 *   502  the facilitator refused, or answered in a way we cannot use
 *   503  the facilitator could not be reached; retrying may well work
 *   504  the facilitator did not answer in time, so the outcome is unknown
 */
export type FacilitatorErrorCode =
  /** The body is not an object with the fields an x402 request requires. */
  | 'invalid-request'
  /** `x402Version` is absent, not a number, or a version this proxy does not speak. */
  | 'invalid-x402-version'
  /** `scheme` is not the `exact` scheme the Celo facilitator settles. */
  | 'unsupported-scheme'
  /** `network` is not a chain this deployment serves. */
  | 'unsupported-network'
  /** The asset is unknown, not enabled, or not something the facilitator lists. */
  | 'unsupported-asset'
  /** The signed authorization and the payment requirements describe different payments. */
  | 'amount-mismatch'
  /** `payTo` is not the authenticated merchant's vault — another merchant's, or a bare wallet. */
  | 'payto-mismatch'
  /** The payment does not clear the x402Go and facilitator fees. */
  | 'fee-not-met'
  /** No dollar value is configured for this asset, so the fee cannot be computed. */
  | 'fee-schedule-unavailable'
  /** The authenticated merchant has no vault on the requested network. */
  | 'vault-unavailable'
  /** The facilitator could not be reached at all. */
  | 'facilitator-unreachable'
  /** The facilitator answered, but not with something this proxy can use. */
  | 'facilitator-rejected'
  /** The facilitator did not answer within the configured timeout. */
  | 'facilitator-timeout'
  /** This server has no Celo facilitator API key, so it cannot call one. */
  | 'facilitator-key-unusable'
  /** Celo reported the payment invalid; the payment itself is the problem. */
  | 'payment-invalid'
  /** Celo reported settlement failed; nothing moved and nothing was credited. */
  | 'settlement-failed'
  /** Settlement was attempted and its outcome is unknown; do not retry blindly. */
  | 'settlement-ambiguous'
  /** A settlement is already recorded for this payment and could not be reused. */
  | 'settlement-conflict';

const STATUS: Readonly<Record<FacilitatorErrorCode, number>> = {
  'invalid-request': 400,
  'invalid-x402-version': 400,
  'unsupported-scheme': 400,
  'unsupported-network': 400,
  'unsupported-asset': 400,
  'amount-mismatch': 400,
  'payto-mismatch': 403,
  'fee-not-met': 402,
  'fee-schedule-unavailable': 500,
  'vault-unavailable': 404,
  'facilitator-unreachable': 503,
  'facilitator-rejected': 502,
  'facilitator-timeout': 504,
  'facilitator-key-unusable': 500,
  'payment-invalid': 400,
  'settlement-failed': 502,
  'settlement-ambiguous': 409,
  'settlement-conflict': 409,
};

/** Messages for the cases where the text carries no specifics. */
const DEFAULT_MESSAGE: Readonly<Record<FacilitatorErrorCode, string>> = {
  'invalid-request': 'The request is not a valid x402 payment request.',
  'invalid-x402-version': 'That x402 version is not supported.',
  'unsupported-scheme': 'That payment scheme is not supported.',
  'unsupported-network': 'That network is not supported.',
  'unsupported-asset': 'That asset is not supported for settlement.',
  'amount-mismatch':
    'The signed payment does not match the payment requirements it was sent with.',
  'payto-mismatch': 'The payment is not addressed to this merchant’s vault.',
  'fee-not-met':
    'The payment does not cover the x402Go and network fees, so it cannot be settled.',
  'fee-schedule-unavailable':
    'This server cannot price a fee in that asset, so it cannot settle it.',
  'vault-unavailable': 'No vault is available for this account on that network.',
  'facilitator-unreachable':
    'The payment facilitator could not be reached. Try again in a moment.',
  'facilitator-rejected':
    'The payment facilitator returned an unexpected response.',
  'facilitator-timeout':
    'The payment facilitator did not respond in time, so the outcome is unknown.',
  'facilitator-key-unusable':
    'This server is not configured to reach the payment facilitator.',
  'payment-invalid': 'The payment was rejected as invalid.',
  'settlement-failed': 'The payment could not be settled.',
  'settlement-ambiguous':
    'The settlement was submitted but its outcome is unknown. It has not been ' +
    'retried; check again before trying it a second time.',
  'settlement-conflict':
    'A settlement for this payment is already recorded and could not be reused.',
};

export interface FacilitatorErrorOptions {
  /** Overrides the default message for the code. Must be safe to show a payer. */
  readonly message?: string;
  /** Extra context for the log. Never sent to a client. */
  readonly details?: Record<string, unknown>;
  /** The underlying failure, kept for the stack trace. */
  readonly cause?: unknown;
}

export class FacilitatorError extends Error {
  public readonly status: number;
  public readonly code: FacilitatorErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;
  /** Declared here rather than relying on `Error.cause`, which this project's
   * `es2017` target does not type. */
  public readonly cause: unknown;

  constructor(code: FacilitatorErrorCode, options: FacilitatorErrorOptions = {}) {
    super(options.message ?? DEFAULT_MESSAGE[code]);

    this.name = 'FacilitatorError';
    this.code = code;
    this.status = STATUS[code];
    this.details = options.details ?? {};
    this.cause = options.cause;
  }
}

/** Narrows an unknown to this error, for a caller deciding how to report it. */
export function isFacilitatorError(value: unknown): value is FacilitatorError {
  return (
    value instanceof FacilitatorError ||
    (typeof value === 'object' &&
      value !== null &&
      (value as { name?: unknown }).name === 'FacilitatorError' &&
      typeof (value as { code?: unknown }).code === 'string')
  );
}

export default FacilitatorError;
