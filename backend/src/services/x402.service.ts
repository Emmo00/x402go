import { createHash } from 'node:crypto';
import { getAddress, isAddress } from 'viem';

import { chainById, chainByKey, feesFor, findSettleableToken, type ChainKey, type FeeSchedule, type TokenConfig } from '../config';
import { FacilitatorError } from '../exceptions/FacilitatorError';
import AccountService from './account.service';

/**
 * Turns an x402 request into a payment x402Go is willing to verify or settle.
 *
 * This is the gate every payment passes through before x402Go spends a
 * facilitator call on it, and it is where the two questions that matter are
 * answered: *is this addressed to the merchant who is asking*, and *is it big
 * enough to be worth settling*. Nothing here touches the network — the vault
 * address is derived locally from the authenticated merchant, and the fee is
 * arithmetic — so a payment that is going to be refused is refused without
 * costing anything.
 *
 * ## The shape it insists on
 *
 * x402 **version 2** only. The v2 envelope is the one the Celo facilitator
 * advertises as its primary kind and the one this proxy's own contract is
 * written against: `paymentRequirements` carries `amount` (v1's is
 * `maxAmountRequired`, nested differently), and the signed payload carries an
 * `accepted` echo of the requirements. A v1 request is refused with
 * `invalid-x402-version` rather than guessed at, because reading v1 fields as
 * v2 ones would silently mis-price a payment.
 *
 * ## Why both halves are checked
 *
 * A v2 payment arrives as two objects that are *supposed* to agree: the
 * `paymentRequirements` the merchant advertised, and the `paymentPayload` the
 * payer signed. Only the signed half moves money, but only the advertised half
 * is what the merchant asked for.
 *
 * Checking one and trusting the other is exploitable in both directions. Trust
 * the requirements and a payer could sign a payment to their own address while
 * the requirements claim the merchant's vault. Trust the payload and a payer
 * could satisfy a one-cent charge while the requirements advertise a dollar.
 *
 * So this module requires them to agree, on the two fields that decide where
 * the money goes and how much of it: **the recipient must be the merchant's
 * vault in both, and the amount must be identical in both**. The fee guard then
 * runs against the signed value, which is the number that will actually move.
 *
 * ## The fee guard is integer arithmetic
 *
 * `amount` is a string of atomic units and is compared as a `bigint` against a
 * `bigint` fee. There is no `parseFloat` on this path, and no `number` holding
 * a token amount at any point — an 18-decimal token overflows a double's exact
 * integer range, so a float comparison here would silently accept payments
 * below the fee. See `config/fees.ts` for why a token with no stated dollar
 * value has no fee schedule, and why that is a refusal rather than a zero.
 */

/** The x402 version this proxy speaks. */
export const SUPPORTED_X402_VERSION = 2;

/** The only scheme the Celo facilitator settles. */
export const SUPPORTED_SCHEME = 'exact';

/**
 * A validated payment, with its accounting already computed.
 *
 * Everything downstream reads this and nothing re-derives it: the amounts here
 * are what get persisted and what the merchant is credited, so they are decided
 * once, in one place, from the signed payment.
 */
export interface AuthorizedPayment {
  readonly merchantId: string;
  readonly merchantAddress: string;
  readonly chain: ChainKey;
  readonly chainId: number;
  /** The network string as the request gave it, kept for the record. */
  readonly network: string;

  /** The merchant's deterministic vault — resolved from the API key, never the body. */
  readonly vaultAddress: string;
  /** The account that signed the payment. */
  readonly payer: string;
  /** The recipient, equal to `vaultAddress` by the time this exists. */
  readonly payTo: string;

  readonly asset: string;
  readonly token: TokenConfig;

  /** What the payer signed. */
  readonly grossAmount: bigint;
  readonly merchantAmount: bigint;
  readonly x402GoFee: bigint;
  readonly facilitatorFee: bigint;
  readonly totalFee: bigint;

  readonly x402Version: number;
  readonly scheme: string;
  readonly nonce: string;

