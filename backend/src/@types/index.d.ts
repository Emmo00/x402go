import { type Router } from 'express';
import type { Document } from 'mongoose';
import 'express-session';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: IUserDocument;
    }
  }

  interface IAppRoute {
    path: string;
    router: Router;
  }

  /**
   * The single API key an account may hold.
   *
   * `hash` is the only credential that is ever persisted — the plaintext key
   * exists solely in the response that creates it. `suffix` is the last few
   * characters of the plaintext, kept so the key can be recognised in the UI
   * and used to narrow candidates before the hash is verified. It is not a
   * secret and cannot be used to authenticate.
   */
  interface IApiKey {
    hash: string;
    suffix: string;
    createdAt: Date;
    rotatedAt?: Date;
  }

  /**
   * One merchant vault, on one chain.
   *
   * `address` is the deterministic address the factory computes for this
   * merchant. It is a real address from the moment it is derived and does not
   * imply that a vault has been deployed there — deployment is a separate fact,
   * read from the chain, and deliberately not stored here. Caching it would
   * make the record claim something it cannot know.
   *
   * The optional fields below are the one exception, and they are not the same
   * kind of thing: each records an event that has already happened, at the
   * moment the operator's transaction deployed this vault. They are written
   * once and never updated, so they cannot go stale the way a `deployed`
   * boolean would — a vault that was deployed at block N stays deployed at
   * block N even if the record is later lost or wrong. They exist so a support
   * question can be answered without a block-explorer search, and nothing
   * decides anything from them: `isVaultDeployed` reads the chain.
   */
  interface IVault {
    address: string;
    chainId: number;
    createdAt: Date;
    /** Hash of the transaction that deployed this vault, as sent by the operator. */
    transactionHash?: string;
    /** The block that transaction was mined in. */
    blockNumber?: number;
    /** When this backend observed the deployment confirmed. */
    deployedAt?: Date;
  }

  interface IUser {
    address: string;
    authChallenge: {
      nonce: string;
      expiredAt: Date;
      used: boolean;
    };
    apiKey?: IApiKey;
    /**
     * The address settled x402 payments are sent to. Optional: an account has
     * none until it completes onboarding. Stored lowercased, like `address`,
     * so nothing ever hinges on checksum casing.
     */
    payTo?: string;
    /**
     * The merchant's vault addresses, keyed by chain (`celo`, `celoSepolia`).
     *
     * A map rather than a list because there is exactly one vault per merchant
     * per chain — a uniqueness rule the storage enforces for free, instead of
     * leaving a duplicate entry to be filtered out at read time. Sparse: an
     * account has no map until its first sign-in derives one.
     *
     * Every entry is a cache of `X402VaultFactory.vaultOf(merchant)`. The
     * factory's answer is authoritative; a stored value that disagrees with it
     * is a bug to be corrected, never a preference to be honoured.
     */
    vaults?: Map<string, IVault>;
  }

  type IUserDocument = IUser & Document;

  /**
   * A short-lived mutual-exclusion record, held in the database rather than in
   * this process's memory.
   *
   * `_id` is the resource being locked, not a generated id, so "only one
   * holder" is enforced by the `_id` uniqueness rule the database already
   * guarantees. `owner` identifies the holder so only it can release the lock:
   * a lock that expires and is taken by someone else must not be deleted by the
   * previous holder when it finally finishes.
   *
   * `expiresAt` is what makes the lock recoverable. A process that dies mid
   * operation never releases, and without an expiry the resource would be
   * locked forever; the TTL index is the janitor for that case, and the
   * acquire query treats an expired record as free.
   */
  interface ILock {
    _id: string;
    owner: string;
    expiresAt: Date;
  }

  /**
   * One x402 payment x402Go has attempted to settle.
   *
   * The accounting record, written before the facilitator is called so that an
   * in-flight, failed, or unknown payment is representable — the three states a
   * record written only on success could not describe.
   *
   * Every amount is a `string` of integer atomic units. A `number` loses
   * precision long before 18 decimals, and these values are compared and summed,
   * so the exact digits are what is stored. See `models/settlements.model.ts`
   * for why the fee split is recorded rather than recomputed.
   */
  interface ISettlement {
    /**
     * Deterministic, derived from the signed payment, and unique.
     *
     * This is the idempotency key: the same signed authorization presented
     * twice derives the same value, so the duplicate is recognised rather than
     * settled a second time.
     */
    settlementId: string;
    /** Resolved from the authenticated API key, never from the request body. */
    merchantId: string;
    merchantAddress: string;
    /** The vault the payment is addressed to. Equal to `payTo`. */
    vaultAddress: string;
    /** The chain key (`celo`, `celoSepolia`). */
    network: string;
    chainId: number;

    /** The signing account, read from the signed authorization. */
    payer?: string;
    payTo: string;
    asset: string;

    grossAmount: string;
    merchantAmount: string;
    x402GoFee: string;
    facilitatorFee: string;
    totalFee: string;

    x402Version: number;
    scheme: string;
    nonce: string;

    /**
     * `pending_reconciliation` is a first-class outcome, not a failure: the
     * settlement was submitted and its result is unknown. It must never be
     * collapsed into `failed`, because retrying a payment that may already have
     * settled is the one error that costs money twice.
     */
    status: 'pending' | 'settled' | 'failed' | 'pending_reconciliation';

    /** The facilitator's response body, verbatim, for reconciliation. */
    facilitatorResponse?: unknown;
    failureReason?: string;

    transactionHash?: string;
    blockNumber?: number;

    createdAt: Date;
    /**
     * Set once, when this settlement is handed to the facilitator, by a
     * compare-and-swap that only succeeds if it was unset.
     *
     * It is what makes resubmission impossible: a `pending` record without it
     * provably never reached Celo, and one with it never will again. Two
     * concurrent requests carrying the same payment cannot both claim it.
     */
    submittedAt?: Date;
    settledAt?: Date;
  }

  type ISettlementDocument = ISettlement & Document;
}
