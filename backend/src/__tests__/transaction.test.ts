import { describe, expect, test } from 'bun:test';
import type { Hex, TransactionReceipt } from 'viem';

import { VaultLifecycleError } from '../exceptions/VaultLifecycleError';
import {
  classifyTransactionFailure,
  executeTransaction,
  revertErrorName,
  type ContractWrite,
  type TransactionSender,
} from '../utils/transaction';

/**
 * The retry policy, without a node.
 *
 * Every interesting state here is one a live RPC will not produce on request: a
 * nonce that was consumed between reading it and using it, a transaction the
 * pool already holds, a receipt that never arrives. They are the states that
 * decide whether the helper sends a second transaction, and getting that wrong
 * either strands an operation or performs it twice — so they are scripted
 * rather than waited for.
 *
 * The helper takes a `TransactionSender` precisely so this is possible; nothing
 * in this file touches a chain, a key, or a database.
 */

const OPERATOR = '0x1111111111111111111111111111111111111111' as const;
const HASH = `0x${'ab'.repeat(32)}` as Hex;
const OTHER_HASH = `0x${'cd'.repeat(32)}` as Hex;

const WRITE: ContractWrite = {
  address: '0x698E55e1c8b4d9eAACbCfceCdd9D4E85B1D2701e',
  abi: [],
  functionName: 'createVault',
  args: [OPERATOR, OPERATOR],
};

/** A receipt as viem hands one back, with only the fields the helper reads. */
function receipt(hash: Hex, status: 'success' | 'reverted' = 'success'): TransactionReceipt {
  return {
    transactionHash: hash,
    status,
    blockNumber: BigInt(1234),
  } as unknown as TransactionReceipt;
}

/** A node error carrying the name viem's typed errors have. */
function nodeError(name: string, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { name, ...extra });
}

/** What one call to `send` should do. */
type SendStep = { hash: Hex } | { error: unknown };

/** What one call to `waitForReceipt` should do. */
type WaitStep = { receipt: TransactionReceipt } | { error: unknown };

/**
 * A sender that replays a script and records what it was asked to do.
 *
 * The recorded arrays are the assertions that matter: how many times a nonce
 * was read, how many transactions were submitted, and with which nonce. A test
 * that only checked the returned status could not tell a correct retry from a
 * silent duplicate submission.
 */
class ScriptedSender implements TransactionSender {
  public readonly account = OPERATOR;
  public readonly chain = 'celo';
  public readonly chainId = 42220;

  public readonly noncesRead: number[] = [];
  public readonly sent: { write: ContractWrite; nonce: number }[] = [];
  public readonly waitedFor: Hex[] = [];
  public readonly polledFor: Hex[] = [];

  private nonceIndex = 0;

  constructor(
    private readonly nonces: readonly number[],
    private readonly sends: readonly SendStep[],
    private readonly waits: readonly WaitStep[] = [{ receipt: receipt(HASH) }],
    private readonly polls: readonly (TransactionReceipt | null)[] = [null],
  ) {}

  /** The next scripted nonce; the last one repeats, so a bounded retry can end. */
  public async pendingNonce(): Promise<number> {
    const nonce = this.nonces[Math.min(this.nonceIndex, this.nonces.length - 1)];
    this.nonceIndex += 1;
    this.noncesRead.push(nonce);

    return nonce;
  }

  public async send(write: ContractWrite, nonce: number): Promise<Hex> {
    this.sent.push({ write, nonce });

    const step = this.sends[Math.min(this.sent.length - 1, this.sends.length - 1)];

    if (!step) throw new Error('scripted sender ran out of steps');

    if ('error' in step) throw step.error;

    return step.hash;
  }

  public async waitForReceipt(hash: Hex): Promise<TransactionReceipt> {
    this.waitedFor.push(hash);

    const step = this.waits[Math.min(this.waitedFor.length - 1, this.waits.length - 1)];

    if (!step) throw new Error('scripted sender ran out of waits');

    if ('error' in step) throw step.error;

    return step.receipt;
  }

