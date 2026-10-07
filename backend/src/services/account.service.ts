import { getAddress, isAddress, type Address } from 'viem';
import { CHAIN_KEYS, chainByKey, type ChainKey } from '../config';
import userModel from '../models/users.model';
import VaultFactoryService from './vaultFactory.service';
import VaultService from './vault.service';

/**
 * The authenticated merchant's account: who they are, and where their vaults
 * are.
 *
 * Two operations, with different jobs:
 *
 * - `ensureVaults` derives and records the merchant's deterministic vault
 *   address on every supported chain. It runs at sign-in, touches no chain, and
 *   deploys nothing.
 * - `getAccount` reads that record back and adds the one thing the record
 *   cannot know — whether each vault has actually been deployed, which is a
 *   fact about the chain and is read from it.
 */

/** A vault as the dashboard sees it. */
export interface AccountVault {
  /** The chain key: `celo`, `celoSepolia`. Stable, and what a write is keyed by. */
  readonly network: ChainKey;
  /** Human-readable network name, so the UI does not map keys to labels itself. */
  readonly networkName: string;
  readonly chainId: number;
  /** The deterministic vault address (the merchant's `payTo`), lowercased. */
  readonly address: string;
  /**
   * Whether a contract exists at that address *right now*.
   *
   * A separate fact from the address itself: the address is correct and final
   * from the moment it is derived, while this is false until something deploys
   * there. A caller that treats a correct address as a deployed vault will show
   * a merchant funds that are not there.
   *
   * `null` when the chain could not be reached, which is a third state and not
   * a synonym for false: "not deployed" is a fact about the vault, and
   * reporting it because a node timed out would be inventing one. The UI has
   * something different to say for each.
   */
  readonly deployed: boolean | null;
  /** Block-explorer link, so the UI does not build URLs from chain ids. */
  readonly explorerUrl: string;
}

export interface AccountView {
  /** The merchant's wallet address, as authenticated. */
  readonly address: string;
  readonly vaults: readonly AccountVault[];
}

export type AccountOutcome =
  | { readonly status: 'ok'; readonly account: AccountView }
  | { readonly status: 'no-account' };

/** A stored vault address that does not match what the factory derives. */
interface AddressRepair {
  readonly network: ChainKey;
  readonly stored: string;
  readonly expected: string;
}

export class AccountService {
  private readonly users = userModel;
  private readonly factory: VaultFactoryService;
  private readonly vaults: VaultService;

  constructor(
    factory: VaultFactoryService = new VaultFactoryService(),
    vaults: VaultService = new VaultService(),
  ) {
    this.factory = factory;
    this.vaults = vaults;
  }

  /**
   * Derives the merchant's vault address on every supported chain and records
   * any that are missing.
   *
   * Idempotent in the sense that matters: an address already on record is left
   * exactly as it is, including its `createdAt`. A merchant who signs in a
   * thousand times ends up with one entry per chain, written once. The address
   * is a pure function of the merchant and the factory, so recomputing it
   * cannot produce a different answer — re-writing it would only churn the
   * document.
   *
   * This deploys nothing, on purpose. A vault is deployed when an operation
   * needs one, not because its owner looked at a dashboard: deploying at
   * sign-in would spend the operator's gas on every wallet that ever connected,
   * and would create vaults for merchants who never take a payment.
   *
   * Returns the addresses it derived, so the caller can use them without a
   * second read.
   */
  public async ensureVaults(userId: string, merchantAddress: string): Promise<void> {
    const user = await this.users.findById(userId).select('address vaults');

    if (!user) return;

    const merchant = this.merchantAddress(user.address || merchantAddress);

    if (!merchant) return;

    // Only the chains with nothing on record, as dot-paths, so a single write
    // covers every gap and no existing entry is touched.
    const missing: Record<string, IVault> = {};

    for (const key of CHAIN_KEYS) {
      if (user.vaults?.get(key)?.address) continue;

      missing[`vaults.${key}`] = {
        address: this.derive(key, merchant),
        chainId: chainByKey(key).chainId,
        createdAt: new Date(),
      };
    }

    if (Object.keys(missing).length === 0) return;

    await this.users.updateOne({ _id: userId }, { $set: missing });
  }

