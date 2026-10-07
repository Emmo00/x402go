import { createWalletClient, http, type Address, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { chainByKey, type ChainKey } from '../config';
import { VaultLifecycleError } from '../exceptions/VaultLifecycleError';
import { getPublicClient, toViemChain } from './chainClient';
import type { ContractWrite, TransactionSender } from './transaction';

/**
 * The operator: the one wallet this server signs with.
 *
 * Every write x402Go performs is sent by the operator — deploying a merchant's
 * vault, initially, and withdrawing from it later. The key behind it is the
 * most sensitive thing this backend holds, so the whole module is built around
 * one rule: the key enters from the environment, goes to viem, and is never
 * returned, logged, or attached to an error. Nothing outside this file ever
 * sees it, and nothing inside it puts it in a message.
 *
 * ## Why this is separate from `chainClient`
 *
 * `chainClient` is deliberately read-only — it has no account attached and
 * cannot sign. Keeping the signing client here rather than widening that one
 * means the read path stays something that provably cannot spend anything, and
 * the one module that can spend is small enough to audit in a sitting.
 *
 * ## What it adapts
 *
 * viem's wallet client is the implementation; `TransactionSender` is the
 * interface `executeTransaction` retries against. The adapter is the only place
 * the two meet, which is what lets the retry behaviour be tested by handing the
 * helper a stub instead of a key and a node.
 */

/**
 * A private key in the form viem accepts: `0x` and exactly 32 bytes.
 *
 * Checked here rather than left to `privateKeyToAccount`, because viem's own
 * failure message is not ours to guarantee and a key is a value that must never
 * be echoed back into an error. A key that fails this test is described only as
 * malformed.
 */
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

interface CachedOperator {
  /** The key the account was derived from, kept so a changed key re-derives. */
  readonly key: string;
  readonly account: PrivateKeyAccount;
}

let cached: CachedOperator | null = null;

/** Wallet clients are memoised per chain, exactly as the public clients are. */
const wallets = new Map<ChainKey, WalletClient>();

function operatorAccount(): PrivateKeyAccount {
  const key = process.env.OPERATOR_KEY;

  if (!key) {
    throw new VaultLifecycleError('operator-key-unusable', {
      details: { reason: 'OPERATOR_KEY is not set' },
    });
  }

  if (cached && cached.key === key) return cached.account;

  if (!PRIVATE_KEY_PATTERN.test(key)) {
    // Note what is *not* here: no `cause`, and the value itself is not in the
    // details. A malformed key is still a secret — it may be a correct key with
    // a typo, or a different secret pasted into the wrong variable — and an
    // error is the one object guaranteed to be printed.
    throw new VaultLifecycleError('operator-key-unusable', {
      details: { reason: 'OPERATOR_KEY is not a 0x-prefixed 32-byte hex string' },
    });
  }

  const account = privateKeyToAccount(key as `0x${string}`);
  cached = { key, account };

  // The clients hold the account they were built with, so a rotated key must
  // not leave a signer for the old one lying around.
  wallets.clear();

  return account;
}

function walletFor(chain: ChainKey): WalletClient {
  // Called first: it is what invalidates the cache when the key has changed.
  const account = operatorAccount();

  const existing = wallets.get(chain);

  if (existing) return existing;

  const client = createWalletClient({
    account,
    chain: toViemChain(chain),
    transport: http(),
  });

  wallets.set(chain, client);

  return client;
}

/**
 * The address the operator signs from, without revealing anything about how.
 *
 * This is the value a caller compares against `factory.operator()` to find out
 * whether this deployment is the one allowed to create and withdraw. The
 * comparison is a caller's job; returning a bare address is the whole point.
 */
export function getOperatorAddress(): Address {
  return operatorAccount().address;
}

/**
 * The operator as a `TransactionSender`, for one chain.
 *
 * Reads go through the memoised public client and writes through the memoised
 * wallet client for the same chain, so both halves of the vault lifecycle are
 * talking to one endpoint. The nonce is read with `pending`, which counts
 * transactions still in the mempool — reading `latest` would hand back a nonce
 * that is already spent, which is the failure `executeTransaction` exists to
 * recover from and should not be caused here.
 */
export function getTransactionSender(chain: ChainKey): TransactionSender {
  const account = operatorAccount();
  const wallet = walletFor(chain);
  const publicClient = getPublicClient(chain);
  // Built here rather than at module load so an RPC override set by a test (or
  // by the environment at boot) is the one the transaction is sent through.
  const viemChain = toViemChain(chain);

  return {
    account: account.address,
    chain,
    chainId: chainByKey(chain).chainId,

    pendingNonce: () =>
      publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),

    /**
     * Submits the call with the nonce the helper chose.
     *
     * viem simulates before it sends, so a call the contract would reject fails
     * here without spending gas — a much better outcome than a mined revert,
     * and the reason the helper treats a failed send as a revert rather than
     * assuming nothing happened.
     */
    send: (write: ContractWrite, nonce: number) =>
      wallet.writeContract({
        address: write.address,
        abi: write.abi,
        functionName: write.functionName,
        args: write.args,
        chain: viemChain,
        // Passed explicitly rather than left to the client, so the address this
        // sender reports and the account that signs are the same object by
        // construction.
        account,
        nonce,
      }),

    waitForReceipt: (hash) => publicClient.waitForTransactionReceipt({ hash }),

    getReceipt: async (hash) => {
      try {
        return await publicClient.getTransactionReceipt({ hash });
      } catch {
        // "Not mined yet" is not an error at this layer; it is the answer the
        // caller asked for and will retry.
        return null;
      }
    },
  };
}

/**
 * Forgets the derived account and every wallet client.
 *
 * Tests need this: a case that points `OPERATOR_KEY` at a throwaway key must
 * not be able to reach an account derived from the previous value.
 */
export function resetOperatorWallets(): void {
  cached = null;
  wallets.clear();
}
