import { getAddress, type Address } from 'viem';
import { X402_VAULT_FACTORY_ABI } from '../abi';
import { chainByKey, type ChainKey } from '../config';
import { getPublicClient, type ChainClientProvider } from '../utils/chainClient';
import type { ContractWrite } from '../utils/transaction';
import { predictVaultAddress, sameAddress } from '../utils/vaultAddress';

/**
 * Reads of the X402VaultFactory, and the deterministic address it hands out.
 *
 * The factory is the authority on where a merchant's vault lives. Everything
 * this service computes locally is a convenience that lets the backend answer
 * without a round trip; `vaultOf` is what the answer is checked against, and
 * `reconcile` is the check.
 */

/**
 * Where a vault address came from.
 *
 * Worth carrying rather than collapsing into a bare address: the two sources
 * mean different things to a caller. `factory` is what the chain says and can
 * be trusted for anything that moves value. `predicted` is this process's own
 * arithmetic, which is right unless the config is wrong — the state a
 * deployment wants to know about rather than paper over.
 */
export type VaultAddressSource = 'factory' | 'predicted';

export interface VaultAddressResolution {
  readonly chain: ChainKey;
  readonly address: Address;
  readonly source: VaultAddressSource;
}

/** A disagreement between the address on record and the factory's answer. */
export interface VaultAddressMismatch {
  readonly chain: ChainKey;
  readonly merchant: Address;
  /** What the factory (or local derivation) says the address is. */
  readonly expected: Address;
  /** What is currently stored. */
  readonly stored: string;
}

export type ReconcileResult =
  | { readonly ok: true; readonly address: Address }
  | { readonly ok: false; readonly mismatch: VaultAddressMismatch };

export class VaultFactoryService {
  private readonly clients: ChainClientProvider;

  constructor(clients: ChainClientProvider = getPublicClient) {
    this.clients = clients;
  }

  /**
   * The vault address for a merchant, computed without touching the network.
   *
   * Pure and synchronous, which is what makes it usable on a request path: the
   * dashboard can show a merchant their `payTo` address with the database as
   * the only dependency. It is *not* the authority — see `vaultOf`.
   */
  public predict(chain: ChainKey, merchant: Address): Address {
    const { factory, vaultImplementation } = chainByKey(chain).contracts;

    return predictVaultAddress(factory, vaultImplementation, merchant);
  }

  /**
   * The vault address according to the factory itself.
   *
   * The authoritative read. Works whether or not the vault has been deployed —
   * `vaultOf` is a pure computation on chain, so it answers for a vault that
   * does not exist yet, which is exactly the case this project cares about.
   *
   * Throws if the RPC call fails. That is deliberate: an unreachable node is
   * not an answer, and a caller that needs this value must decide for itself
   * whether to fall back to `predict`.
   */
  public async vaultOf(chain: ChainKey, merchant: Address): Promise<Address> {
    const client = this.clients(chain);
    const { factory } = chainByKey(chain).contracts;

    const address = await client.readContract({
      address: factory,
      abi: X402_VAULT_FACTORY_ABI,
      functionName: 'vaultOf',
      args: [merchant],
    });

    return getAddress(address);
  }

  /**
   * The vault address, with the factory preferred and local derivation as the
   * fallback.
   *
   * The fallback is not a failure path — a sign-in should not be blocked by a
   * rate-limited public RPC, and the local answer is the same value. It is
   * reported in `source` so that anything that must not act on an unverified
   * address can refuse it.
   */
  public async resolve(chain: ChainKey, merchant: Address): Promise<VaultAddressResolution> {
    try {
      return { chain, address: await this.vaultOf(chain, merchant), source: 'factory' };
    } catch {
      return { chain, address: this.predict(chain, merchant), source: 'predicted' };
    }
  }

  /**
   * Checks a stored address against the factory's own answer.
   *
   * Requirement of the data model: the stored copy is a cache, never an
   * authority. If the two disagree the stored value is wrong — a config change,
   * a migration, or a hand-edited document — and the caller is expected to
   * treat it as an error and correct from `expected` rather than serve it. A
   * vault address that the factory does not agree with is an address where no
   * vault exists and where payments sent would be lost.
   *
   * Falls back to the local derivation when the factory is unreachable, so a
   * transient RPC failure does not present itself as a data inconsistency.
   */
  public async reconcile(
    chain: ChainKey,
    merchant: Address,
    stored: string,
  ): Promise<ReconcileResult> {
    const resolution = await this.resolve(chain, merchant);

    if (!sameAddress(resolution.address, stored)) {
      return {
        ok: false,
        mismatch: { chain, merchant, expected: resolution.address, stored },
      };
    }

    return { ok: true, address: resolution.address };
  }

  /**
   * The implementation every vault on this chain delegates to.
   *
   * Read from the factory rather than from config so a factory redeployed with
   * a new implementation is picked up without a code change to this service —
   * the configured address is only a fallback for when the node is unreachable.
   */
  public async implementation(chain: ChainKey): Promise<Address> {
    const client = this.clients(chain);
    const { factory } = chainByKey(chain).contracts;

    const address = await client.readContract({
      address: factory,
      abi: X402_VAULT_FACTORY_ABI,
      functionName: 'implementation',
    });

    return getAddress(address);
  }

  /**
   * The current x402Go operator — the wallet allowed to withdraw from vaults.
   *
   * Read live because it is rotatable. Nothing should cache it: a rotated
   * operator takes effect across every vault at once, and a stale copy would
   * describe a wallet that no longer has authority.
   */
  public async operator(chain: ChainKey): Promise<Address> {
    const client = this.clients(chain);
    const { factory } = chainByKey(chain).contracts;

    const address = await client.readContract({
      address: factory,
      abi: X402_VAULT_FACTORY_ABI,
      functionName: 'operator',
    });

    return getAddress(address);
  }

  /** The owner — the recovery authority that may rotate the operator. */
  public async owner(chain: ChainKey): Promise<Address> {
    const client = this.clients(chain);
    const { factory } = chainByKey(chain).contracts;

    const address = await client.readContract({
      address: factory,
      abi: X402_VAULT_FACTORY_ABI,
      functionName: 'owner',
    });

    return getAddress(address);
  }

  /**
   * A transaction request that deploys a merchant's vault, for a signer to
   * complete. Nothing here signs or sends it.
   *
   * Deploying and initialising the payout are one call, not two: the factory
   * runs `initPayout` itself, inside `createVault`, and only when the payout
   * differs from the merchant. There is no way for the backend to initialise a
   * payout afterwards — `X402Vault.initPayout` refuses any caller but the
   * factory, and the factory will not create the same vault twice. So `payout`
   * here is not a hint: it is the value the vault will hold.
   */
  public buildCreateVaultRequest(
    chain: ChainKey,
    merchant: Address,
    payout: Address,
  ): ContractWrite {
    const { factory } = chainByKey(chain).contracts;

    return {
      address: factory,
      abi: X402_VAULT_FACTORY_ABI,
      functionName: 'createVault',
      args: [merchant, payout] as const,
    };
  }
}

export default VaultFactoryService;