  /**
   * The account, with each vault's current deployment state.
   *
   * The stored addresses are checked against the factory's derivation before
   * they are served. They are the same value by construction, so a difference
   * means something is wrong — the chain configuration changed under a
   * deployment, or a document was edited — and the stored value is the one
   * that is wrong. It is corrected from the derivation rather than returned:
   * an address the factory does not agree with is an address where no vault
   * exists, and paying a merchant's customers to it would lose their money.
   */
  public async getAccount(userId: string): Promise<AccountOutcome> {
    const user = await this.users.findById(userId).select('address vaults');

    if (!user) return { status: 'no-account' };

    const merchant = this.merchantAddress(user.address);

    if (!merchant) return { status: 'no-account' };

    // Derive every chain up front: pure, and it doubles as the value each
    // stored address is checked against.
    const derived = CHAIN_KEYS.map((key) => ({ key, address: this.derive(key, merchant) }));

    const repairs: AddressRepair[] = [];

    for (const { key, address } of derived) {
      const stored = user.vaults?.get(key)?.address;

      if (stored && stored.toLowerCase() !== address) {
        repairs.push({ network: key, stored, expected: address });
      }
    }

    if (repairs.length > 0) {
      await this.repair(userId, repairs);
    }

    // One round trip per chain, in parallel. Neither a stored address nor a
    // non-zero one says anything about deployment — only the chain does.
    //
    // A chain that cannot be reached yields `null` rather than failing the
    // whole read: the vault addresses are the part a merchant is here for, and
    // they are known without the chain. The deployment flag degrades to
    // "unknown" on its own.
    const deployments = await Promise.all(
      derived.map(async ({ key, address }) => ({
        key,
        address,
        deployed: await this.deploymentStatus(key, address as Address),
      })),
    );

    return {
      status: 'ok',
      account: {
        address: merchant.toLowerCase(),
        vaults: deployments.map(({ key, address, deployed }) => ({
          network: key,
          networkName: chainByKey(key).name,
          chainId: chainByKey(key).chainId,
          address,
          deployed,
          explorerUrl: this.vaults.explorerUrl(key, address as Address),
        })),
      },
    };
  }

  /**
   * The merchant's vault address on one chain, as recorded — deriving and
   * recording it first if this account has never been through sign-in.
   *
   * What the rest of the system should call when it needs a `payTo` address.
   */
  public async vaultAddressFor(
    userId: string,
    chain: ChainKey = 'celo',
  ): Promise<string | null> {
    const user = await this.users.findById(userId).select('address vaults');

    if (!user) return null;

    const merchant = this.merchantAddress(user.address);

    if (!merchant) return null;

    const stored = user.vaults?.get(chain)?.address;

    if (stored) return stored;

    const derived = this.derive(chain, merchant);

    await this.users.updateOne(
      { _id: userId },
      {
        $set: {
          [`vaults.${chain}`]: {
            address: derived,
            chainId: chainByKey(chain).chainId,
            createdAt: new Date(),
          },
        },
      },
    );

    return derived;
  }

  /**
   * Replaces stored addresses that disagree with the derivation, and says so.
   *
   * Logged rather than thrown: by the time this is reached the authoritative
   * value is already known, so failing the request would withhold a correct
   * answer in order to report a problem it can fix. The log is the record that
   * it happened, and a persistent stream of them means the configuration is
   * wrong rather than a document.
   */
  private async repair(userId: string, repairs: readonly AddressRepair[]): Promise<void> {
    const update: Record<string, IVault> = {};

    for (const item of repairs) {
      console.warn(
        `[account] stored vault address for ${item.network} did not match the ` +
          `factory derivation (stored ${item.stored}, expected ${item.expected}); ` +
          'correcting the stored value',
      );

      update[`vaults.${item.network}`] = {
        address: item.expected,
        chainId: chainByKey(item.network).chainId,
        createdAt: new Date(),
      };
    }

    await this.users.updateOne({ _id: userId }, { $set: update });
  }

  /** The deterministic address, lowercased to match how addresses are stored. */
  private derive(chain: ChainKey, merchant: Address): string {
    return this.factory.predict(chain, merchant).toLowerCase();
  }

  /**
   * The deployment flag, with an unreachable chain folded into `null`.
   *
   * The failure is logged because a persistent one means the dashboard is
   * showing an unknown state forever, which is worth noticing — but it is not
   * worth failing the request over.
   */
  private async deploymentStatus(
    chain: ChainKey,
    address: Address,
  ): Promise<boolean | null> {
    try {
      return await this.vaults.isDeployed(chain, address);
    } catch (error) {
      console.warn(
        `[account] could not read deployment status for the ${chain} vault at ` +
          `${address}; reporting it as unknown`,
        error,
      );

      return null;
    }
  }

  /**
   * Normalises a stored wallet address for use as a vault key.
   *
   * Returns `null` rather than throwing for anything that is not an address:
   * this reads a document that may predate validation, and a malformed one
   * should leave the account without a vault rather than fail the request.
   */
  private merchantAddress(value: string | undefined): Address | null {
    if (!value || !isAddress(value)) return null;

    return getAddress(value);
  }
}

export default AccountService;