  /**
   * The signed payload and the requirements, exactly as they arrived.
   *
   * Carried through untouched and forwarded to the facilitator verbatim. They
   * are held as `unknown` on purpose: this object is never read from, only
   * passed on, and typing it would invite somebody to "normalise" a field. The
   * payer's signature covers these bytes, so re-encoding them invalidates the
   * payment — the safe thing to do with them is nothing at all.
   */
  readonly rawPayload: unknown;
  readonly rawRequirements: unknown;

  /**
   * Deterministic id for this payment, derived from the signed data.
   *
   * The idempotency key. Two requests carrying the same signed authorization
   * produce the same value, which is what lets the second one be recognised as
   * a duplicate instead of being settled again.
   */
  readonly settlementId: string;
}

/** What a caller must supply. Kept separate so the controller stays thin. */
export interface PaymentContext {
  readonly merchantId: string;
  readonly merchantAddress: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolves a network string to a chain.
 *
 * Accepts CAIP-2 (`eip155:42220`), which is what v2 uses, and the two legacy
 * spellings the facilitator still advertises on its v1 kind. The identity of
 * the chain is decided here, from configuration, and never taken from the
 * request — the request only names it.
 */
export function resolveNetwork(network: unknown): ChainKey | null {
  if (typeof network !== 'string') return null;

  const trimmed = network.trim();
  const caip = /^eip155:(\d+)$/.exec(trimmed);

  if (caip) {
    return chainById(Number(caip[1]))?.key ?? null;
  }

  if (trimmed === 'celo') return 'celo';
  if (trimmed === 'celo-sepolia') return 'celoSepolia';

  return null;
}

/**
 * Reads an atomic amount.
 *
 * Strictly digits: no sign, no decimal point, no exponent, no surrounding
 * space. A value that does not parse is a malformed request rather than a zero,
 * because "0" and "not a number" must not become the same thing on a path that
 * compares against a fee.
 */
function readAtomic(value: unknown, field: string): bigint | null {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return null;

  try {
    return BigInt(value);
  } catch (error) {
    throw new FacilitatorError('invalid-request', {
      details: { field },
      cause: error,
    });
  }
}

/** Reads a field that must be a usable EVM address, returned lowercased. */
function readAddress(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || !isAddress(value)) return null;

  return getAddress(value).toLowerCase();
}

/** Reads a required string field, refusing an empty one. */
function readText(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;

  return value.trim();
}

/**
 * Derives the settlement id from the signed payment.
 *
 * Hashes the fields that make this authorization unique and unchangeable: the
 * chain, the token, both parties, the amount, the validity window, and the
 * EIP-3009 nonce (32 random bytes the payer picks, and the thing that stops a
 * signature being replayed). Two different payments differ in at least one of
 * these, and the same payment always produces the same id.
 *
 * Addresses are lowercased so that a payer who checksums their address
 * differently does not mint a second id for the same payment.
 */
export function deriveSettlementId(input: {
  readonly chain: ChainKey;
  readonly asset: string;
  readonly payer: string;
  readonly payTo: string;
  readonly value: bigint;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly nonce: string;
  readonly x402Version: number;
  readonly scheme: string;
}): string {
  const material = [
    input.chain,
    input.asset.toLowerCase(),
    input.payer.toLowerCase(),
    input.payTo.toLowerCase(),
    input.value.toString(),
    input.validAfter,
    input.validBefore,
    input.nonce,
    String(input.x402Version),
    input.scheme,
  ].join('|');

  return createHash('sha256').update(material).digest('hex');
}

export class X402Service {
  private readonly accounts: AccountService;

  constructor(accounts: AccountService = new AccountService()) {
    this.accounts = accounts;
  }

