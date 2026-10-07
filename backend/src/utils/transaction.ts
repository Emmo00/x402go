import type { Abi, Address, Hex, TransactionReceipt } from 'viem';
import { VaultLifecycleError } from '../exceptions/VaultLifecycleError';

/**
 * Submitting a server-side transaction, and behaving correctly when the node
 * disagrees about which nonce is next.
 *
 * Every write x402Go performs is the operator's: deploying a vault, and later
 * withdrawals and payout changes. They all share the same failure mode. The
 * operator is one wallet sending from possibly several processes at once, so
 * two transactions can be built against the same nonce, and the node rejects
 * one of them. That is not a bug in the call — the same call with a fresh nonce
 * succeeds — so it is worth retrying, and it is the *only* thing worth
 * retrying.
 *
 * What this module deliberately does not do is retry on a hunch. A contract
 * revert is the contract's answer and resending it produces the same answer
 * plus another gas fee. An ambiguous "already known" means a transaction with
 * this nonce exists somewhere, and resending could make the same effect happen
 * twice; that case is verified against the caller's own postcondition rather
 * than retried.
 *
 * ## Contract with the caller
 *
 * The helper is handed a `TransactionSender` rather than reaching for a wallet
 * itself. That is what makes the nonce behaviour testable without a node: the
 * interesting states — a consumed nonce, a revert, a transaction that is mined
 * but never confirmed — are ones a live RPC will not produce on request.
 */

/** A contract call, without the transaction envelope. */
export interface ContractWrite {
  readonly address: Address;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args?: readonly unknown[];
}

/**
 * Something that can put a contract call on a chain and wait for it.
 *
 * `pendingNonce` is named for what it must return: the count including
 * transactions still in the mempool, not the count of mined ones. Reading the
 * latest nonce would hand back a nonce that is already spoken for, which is the
 * exact failure this module exists to recover from.
 */
export interface TransactionSender {
  /** The address that will be `msg.sender`. Never a key, and never derived here. */
  readonly account: Address;
  readonly chain: ChainKeyForTransaction;
  readonly chainId: number;
  /** The next nonce to use, counting transactions still pending. */
  pendingNonce(): Promise<number>;
  /** Submits the call with an explicit nonce. The nonce is never left to the node. */
  send(write: ContractWrite, nonce: number): Promise<Hex>;
  /** Waits for the transaction to be mined. */
  waitForReceipt(hash: Hex): Promise<TransactionReceipt>;
  /** Reads a receipt without waiting, or `null` if it is not mined yet. */
  getReceipt(hash: Hex): Promise<TransactionReceipt | null>;
}

/** Kept structural so this module does not import the chain config. */
export type ChainKeyForTransaction = string;

export type TransactionOutcome =
  /** The transaction was mined and succeeded. */
  | {
      readonly status: 'confirmed';
      readonly hash: Hex;
      readonly receipt: TransactionReceipt;
      readonly nonce: number;
      readonly attempts: number;
    }
  /**
   * The transaction did not need to be confirmed because the caller's own
   * postcondition already held — the vault was deployed by whoever got there
   * first, including a previous attempt of our own that the node reported
   * ambiguously.
   *
   * `hash` is present when this process submitted the transaction that turned
   * out to be unnecessary, and absent when someone else did.
   */
  | {
      readonly status: 'already-settled';
      readonly hash: Hex | null;
      readonly nonce: number | null;
      readonly attempts: number;
    }
  /** The transaction was mined and the contract rejected it. */
  | {
      readonly status: 'reverted';
      readonly hash: Hex;
      readonly receipt: TransactionReceipt;
      readonly nonce: number;
      readonly attempts: number;
    };

/**
 * Why a send or a receipt wait failed, in the terms the retry decision needs.
 *
 * The three nonce-adjacent kinds are kept apart on purpose, because they call
 * for opposite responses and they arrive from the node looking similar:
 *
 * - `nonce-stale` — our nonce is behind (too low, already used) or ahead (too
 *   high). The transaction was *rejected*, so nothing of ours is in flight and
 *   resending with a corrected nonce is safe.
 * - `nonce-conflict` — a transaction with this nonce is already known to the
 *   node. Something of ours may be in flight, so resending risks doing the
 *   operation twice. It must be verified, never retried.
 * - `reverted` — the contract refused. Resending reproduces it.
 */
export type TransactionFailureKind =
  | 'nonce-stale'
  | 'nonce-conflict'
  | 'reverted'
  | 'receipt-missing'
  | 'unknown';

