import { getAddress, type Address, type Hex } from 'viem';
import { X402_VAULT_ABI } from '../abi';
import { chainByKey, type ChainKey } from '../config';
import { getPublicClient, type ChainClientProvider } from '../utils/chainClient';
import type { ContractWrite } from '../utils/transaction';

/**
 * Reads of a single X402Vault, plus the transaction shapes for the writes that
 * belong to a later step.
 *
 * Everything here is a read or the *preparation* of a write. No method signs or
 * sends anything: the operator key exists in the environment, but wiring it to
 * a route is the withdrawal flow, which is explicitly out of scope for this
 * step. What is provided is the request a signer would complete.
 */

/** What a vault says about itself. */
export interface VaultConfig {
  readonly chain: ChainKey;
  readonly address: Address;
  /** The merchant the vault was created for. Also the `changePayout` signer. */
  readonly merchant: Address;
  /** Where the merchant's share is sent. Defaults to `merchant` until changed. */
  readonly payout: Address;
  /** Replay counter for `changePayout`. */
  readonly nonce: bigint;
}

export class VaultService {
  private readonly clients: ChainClientProvider;

  constructor(clients: ChainClientProvider = getPublicClient) {
    this.clients = clients;
  }

  /**
   * Whether a contract actually exists at this address.
   *
   * The only honest way to answer "is this vault deployed". Neither the
   * presence of a stored address nor its being non-zero says anything about
   * deployment: a deterministic address is a real, correct address from the
   * moment it is computed, and it stays empty until someone deploys there. The
   * dashboard tells the merchant which of the two states they are in, so a
   * guess here would show a merchant a vault that does not exist.
   *
   * Note the reverse is not proven: code at the address means *something* is
   * deployed, and the factory's `createVault` is the only path that can deploy
   * at a merchant's deterministic address, but this check alone does not
   * confirm the code is an X402Vault clone.
   */
  public async isDeployed(chain: ChainKey, address: Address): Promise<boolean> {
    const client = this.clients(chain);
    const code = await client.getCode({ address });

    return Boolean(code && code !== '0x');
  }

  /**
   * The vault's own view of itself, read in one batched round trip.
   *
   * Three independent reads, so they are sent together rather than in sequence;
   * on a vault that does not exist yet every one of them returns empty data and
   * viem raises a decode error, which is why callers check `isDeployed` first.
   */
  public async readConfig(chain: ChainKey, address: Address): Promise<VaultConfig> {
    const client = this.clients(chain);

    const [merchant, payout, nonce] = await Promise.all([
      client.readContract({
        address,
        abi: X402_VAULT_ABI,
        functionName: 'merchant',
      }),
      client.readContract({
        address,
        abi: X402_VAULT_ABI,
        functionName: 'payout',
      }),
      client.readContract({
        address,
        abi: X402_VAULT_ABI,
        functionName: 'nonce',
      }),
    ]);

    return {
      chain,
      address: getAddress(address),
      merchant: getAddress(merchant),
      payout: getAddress(payout),
      nonce,
    };
  }

  /** The vault's balance of one token — the figure a withdrawal is sized against. */
  public async tokenBalance(
    chain: ChainKey,
    address: Address,
    token: Address,
  ): Promise<bigint> {
    const client = this.clients(chain);

    return client.readContract({
      address,
      abi: X402_VAULT_ABI,
      functionName: 'tokenBalance',
      args: [token],
    });
  }

  /**
   * The vault address as `payTo`, for the x402 challenge a merchant's API
   * returns. Convenience over the config so callers do not re-derive the shape.
   */
  public explorerUrl(chain: ChainKey, address: Address): string {
    return `${chainByKey(chain).explorerUrl}/address/${address}`;
  }

  /**
   * A `withdraw` transaction for a signer to complete.
   *
   * Amounts are `bigint` — base units of each token, never a decimal. The
   * three arrays must stay the same length; the contract rejects a mismatch,
   * but a caller assembling them from separate sources is where that mistake
   * would come from, so the lengths are checked here too rather than paying a
   * gas fee to be told.
   *
   * `msg.sender` is the factory's operator, and both legs — the merchant's
   * share and the fee — move in this one call. There is no partial withdrawal
   * to fall back on, so the amounts are the whole decision.
   */
  public buildWithdrawRequest(
    chain: ChainKey,
    vault: Address,
    tokens: readonly Address[],
    merchantAmounts: readonly bigint[],
    feeAmounts: readonly bigint[],
  ): ContractWrite {
    if (tokens.length !== merchantAmounts.length || tokens.length !== feeAmounts.length) {
      throw new Error(
        `withdraw arrays must be the same length: ${tokens.length} tokens, ` +
          `${merchantAmounts.length} merchant amounts, ${feeAmounts.length} fee amounts`,
      );
    }

    return {
      address: getAddress(vault),
      abi: X402_VAULT_ABI,
      functionName: 'withdraw',
      args: [tokens, merchantAmounts, feeAmounts] as const,
    };
  }

  /**
   * A `changePayout` transaction for a signer to complete.
   *
   * The signature is produced by the *merchant's* wallet, off chain, over the
   * EIP-712 digest for this vault at its current nonce — the payout wallet does
   * not sign and cannot move its own destination. This builder only assembles
   * the call the merchant's signature authorises; producing the signature needs
   * the merchant's key and never happens here.
   */
  public buildChangePayoutRequest(
    chain: ChainKey,
    vault: Address,
    newPayout: Address,
    deadline: bigint,
    signature: Hex,
  ): ContractWrite {
    return {
      address: getAddress(vault),
      abi: X402_VAULT_ABI,
      functionName: 'changePayout',
      args: [newPayout, deadline, signature] as const,
    };
  }
}

export default VaultService;