  public async getReceipt(hash: Hex): Promise<TransactionReceipt | null> {
    this.polledFor.push(hash);

    return this.polls[Math.min(this.polledFor.length - 1, this.polls.length - 1)] ?? null;
  }
}

/** Keeps a retry test from spending real time on the backoff. */
const FAST = { retryDelayMs: 1, ambiguityPolls: 2 } as const;

describe('classifying a failure', () => {
  test('a typed nonce error is stale, whatever the node calls it', () => {
    expect(
      classifyTransactionFailure(nodeError('NonceTooLowError', 'something the node wrote')),
    ).toBe('nonce-stale');
  });

  test('reads the node wordings for a nonce that moved', () => {
    for (const message of [
      'nonce too low',
      'Nonce is too low',
      'nonce has already been used',
      'invalid nonce',
    ]) {
      expect(classifyTransactionFailure(new Error(message))).toBe('nonce-stale');
    }
  });

  test('separates "already known" from a stale nonce', () => {
    // The single most important distinction in this module. Both arrive looking
    // like a nonce problem, but one means nothing of ours is in flight and the
    // other means something might be. Treating the second as the first is how
    // an operation happens twice.
    for (const message of [
      'already known',
      'known transaction',
      'replacement transaction underpriced',
      'transaction underpriced',
      'same hash was already imported',
    ]) {
      expect(classifyTransactionFailure(new Error(message))).toBe('nonce-conflict');
    }
  });

  test('a revert is a revert, even when the message also mentions a nonce', () => {
    expect(
      classifyTransactionFailure(
        nodeError('ContractFunctionRevertedError', 'execution reverted: nonce too low'),
      ),
    ).toBe('reverted');
  });

  test('finds the reason in a nested cause', () => {
    const inner = nodeError('ContractFunctionRevertedError', 'execution reverted');
    const outer = nodeError('ContractFunctionExecutionError', 'wrapped', { cause: inner });

    expect(classifyTransactionFailure(outer)).toBe('reverted');
  });

  test('a receipt that never arrived is not a failure of the transaction', () => {
    expect(
      classifyTransactionFailure(nodeError('WaitForTransactionReceiptTimeoutError', 'timed out')),
    ).toBe('receipt-missing');
  });

  test('anything unrecognised is unknown, which is a decision not to retry', () => {
    expect(classifyTransactionFailure(new Error('insufficient funds for gas'))).toBe('unknown');
    expect(classifyTransactionFailure(null)).toBe('unknown');
  });
});

describe('naming a revert', () => {
  test('returns the custom error the contract raised', () => {
    const error = nodeError('ContractFunctionRevertedError', 'execution reverted', {
      data: { errorName: 'VaultExists' },
    });

    expect(revertErrorName(error)).toBe('VaultExists');
  });

  test('returns null for a failure that was not a revert', () => {
    expect(revertErrorName(new Error('nonce too low'))).toBeNull();
  });
});