export interface ExecuteTransactionOptions {
  /**
   * Proves the operation's postcondition already holds.
   *
   * Consulted before anything is resent. It is what makes the ambiguous cases
   * safe: an operation that has already happened does not need a second
   * transaction, whoever performed it.
   */
  readonly isSettled?: () => Promise<boolean>;
  /** Total submissions attempted before giving up. Defaults to 3. */
  readonly maxAttempts?: number;
  /** Base delay between nonce retries. Defaults to 250ms. */
  readonly retryDelayMs?: number;
  /** How many times to re-check `isSettled` after an ambiguous send. */
  readonly ambiguityPolls?: number;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_AMBIGUITY_POLLS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Every message and error name in an error's cause chain, lower-cased.
 *
 * Nodes disagree about where the reason lives — one puts it in `details`,
 * another in `shortMessage`, a wrapped viem error in `cause` — so the whole
 * chain is flattened and matched as text rather than by shape. The viem error
 * *classes* are checked first, since a typed match cannot be defeated by a
 * node rewording its message.
 */
function describeError(error: unknown): { names: string[]; text: string } {
  const names: string[] = [];
  const parts: string[] = [];

  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);

    const record = current as Record<string, unknown>;

    if (typeof record.name === 'string') names.push(record.name);

    for (const key of ['message', 'shortMessage', 'details', 'reason'] as const) {
      if (typeof record[key] === 'string') parts.push(record[key] as string);
    }

    // viem hangs the decoded revert off `data`; `errorName` is the custom error.
    const data = record.data as Record<string, unknown> | undefined;
    if (data && typeof data === 'object') {
      if (typeof data.errorName === 'string') names.push(data.errorName);
      if (typeof data.reason === 'string') parts.push(data.reason);
    }

    current = record.cause;
  }

  return { names, text: parts.join(' | ').toLowerCase() };
}

/** Error names that mean "the contract refused this call". */
const REVERT_NAMES = ['ContractFunctionRevertedError', 'CallExecutionError'];

/**
 * Node wordings that mean our nonce is behind or ahead of the account's.
 *
 * Matching on text is a fallback, not the primary check: these are the strings
 * the Celo and Forno nodes actually return, and a node that words it
 * differently degrades to "unknown" — which means no retry, not a wrong retry.
 */
const NONCE_STALE_PATTERNS = [
  /nonce too low/,
  /nonce is too low/,
  /nonce has already been used/,
  /nonce too high/,
  /invalid nonce/,
  /old nonce/,
  /next nonce/,
];

/**
 * Node wordings that mean a transaction with this nonce exists somewhere.
 *
 * `replacement transaction underpriced` and `already known` are the two a node
 * returns when it already holds our transaction — the first when the same
 * nonce is being reused with lower fees, the second when the exact transaction
 * is already in the pool. Both mean something may be in flight.
 */
const NONCE_CONFLICT_PATTERNS = [
  /already known/,
  /known transaction/,
  /transaction already imported/,
  /already imported/,
  /replacement transaction underpriced/,
  /transaction underpriced/,
  /same hash was already imported/,
];

/** Wordings that mean the wait gave up rather than the transaction failing. */
const RECEIPT_MISSING_PATTERNS = [/not be found/, /timed out/, /timeout/];

/**
 * What a failure means for the retry decision.
 *
 * Reverts are checked before nonce wordings because a reverted call can also
 * mention a nonce — a contract that checks `msg.sender` may be reached with a
 * stale nonce — and a revert is the more specific explanation.
 */
export function classifyTransactionFailure(error: unknown): TransactionFailureKind {
  const { names, text } = describeError(error);

  // Typed first: these are viem's own classes, so they cannot be missed by a
  // node rewording anything.
  if (
    names.some((name) => REVERT_NAMES.includes(name)) ||
    /^reverted/.test(text) ||
    text.includes('execution reverted')
  ) {
    // A custom error name decoded from the ABI also proves it was a revert.
    return 'reverted';
  }

  if (names.includes('NonceTooLowError') || names.includes('NonceTooHighError') || names.includes('NonceMaxValueError')) {
    return 'nonce-stale';
  }

  if (NONCE_CONFLICT_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'nonce-conflict';
  }

  if (NONCE_STALE_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'nonce-stale';
  }

  if (
    names.includes('WaitForTransactionReceiptTimeoutError') ||
    names.includes('TransactionReceiptNotFoundError') ||
    RECEIPT_MISSING_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return 'receipt-missing';
  }

  return 'unknown';
}

/**
 * The custom error a revert decoded to, e.g. `VaultExists`.
 *
 * Returned so a caller can act on a specific revert rather than on "it
 * reverted". The factory's `VaultExists` is the one that matters here: it is
 * the chain telling us someone deployed the vault first, which is a state to
 * adopt, not a failure to report.
 */
export function revertErrorName(error: unknown): string | null {
  if (classifyTransactionFailure(error) !== 'reverted') return null;

  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);

    const record = current as Record<string, unknown>;
    const data = record.data as Record<string, unknown> | undefined;

    if (data && typeof data === 'object' && typeof data.errorName === 'string') {
      return data.errorName;
    }

    current = record.cause;
  }

  return null;
}

