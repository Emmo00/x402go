import { randomUUID } from 'node:crypto';
import type { ChainKey } from '../config';
import { VaultLifecycleError } from '../exceptions/VaultLifecycleError';
import lockModel from '../models/lock.model';

/**
 * Taking a lock, holding it, and giving it back.
 *
 * The one thing this project needs a lock for is the vault lifecycle: two
 * requests that both find an undeployed vault must not both deploy it. They can
 * arrive at two different backend instances, so the lock has to live outside
 * the process — this is a thin, deliberate wrapper around one database
 * operation, not a general-purpose lock library.
 *
 * ## What it is and is not
 *
 * It is an optimisation. Deploying the same vault twice is already impossible:
 * the factory reverts `VaultExists`, and the second caller learns from that
 * revert that the vault is there. What the lock buys is that the second caller
 * usually never gets that far — it waits, then finds the vault already deployed
 * — so a normal race costs one transaction instead of one transaction and one
 * revert. If the lock were removed entirely the system would still be correct.
 *
 * It is not a lease with a fence. Holding the lock does not grant any authority
 * the chain recognises, and a stalled holder that outlives its TTL can be
 * overtaken by a second caller. That is acceptable precisely because the chain,
 * not the lock, is what makes the outcome unique.
 */

/** How long a holder may keep a lock before another caller may take it over. */
export const DEFAULT_LOCK_TTL_MS = 60_000;

/** How long `withLock` waits for a contended lock before giving up. */
const DEFAULT_WAIT_MS = 30_000;

/** How long between attempts while waiting. */
const DEFAULT_POLL_MS = 250;

/** Fields every lock acquisition needs. */
export interface AcquireOptions {
  /** How long the lock stays valid. Defaults to `DEFAULT_LOCK_TTL_MS`. */
  readonly ttlMs?: number;
  /**
   * The holder's token. Generated per acquisition when omitted, which is what
   * `withLock` does; passing one in is only useful for a test that wants to
   * release a handle it built by hand.
   */
  readonly owner?: string;
}

export interface WithLockOptions extends AcquireOptions {
  /** How long to wait for a contended lock. Defaults to 30s. */
  readonly waitMs?: number;
  /** How long between attempts. Defaults to 250ms. */
  readonly pollMs?: number;
}

/** Proof that this caller holds the lock, and the only thing that can release it. */
export interface LockHandle {
  readonly key: string;
  readonly owner: string;
}

/**
 * The lock key for one merchant's vault lifecycle on one chain.
 *
 * Chain is part of the key because the two networks are independent: a
 * merchant's Celo and Celo Sepolia vaults share nothing, and serialising them
 * against each other would make a slow mainnet deployment block a testnet one
 * for no reason. The address is lower-cased so the same merchant cannot hold
 * two locks under two spellings of its checksum.
 */
export function vaultLockKey(chain: ChainKey, merchant: string): string {
  return `vault:${chain}:${merchant.toLowerCase()}`;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Takes the lock if it is free, and returns `null` if it is not.
 *
 * Never waits. The wait belongs to `withLock`, which is where "someone else is
 * doing it, so I should follow them" is decided.
 *
 * The whole acquisition is one `findOneAndUpdate` with `upsert`, so there is no
 * interval between deciding the lock is free and taking it. The filter matches
 * only a record that is absent *or* expired; when the record exists and is
 * live, the filter does not match and the upsert's insert collides on `_id`,
 * which the database reports as a duplicate-key error. That error is the
 * answer, not a failure: it means someone else holds the lock.
 */
export async function tryAcquire(
  key: string,
  options: AcquireOptions = {},
): Promise<LockHandle | null> {
  const ttlMs = options.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const owner = options.owner ?? randomUUID();
  const now = new Date();

  try {
    const held = await lockModel.findOneAndUpdate(
      { _id: key, expiresAt: { $lte: now } },
      { $set: { owner, expiresAt: new Date(now.getTime() + ttlMs) } },
      { upsert: true, returnDocument: 'after', includeResultMetadata: false },
    );

    return held ? { key, owner } : null;
  } catch (error) {
    if (isDuplicateKeyError(error)) return null;

    throw error;
  }
}

/**
 * Gives the lock back.
 *
 * Scoped to this holder: a lock that expired while its owner was still working
 * may have been taken by someone else, and deleting that caller's lock would
 * put two writers on the same vault. A release that matches nothing is a
 * no-op, which is the correct outcome in exactly that case.
 */
export async function release(handle: LockHandle): Promise<void> {
  await lockModel.deleteOne({ _id: handle.key, owner: handle.owner });
}

/**
 * Runs `fn` while holding the lock, waiting for a contended one.
 *
 * Waiting is the point. The second request in a race is not an error — it is a
 * caller asking for an operation that is already in progress, and what it
 * should do is observe the result of that operation rather than be told to try
 * again. So a contended lock is waited on up to `waitMs`; only a lock held
 * longer than that becomes `lock-timeout`.
 *
 * The lock is released in a `finally` on every path, including a throw from
 * `fn`, so a failed operation does not leave the merchant locked out.
 */
export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
  options: WithLockOptions = {},
): Promise<T> {
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const owner = options.owner ?? randomUUID();
  const deadline = Date.now() + waitMs;

  let handle = await tryAcquire(key, { ...options, owner });

  while (!handle) {
    if (Date.now() >= deadline) {
      throw new VaultLifecycleError('lock-timeout', { details: { key, waitMs } });
    }

    // Jittered so that callers waiting on one hot vault do not wake up together
    // and contend for the lock in lockstep.
    await sleep(pollMs + Math.floor(Math.random() * pollMs));

    handle = await tryAcquire(key, { ...options, owner });
  }

  try {
    return await fn();
  } finally {
    try {
      await release(handle);
    } catch (error) {
      // Not fatal, and not the caller's problem: the lock carries an expiry, so
      // an un-released one frees itself. Reporting it here would turn a
      // successful operation into a failed request.
      console.warn('[lock] could not release', key, error);
    }
  }
}

/**
 * Empties the lock collection.
 *
 * For tests: locks outlive a case that acquired one and threw before releasing,
 * and a leftover row would make the next case's wait behave differently. The
 * TTL would clear it eventually, which is too late to be useful here.
 */
export async function clearLocks(): Promise<void> {
  await lockModel.deleteMany({});
}