describe('submitting a transaction', () => {
  test('returns the receipt when it succeeds first time', async () => {
    const sender = new ScriptedSender([7], [{ hash: HASH }]);

    const outcome = await executeTransaction(sender, WRITE, FAST);

    expect(outcome.status).toBe('confirmed');

    if (outcome.status !== 'confirmed') throw new Error('unreachable');

    expect(outcome.hash).toBe(HASH);
    expect(outcome.nonce).toBe(7);
    expect(outcome.attempts).toBe(1);
    expect(sender.sent).toHaveLength(1);
  });

  test('retries a stale nonce with a nonce read afresh', async () => {
    const sender = new ScriptedSender(
      [7, 8],
      [{ error: nodeError('NonceTooLowError', 'nonce too low') }, { hash: HASH }],
    );

    const outcome = await executeTransaction(sender, WRITE, FAST);

    expect(outcome.status).toBe('confirmed');
    expect(outcome.attempts).toBe(2);

    // The retry is only correct because the nonce was re-read. Resending the
    // nonce that was just rejected would produce the same rejection.
    expect(sender.noncesRead).toEqual([7, 8]);
    expect(sender.sent.map((s) => s.nonce)).toEqual([7, 8]);
  });

  test('gives up after a bounded number of stale nonces', async () => {
    const sender = new ScriptedSender(
      [7],
      [{ error: nodeError('NonceTooLowError', 'nonce too low') }],
    );

    const failure = executeTransaction(sender, WRITE, { ...FAST, maxAttempts: 3 });

    await expect(failure).rejects.toBeInstanceOf(VaultLifecycleError);

    try {
      await failure;
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as VaultLifecycleError).code).toBe('nonce-retries-exhausted');
    }

    // Bounded means bounded: exactly the configured number of submissions, not
    // one more and not an unbounded loop.
    expect(sender.sent).toHaveLength(3);
  });

  test('does not retry a revert', async () => {
    const sender = new ScriptedSender(
      [7],
      [
        {
          error: nodeError('ContractFunctionRevertedError', 'execution reverted', {
            data: { errorName: 'VaultExists' },
          }),
        },
      ],
    );

    const failure = executeTransaction(sender, WRITE, FAST);

    await expect(failure).rejects.toBeInstanceOf(VaultLifecycleError);

    try {
      await failure;
      throw new Error('expected a rejection');
    } catch (error) {
      const typed = error as VaultLifecycleError;

      expect(typed.code).toBe('deployment-reverted');
      // The contract's own error name is kept for the log, and never promoted
      // into the message a merchant reads.
      expect(typed.details.revert).toBe('VaultExists');
      expect(typed.message).not.toContain('VaultExists');
    }

    expect(sender.sent).toHaveLength(1);
  });

  test('does not retry an unrecognised failure', async () => {
    const sender = new ScriptedSender([7], [{ error: new Error('insufficient funds for gas') }]);

    const failure = executeTransaction(sender, WRITE, FAST);

    await expect(failure).rejects.toBeInstanceOf(VaultLifecycleError);

    try {
      await failure;
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as VaultLifecycleError).details.kind).toBe('unknown');
    }

    expect(sender.sent).toHaveLength(1);
  });

  test('adopts an already-satisfied postcondition instead of resending', async () => {
    const sender = new ScriptedSender(
      [7, 8],
      [{ error: nodeError('NonceTooLowError', 'nonce too low') }],
    );

    const outcome = await executeTransaction(sender, WRITE, {
      ...FAST,
      isSettled: async () => true,
    });

    expect(outcome.status).toBe('already-settled');
    // Nothing was resent, and no second nonce was read: the operation had
    // already happened, so the only correct move was to adopt that.
    expect(sender.sent).toHaveLength(1);
    expect(sender.noncesRead).toEqual([7]);
  });

  test('treats an "already known" transaction as ambiguous, never as a retry', async () => {
    const sender = new ScriptedSender([7], [{ error: new Error('already known') }]);

    const failure = executeTransaction(sender, WRITE, {
      ...FAST,
      isSettled: async () => false,
    });

    await expect(failure).rejects.toBeInstanceOf(VaultLifecycleError);

    try {
      await failure;
      throw new Error('expected a rejection');
    } catch (error) {
      const typed = error as VaultLifecycleError;

      expect(typed.code).toBe('transaction-ambiguous');
      expect(typed.status).toBe(409);
    }

    // The pool already holds a transaction with this nonce. Sending another one
    // is the one thing that could make the operation happen twice, so the
    // helper waits on the caller's postcondition instead — and here that never
    // became true, so it stops and says so.
    expect(sender.sent).toHaveLength(1);
    expect(sender.noncesRead).toEqual([7]);
  });

  test('adopts the result once an ambiguous transaction settles', async () => {
    const sender = new ScriptedSender([7], [{ error: new Error('already known') }]);

    // Settles on the second poll, as it would if the in-flight transaction were
    // mined a moment after the node refused the duplicate.
    let checks = 0;

    const outcome = await executeTransaction(sender, WRITE, {
      ...FAST,
      ambiguityPolls: 5,
      isSettled: async () => {
        checks += 1;
        return checks >= 2;
      },
    });

    expect(outcome.status).toBe('already-settled');
    expect(sender.sent).toHaveLength(1);
  });

  test('reports a receipt that timed out as pending, and does not resend', async () => {
    const sender = new ScriptedSender(
      [7],
      [{ hash: HASH }],
      [{ error: nodeError('WaitForTransactionReceiptTimeoutError', 'timed out') }],
      [null],
    );

    const failure = executeTransaction(sender, WRITE, FAST);

    await expect(failure).rejects.toBeInstanceOf(VaultLifecycleError);

    try {
      await failure;
      throw new Error('expected a rejection');
    } catch (error) {
      const typed = error as VaultLifecycleError;

      expect(typed.code).toBe('transaction-pending');
      // The hash is carried out: the transaction is out there, and whoever
      // handles this needs to be able to say which one.
      expect(typed.details.hash).toBe(HASH);
    }

    expect(sender.sent).toHaveLength(1);
    expect(sender.polledFor).toEqual([HASH]);
  });

  test('finds a receipt that landed between the last poll and the timeout', async () => {
    const sender = new ScriptedSender(
      [7],
      [{ hash: HASH }],
      [{ error: nodeError('WaitForTransactionReceiptTimeoutError', 'timed out') }],
      [receipt(HASH)],
    );

    const outcome = await executeTransaction(sender, WRITE, FAST);

    expect(outcome.status).toBe('confirmed');

    if (outcome.status !== 'confirmed') throw new Error('unreachable');

    expect(outcome.hash).toBe(HASH);
    expect(sender.sent).toHaveLength(1);
  });

  test('returns a mined revert as a revert rather than throwing', async () => {
    const sender = new ScriptedSender([7], [{ hash: HASH }], [{ receipt: receipt(HASH, 'reverted') }]);

    const outcome = await executeTransaction(sender, WRITE, FAST);

    // Nothing was simulated against this call — the transaction was mined and
    // the contract refused it. The caller decides what that means.
    expect(outcome.status).toBe('reverted');

    if (outcome.status !== 'reverted') throw new Error('unreachable');

    expect(outcome.receipt.status).toBe('reverted');
    expect(sender.sent).toHaveLength(1);
  });

  test('a mined revert whose postcondition holds is a success', async () => {
    const sender = new ScriptedSender([7], [{ hash: HASH }], [{ receipt: receipt(HASH, 'reverted') }]);

    const outcome = await executeTransaction(sender, WRITE, {
      ...FAST,
      isSettled: async () => true,
    });

    // The vault exists. That it was a previous attempt of ours that deployed it
    // does not make this operation a failure.
    expect(outcome.status).toBe('already-settled');

    if (outcome.status !== 'already-settled') throw new Error('unreachable');

    expect(outcome.hash).toBe(HASH);
  });

  test('a postcondition that cannot be checked is not read as satisfied', async () => {
    const sender = new ScriptedSender(
      [7],
      [{ error: nodeError('NonceTooLowError', 'nonce too low') }],
    );

    const failure = executeTransaction(sender, WRITE, {
      ...FAST,
      maxAttempts: 1,
      isSettled: async () => {
        throw new Error('the node is unreachable');
      },
    });

    // A false negative costs a redundant transaction; a false positive would
    // report an operation that never happened. So a broken check means "not
    // settled", and the operation fails rather than being assumed done.
    await expect(failure).rejects.toBeInstanceOf(VaultLifecycleError);

    try {
      await failure;
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as VaultLifecycleError).code).toBe('nonce-retries-exhausted');
    }
  });

  test('never submits a second transaction once the first is away', async () => {
    const sender = new ScriptedSender(
      [7],
      [{ hash: HASH }, { hash: OTHER_HASH }],
      [{ error: nodeError('WaitForTransactionReceiptTimeoutError', 'timed out') }],
      [null],
    );

    await expect(executeTransaction(sender, WRITE, FAST)).rejects.toBeInstanceOf(
      VaultLifecycleError,
    );

    // The whole point: a transaction is in flight from the moment it is
    // accepted, and a failure to observe its receipt says nothing about whether
    // it will be mined. Sending a replacement would be a second effect.
    expect(sender.sent).toHaveLength(1);
  });
});