/**
 * Checks the caller's postcondition, treating any failure to check as "not
 * satisfied".
 *
 * The conservative direction on purpose: this predicate is consulted before a
 * decision *not* to resend, so an unverifiable postcondition must not be read
 * as a satisfied one. A false negative costs a redundant transaction at worst;
 * a false positive would silently report an operation that never happened.
 */
async function settled(isSettled: (() => Promise<boolean>) | undefined): Promise<boolean> {
  if (!isSettled) return false;

  try {
    return await isSettled();
  } catch {
    return false;
  }
}

/** The revert error the helper itself raises, so the wait loop re-throws it as-is. */
function isHelperError(value: unknown): value is VaultLifecycleError {
  return value instanceof VaultLifecycleError;
}

/**
 * Submits a contract call, retrying only when the nonce is provably stale.
 *
 * See the module docstring for the reasoning; the shape of the loop is:
 * read the pending nonce, send with it, wait, and classify anything that goes
 * wrong into retry / verify / stop.
 */
export async function executeTransaction(
  sender: TransactionSender,
  write: ContractWrite,
  options: ExecuteTransactionOptions = {},
): Promise<TransactionOutcome> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const ambiguityPolls = Math.max(1, options.ambiguityPolls ?? DEFAULT_AMBIGUITY_POLLS);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Read afresh every attempt. Caching it across attempts is the bug this
    // module exists to avoid: the reason a retry is happening is that the
    // nonce we held was wrong.
    const nonce = await sender.pendingNonce();

    let hash: Hex;

    try {
      hash = await sender.send(write, nonce);
    } catch (error) {
      const kind = classifyTransactionFailure(error);

      // Checked before any retry: if the operation has already happened, the
      // only correct thing to do is adopt that result.
      if (await settled(options.isSettled)) {
        return { status: 'already-settled', hash: null, nonce, attempts: attempt };
      }

      if (kind === 'nonce-stale') {
        if (attempt < maxAttempts) {
          await sleep(retryDelayMs * attempt);
          continue;
        }

        throw new VaultLifecycleError('nonce-retries-exhausted', {
          details: { chain: sender.chain, nonce, attempts: attempt },
          cause: error,
        });
      }

      if (kind === 'nonce-conflict') {
        // Something with this nonce is already in flight. Resending risks
        // performing the operation twice, so we wait for the caller's
        // postcondition to become true rather than duplicating the call.
        for (let poll = 0; poll < ambiguityPolls; poll += 1) {
          await sleep(retryDelayMs);

          if (await settled(options.isSettled)) {
            return { status: 'already-settled', hash: null, nonce, attempts: attempt };
          }
        }

        throw new VaultLifecycleError('transaction-ambiguous', {
          details: { chain: sender.chain, nonce, attempts: attempt },
          cause: error,
        });
      }

      if (kind === 'reverted') {
        throw new VaultLifecycleError('deployment-reverted', {
          details: {
            chain: sender.chain,
            nonce,
            revert: revertErrorName(error),
            // The reason is the contract's own words and is safe to log. It is
            // not put in the message, which is shown to a merchant.
            reason: describeError(error).text.slice(0, 300),
          },
          cause: error,
        });
      }

      throw new VaultLifecycleError('deployment-reverted', {
        details: { chain: sender.chain, nonce, attempts: attempt, kind },
        cause: error,
      });
    }

    // The transaction is away. From here a failure is never a reason to send
    // another one: the hash proves something is in flight.
    try {
      const receipt = await sender.waitForReceipt(hash);

      if (receipt.status === 'reverted') {
        if (await settled(options.isSettled)) {
          return { status: 'already-settled', hash, nonce, attempts: attempt };
        }

        return { status: 'reverted', hash, receipt, nonce, attempts: attempt };
      }

      return { status: 'confirmed', hash, receipt, nonce, attempts: attempt };
    } catch (error) {
      if (isHelperError(error)) throw error;

      if (await settled(options.isSettled)) {
        return { status: 'already-settled', hash, nonce, attempts: attempt };
      }

      // A wait that timed out is not a transaction that failed. Ask once more
      // before giving up, because a receipt can land between the wait's last
      // poll and its timeout.
      const recovered = await sender.getReceipt(hash).catch(() => null);

      if (recovered) {
        if (recovered.status === 'reverted') {
          return { status: 'reverted', hash, receipt: recovered, nonce, attempts: attempt };
        }

        return { status: 'confirmed', hash, receipt: recovered, nonce, attempts: attempt };
      }

      throw new VaultLifecycleError('transaction-pending', {
        details: { chain: sender.chain, hash, nonce, attempts: attempt },
        cause: error,
      });
    }
  }

  // The loop only exits by returning or throwing; this is for the type checker.
  throw new VaultLifecycleError('nonce-retries-exhausted', {
    details: { chain: sender.chain, attempts: maxAttempts },
  });
}

export default executeTransaction;