  /**
   * Validates a payment and computes its accounting, or throws.
   *
   * Every refusal is a `FacilitatorError` carrying a code the controller turns
   * into a status, and every one of them happens before the facilitator is
   * contacted. The order of the checks is deliberate: the envelope is checked
   * before anything is looked up, the chain before the token (a token address
   * only means something on one chain), the recipient before the amount, and
   * the fee last — so the error a caller gets names the first thing that is
   * actually wrong.
   */
  public async authorize(body: unknown, context: PaymentContext): Promise<AuthorizedPayment> {
    if (!isRecord(body)) {
      throw new FacilitatorError('invalid-request', { details: { reason: 'body' } });
    }

    const version = body.x402Version;

    if (typeof version !== 'number' || !Number.isInteger(version)) {
      throw new FacilitatorError('invalid-x402-version', {
        details: { reason: 'x402Version is not an integer' },
      });
    }

    if (version !== SUPPORTED_X402_VERSION) {
      throw new FacilitatorError('invalid-x402-version', {
        message: `Only x402 version ${SUPPORTED_X402_VERSION} can be settled here.`,
        details: { received: version },
      });
    }

    const requirements = body.paymentRequirements;
    const payload = body.paymentPayload;

    if (!isRecord(requirements) || !isRecord(payload)) {
      throw new FacilitatorError('invalid-request', {
        details: {
          reason: 'paymentRequirements and paymentPayload must both be objects',
          hasRequirements: isRecord(requirements),
          hasPayload: isRecord(payload),
        },
      });
    }

    const scheme = readText(requirements.scheme, 'scheme');

    if (scheme === null || scheme !== SUPPORTED_SCHEME) {
      throw new FacilitatorError('unsupported-scheme', {
        message: `Only the "${SUPPORTED_SCHEME}" scheme can be settled here.`,
        details: { received: requirements.scheme },
      });
    }

    const chain = resolveNetwork(requirements.network);

    if (!chain) {
      throw new FacilitatorError('unsupported-network', {
        details: { received: requirements.network },
      });
    }

    const asset = readText(requirements.asset, 'asset');
    const token = asset ? findSettleableToken(chain, asset) : undefined;

    if (!token) {
      throw new FacilitatorError('unsupported-asset', {
        details: { received: requirements.asset, chain },
      });
    }

    const feeSchedule = this.feeScheduleFor(token);
    const requirementsAmount = readAtomic(requirements.amount, 'amount');
    const requirementsPayTo = readAddress(requirements.payTo, 'payTo');

    if (requirementsAmount === null || requirementsPayTo === null) {
      throw new FacilitatorError('invalid-request', {
        details: {
          reason: 'amount must be an integer string and payTo a valid address',
          hasAmount: requirementsAmount !== null,
          hasPayTo: requirementsPayTo !== null,
        },
      });
    }

    const authorization = this.readAuthorization(payload);

    // The merchant's own vault, derived from the authenticated account. The one
    // address this payment is allowed to name.
    const vaultAddress = await this.vaultFor(context, chain);

    // Both halves must name the vault. Checking the signed recipient is the one
    // that decides where the money actually goes; checking the advertised one
    // stops a payment being accepted for a vault the merchant never asked for.
    if (requirementsPayTo !== vaultAddress || authorization.to !== vaultAddress) {
      throw new FacilitatorError('payto-mismatch', {
        details: {
          chain,
          // Addresses are safe to log — they are public. The payer's is not
          // secret either, but nothing here is echoed back to the caller.
          requirementsPayTo,
          signedPayTo: authorization.to,
          expected: vaultAddress,
        },
      });
    }

    // The signed value is what will move; the advertised value is what was
    // asked for. They must be the same number.
    if (authorization.value !== requirementsAmount) {
      throw new FacilitatorError('amount-mismatch', {
        details: {
          requirements: requirementsAmount.toString(),
          signed: authorization.value.toString(),
        },
      });
    }

    const grossAmount = authorization.value;

    // The guard, on the signed amount, in integers, before any network call.
    if (grossAmount <= feeSchedule.totalFee) {
      throw new FacilitatorError('fee-not-met', {
        details: {
          grossAmount: grossAmount.toString(),
          totalFee: feeSchedule.totalFee.toString(),
          asset: token.symbol,
        },
      });
    }

    const merchantAmount = grossAmount - feeSchedule.totalFee;

    // Implied by the guard above, asserted anyway: an accounting split that
    // credits nothing is not a settlement, and this is the invariant the whole
    // record is built on.
    if (merchantAmount <= BigInt(0)) {
      throw new FacilitatorError('fee-not-met', {
        details: { grossAmount: grossAmount.toString() },
      });
    }

    return {
      merchantId: context.merchantId,
      merchantAddress: context.merchantAddress.toLowerCase(),
      chain,
      chainId: chainByKey(chain).chainId,
      network: String(requirements.network).trim(),
      vaultAddress,
      payer: authorization.from,
      payTo: vaultAddress,
      asset: getAddress(token.address),
      token,
      grossAmount,
      merchantAmount,
      x402GoFee: feeSchedule.x402GoFee,
      facilitatorFee: feeSchedule.facilitatorFee,
      totalFee: feeSchedule.totalFee,
      x402Version: version,
      scheme,
      nonce: authorization.nonce,
      rawPayload: payload,
      rawRequirements: requirements,
      settlementId: deriveSettlementId({
        chain,
        asset: token.address,
        payer: authorization.from,
        payTo: vaultAddress,
        value: grossAmount,
        validAfter: authorization.validAfter,
        validBefore: authorization.validBefore,
        nonce: authorization.nonce,
        x402Version: version,
        scheme,
      }),
    };
  }

