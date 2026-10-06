/**
 * Validation for the payout address an account settles to.
 *
 * Only the shape is checked. The EIP-55 checksum is deliberately *not*
 * enforced: an API client is entitled to send an all-lowercase address, and a
 * checksum only carries meaning when the sender mixed case on purpose. The
 * dashboard checks the checksum client-side, where a human is typing the
 * address and a typo is the thing worth catching; rejecting lowercase here
 * would break every legitimate programmatic caller to catch a case that
 * cannot occur on the wire (an address is 20 bytes either way).
 */

/** `0x` followed by exactly 40 hex digits — one 20-byte EVM address. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The zero address is not a payable destination: transfers to it are burned,
 * and `X402Vault.changePayout` rejects it outright with `InvalidAddress`. It is
 * refused here so an account cannot store a payout address that would silently
 * swallow every settlement.
 */
const ZERO_ADDRESS = /^0x0{40}$/i;

export function isValidPayToAddress(value: unknown): value is string {
  return typeof value === 'string' && EVM_ADDRESS.test(value) && !ZERO_ADDRESS.test(value);
}
