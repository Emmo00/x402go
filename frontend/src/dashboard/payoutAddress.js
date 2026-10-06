import { getAddress, isAddress } from 'viem';

/**
 * The payout wallet address, shared by onboarding and Settings.
 *
 * `strict: false` accepts any casing, so an all-lowercase address — the form
 * programmatic callers send — is not rejected. The second check then catches a
 * mixed-case address whose EIP-55 checksum does not match, which is almost
 * always a copy/paste slip and exactly the mistake that would send settled
 * payments somewhere unrecoverable.
 *
 * The backend checks the shape and lowercases on write, so a valid address is
 * accepted whichever case this returns.
 */
export function validatePayoutAddress(input) {
  const value = typeof input === 'string' ? input.trim() : '';

  if (!value) return 'Enter the address that should receive your payments.';
  if (!isAddress(value, { strict: false })) return 'That is not a valid Celo address.';
  if (!isAddress(value)) {
    return 'This address failed its checksum. Copy it again from your wallet.';
  }
  return null;
}

/** The EIP-55 checksummed form. Only call once validation has passed. */
export function checksumPayoutAddress(input) {
  return getAddress(input.trim());
}