  /**
   * The fee schedule, or a refusal.
   *
   * A missing schedule means the asset has no stated dollar value or cannot
   * represent the fee at all — see `config/fees.ts`. It is reported as a
   * configuration fault rather than as a bad payment: the payer has done
   * nothing wrong, and no retry of theirs will change the answer.
   */
  private feeScheduleFor(token: TokenConfig): FeeSchedule {
    const schedule = feesFor(token);

    if (!schedule) {
      throw new FacilitatorError('fee-schedule-unavailable', {
        details: { asset: token.symbol, chain: token.chain, decimals: token.decimals },
      });
    }

    return schedule;
  }

  /**
   * The merchant's vault on this chain.
   *
   * Resolved from the account the API key authenticated — the request body has
   * no say in it, which is what makes it impossible for one merchant to verify
   * or settle against another's vault. `vaultAddressFor` derives the address
   * locally from the merchant, so this costs a database read and no chain call.
   *
   * Deliberately *not* conditional on the vault being deployed. A deterministic
   * address can receive an ERC-20 transfer before any contract exists there —
   * that is the premise the whole vault design rests on — so a payment to an
   * undeployed vault settles perfectly well and needs no deployment here.
   */
  private async vaultFor(context: PaymentContext, chain: ChainKey): Promise<string> {
    const vault = await this.accounts.vaultAddressFor(context.merchantId, chain);

    if (!vault || !isAddress(vault)) {
      throw new FacilitatorError('vault-unavailable', {
        details: { chain, merchant: context.merchantAddress },
      });
    }

    return getAddress(vault).toLowerCase();
  }

  /**
   * Extracts the signed `exact`-scheme authorization.
   *
   * The `exact` scheme signs an EIP-3009 `TransferWithAuthorization` (or its
   * Permit2 equivalent), whose fields are the payment: `from`, `to`, `value`,
   * the validity window, and the replay nonce. All of them are required — a
   * missing one means the payload is not a payment this proxy understands, and
   * guessing a default for any of them would be inventing part of a signature.
   */
  private readAuthorization(payload: Record<string, unknown>): {
    readonly from: string;
    readonly to: string;
    readonly value: bigint;
    readonly validAfter: string;
    readonly validBefore: string;
    readonly nonce: string;
  } {
    const inner = payload.payload;

    if (!isRecord(inner) || !isRecord(inner.authorization)) {
      throw new FacilitatorError('invalid-request', {
        details: { reason: 'paymentPayload.payload.authorization is missing' },
      });
    }

    const authorization = inner.authorization;

    const from = readAddress(authorization.from, 'authorization.from');
    const to = readAddress(authorization.to, 'authorization.to');
    const value = readAtomic(authorization.value, 'authorization.value');
    const validAfter = readText(authorization.validAfter, 'authorization.validAfter');
    const validBefore = readText(authorization.validBefore, 'authorization.validBefore');
    const nonce = readText(authorization.nonce, 'authorization.nonce');

    if (
      from === null ||
      to === null ||
      value === null ||
      validAfter === null ||
      validBefore === null ||
      nonce === null
    ) {
      throw new FacilitatorError('invalid-request', {
        details: {
          reason: 'the signed authorization is incomplete',
          fields: {
            from: from !== null,
            to: to !== null,
            value: value !== null,
            validAfter: validAfter !== null,
            validBefore: validBefore !== null,
            nonce: nonce !== null,
          },
        },
      });
    }

    return { from, to, value, validAfter, validBefore, nonce };
  }
}

export default X402Service;
