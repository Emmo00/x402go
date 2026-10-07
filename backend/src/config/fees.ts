import type { ChainKey } from './chains';
import { findSettleableToken, type TokenConfig } from './tokens';

/**
 * What x402Go charges, and how that becomes an amount in a token.
 *
 * The fee is a *price*, and it is quoted in dollars. A payment, however, is an
 * integer count of a token's smallest unit, and there is no way to compare the
 * two without knowing what one whole token is worth. So this file holds both
 * halves of that conversion and does it entirely in integers:
 *
 *   micro-USD  the fee, as an integer number of 10^-6 dollars, because a
 *              dollar amount has no exact binary floating-point representation
 *              and `0.001 + 0.001` is not reliably `0.002`
 *   nano-USD   what one whole token is worth, as an integer number of 10^-9
 *              dollars
 *
 * Everything downstream — the fee guard, the accounting split, the numbers
 * stored on a settlement — is `bigint`. No amount in this system is ever a
 * `number`, and `parseFloat` does not appear in this file or any file it feeds.
 * See the note on `decimals` in `./tokens`.
 *
 * ## Why a token can have no fee schedule
 *
 * Three of the six enabled mainnet assets are local-currency tokens — the
 * Argentine peso, the Brazilian real, the Colombian peso — and x402Go has no
 * exchange rate for any of them. It would be easy to assume they are worth a
 * dollar, and that assumption is wrong by a factor of roughly a thousand. It
 * would be equally easy to fetch a rate, and that would make the fee guard's
 * answer depend on a live third party: a stale or unavailable quote would
 * silently change what counts as an acceptable payment.
 *
 * So `feesFor` returns `null` for an asset whose dollar value is not stated
 * here, and every caller treats that as a refusal rather than a zero. A fee
 * guard that cannot be computed is not a fee guard that passes. Adding one of
 * those assets to live traffic means adding a rate to `TOKEN_NANO_USD` below,
 * which is a deliberate edit with a date attached rather than a runtime lookup.
 */

/** x402Go's own fee: $0.001, expressed as 1000 millionths of a dollar. */
export const X402GO_FEE_MICRO_USD: bigint = BigInt(1000);

/** The Celo facilitator's fee: $0.001. Charged to us, passed through to the payer. */
export const FACILITATOR_FEE_MICRO_USD: bigint = BigInt(1000);

/**
 * What a payment must exceed to be worth settling: $0.002.
 *
 * Summed here rather than written as `2000` so the two components cannot drift
 * apart from their total. At or below this the merchant would receive nothing
 * and x402Go would pay two fees out of a payment that does not cover them.
 */
export const TOTAL_FEE_MICRO_USD: bigint =
  X402GO_FEE_MICRO_USD + FACILITATOR_FEE_MICRO_USD;

/** One dollar, in nano-USD. The unit `TOKEN_NANO_USD` is expressed in. */
const ONE_DOLLAR = BigInt(1_000_000_000);

/**
 * What one whole token is worth, in nano-USD, keyed by `chain:address`.
 *
 * The dollar stablecoins are recorded at exactly one dollar. They are the
 * assets whose whole purpose is to be worth a dollar, and the ones x402Go
 * launches with, so stating it here is not a guess — it is the definition of
 * the asset. Anything else must be added deliberately, and this comment is the
 * place to record where its rate came from and when.
 *
 * Keyed by chain as well as address because USDC is a different contract on
 * each network; an address alone is not an identifier in this codebase.
 */
const TOKEN_NANO_USD: Readonly<Record<string, bigint>> = {
  // Celo Mainnet
  'celo:0xceba9300f2b948710d2653dd7b07f33a8b32118c': ONE_DOLLAR, // USDC
  'celo:0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e': ONE_DOLLAR, // USDT
  'celo:0xd2ab3c9a02dbbab236bfec45d1d755df4267f771': ONE_DOLLAR, // USAT
  // Celo Sepolia
  'celoSepolia:0x01c5c0122039549ad1493b8220cabedd739bc44e': ONE_DOLLAR, // USDC

  // Deliberately absent, and therefore unsettleable until a rate is added:
  //   wARS, wBRL, wCOP — 18-decimal local-currency tokens on Celo Mainnet.
};

/** How a `chain:address` key is built. Lowercased: casing is a checksum, not a value. */
function rateKey(chain: ChainKey, address: string): string {
  return `${chain}:${address.toLowerCase()}`;
}

/** Divides, rounding up. Used for fees so a conversion can never under-charge. */
function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - BigInt(1)) / denominator;
}

/**
 * The fee for one asset, in that asset's own atomic units.
 *
 * All three figures are the same money at three levels of detail: `totalFee` is
 * what the payer must clear, and the two components are what gets recorded on
 * the settlement and reconciled against the facilitator's own charge.
 */
export interface FeeSchedule {
  readonly x402GoFee: bigint;
  readonly facilitatorFee: bigint;
  readonly totalFee: bigint;
}

/**
 * Converts a micro-USD fee into atomic units of `token`.
 *
 *   atomic = fee_usd / price_per_token * 10^decimals
 *          = microUsd * 10^(decimals + 3) / nanoUsd
 *
 * For USDC — 6 decimals, one dollar — that is `1000 * 10^9 / 10^9`, or 1000,
 * which is the $0.001 the fee is meant to be. Rounded up rather than down:
 * flooring would accept a payment a single unit short of covering the fee, and
 * the whole point of the guard is that it never does that.
 */
function toAtomic(feeMicroUsd: bigint, token: TokenConfig, nanoUsd: bigint): bigint {
  const scale = BigInt(10) ** BigInt(token.decimals + 3);

  return ceilDiv(feeMicroUsd * scale, nanoUsd);
}

/**
 * The fee schedule for an asset, or `null` when one cannot be computed.
 *
 * `null` is a refusal, not a zero fee: a caller must not read it as "this
 * payment clears the guard". The two reasons it happens are both configuration
 * faults — the asset has no stated dollar value, or it has too few decimal
 * places to express the fee at all (a 0-decimal token cannot represent
 * $0.001, and a schedule that rounded to zero would let a one-unit payment
 * through).
 */
export function feesFor(token: TokenConfig): FeeSchedule | null {
  const nanoUsd = TOKEN_NANO_USD[rateKey(token.chain, token.address)];

  if (!nanoUsd || nanoUsd <= BigInt(0)) return null;

  const x402GoFee = toAtomic(X402GO_FEE_MICRO_USD, token, nanoUsd);
  const facilitatorFee = toAtomic(FACILITATOR_FEE_MICRO_USD, token, nanoUsd);
  const totalFee = x402GoFee + facilitatorFee;

  // A fee that rounds to nothing is not a fee. Reached by a token with fewer
  // decimals than the fee needs; refusing is the only safe reading.
  if (x402GoFee <= BigInt(0) || facilitatorFee <= BigInt(0)) return null;

  return { x402GoFee, facilitatorFee, totalFee };
}

/** Whether this asset has a stated dollar value, for a caller that wants to ask first. */
export function hasFeeSchedule(token: TokenConfig): boolean {
  return feesFor(token) !== null;
}

/**
 * The fee schedule for an asset named by chain and address, for a caller that
 * has not resolved the token yet. Returns `null` for an unknown address too,
 * which folds "this asset cannot be settled" and "this asset has no fee
 * schedule" into the one answer a caller has to handle.
 */
export function feesForAddress(chain: ChainKey, address: string): FeeSchedule | null {
  const token = findSettleableToken(chain, address);

  return token ? feesFor(token) : null;
}
