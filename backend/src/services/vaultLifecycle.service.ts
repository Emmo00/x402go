import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { chainByKey, CHAINS, type ChainKey } from '../config';
import { VaultLifecycleError } from '../exceptions/VaultLifecycleError';
import userModel from '../models/users.model';
import { getTransactionSender } from '../utils/operatorWallet';
import {
  executeTransaction,
  type ContractWrite,
  type TransactionOutcome,
  type TransactionSender,
} from '../utils/transaction';
import { sameAddress } from '../utils/vaultAddress';
import { vaultLockKey, withLock } from './lock.service';
import VaultFactoryService from './vaultFactory.service';
import VaultService, { type VaultConfig } from './vault.service';

/**
 * The merchant vault lifecycle: an address that exists, a contract that
 * eventually does, and the operator transaction that closes the gap.
 *
 * ## The shape of the thing
 *
 * A merchant's vault address is computed, not deployed. It is final from the
 * moment the factory answers `vaultOf(merchant)`, it can receive ERC-20
 * transfers while it is still empty, and nothing about showing it to a merchant
 * requires a contract to exist. Deploying at sign-in would spend the operator's
 * gas on every wallet that ever connected, including the ones that never take a
 * payment — so sign-in records the address and stops there.
 *
 * What follows is that "known address" and "deployed vault" are different
 * facts, and the second one has to be deferred until something needs it. That
 * something is an operation that moves value: a withdrawal, or initialising or
 * changing a payout wallet. Those are the only entry points to this service,
 * and they are the reason it exists.
 *
 * ## Deploying and initialising the payout are one transaction
 *
 * `X402VaultFactory.createVault(merchant, payout)` clones the vault and, when
 * `payout` differs from `merchant`, calls `initPayout` on it before returning.
 * There is no second step to perform later:
 *
 * - `X402Vault.initPayout` reverts `Unauthorized` for any caller who is not the
 *   factory, so this backend can never call it directly.
 * - It is one-shot — a second call reverts `AlreadyInitialized` — and the
 *   factory will not create the vault twice, reverting `VaultExists` first.
 *
 * So a payout configured before the vault exists is not a preference to apply
 * afterwards; it is an argument to the only call that will ever be able to set
 * it. That is why `ensureVaultPayoutInitialized` deploys, then *verifies*,
 * rather than deploying and then initialising.
 *
 * ## Nothing here is the authority
 *
 * The factory decides the address, the chain decides whether code is there, and
 * the vault decides what its payout is. This service reads all three and
 * refuses to proceed when they disagree with what it was asked to do — see
 * `payout-mismatch` and `vault-address-mismatch`. When it cannot reconcile, it
 * fails; it never quietly proceeds with a value it did not expect.
 */

/**
 * How long a holder may keep the vault lock before another caller takes over.
 *
 * Sized to outlast the receipt wait for a deployment — a Celo block is a few
 * seconds, but a rate-limited public RPC can stall for much longer — because
 * the lock expiring mid-deployment is not dangerous, only wasteful: the second
 * caller re-checks the chain, sees the vault, and adopts it.
 */
const VAULT_LOCK_TTL_MS = 120_000;

/** How long a second caller waits for an in-progress operation before giving up. */
const VAULT_LOCK_WAIT_MS = 45_000;

/** What a deployment did, or found already done. */
export interface VaultDeployment {
  readonly chain: ChainKey;
  readonly merchant: Address;
  /** The deterministic address — the same value before and after deployment. */
  readonly address: Address;
  /**
   * Whether the transaction sent by *this* call is the one that deployed it.
   *
   * False when the vault was already there, including when a concurrent caller
   * deployed it while this one waited. Both are successes; the distinction
   * exists for what gets recorded and reported, not for the caller's control
   * flow.
   */
  readonly deployedByUs: boolean;
  /** The deployment transaction this call sent, if it sent one. */
  readonly transactionHash: Hex | null;
}

/** A vault that exists and is configured the way the caller required. */
export interface VaultReadiness extends VaultDeployment {
  /** The vault's payout recipient, as read from the vault itself. */
  readonly payout: Address;
  /** The vault's `changePayout` replay counter, read at the same moment. */
  readonly payoutNonce: bigint;
}

/** Reads the current deployment of a vault. */
export type SenderFactory = (chain: ChainKey) => TransactionSender;

export class VaultLifecycleService {
  private readonly factory: VaultFactoryService;
  private readonly vaults: VaultService;
  private readonly users = userModel;
  private readonly senderFor: SenderFactory;

  constructor(
    factory: VaultFactoryService = new VaultFactoryService(),
    vaults: VaultService = new VaultService(),
    senderFor: SenderFactory = getTransactionSender,
  ) {
    this.factory = factory;
    this.vaults = vaults;
    this.senderFor = senderFor;
  }

  /* ---------------------------------------------------------------------- */
  /* Address and deployment state                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * The merchant's vault address, according to the factory.
   *
   * `vaultOf` is the source of truth and works whether or not the vault has
   * been deployed, so this is answerable from the first moment a merchant
   * exists. The local derivation in `utils/vaultAddress` is deliberately not
   * consulted: it is a convenience for the read path that must answer without a
   * network, and an operation that will move value is not the place to prefer
   * this process's arithmetic over the contract's.
   *
   * The stored address is checked against the factory's answer, and a
   * disagreement is an error rather than something to paper over. The two are
   * equal by construction, so a difference means the chain configuration
   * changed under a running deployment or a document was edited by hand — and
   * until a human works out which, the address on record is an address this
   * service cannot vouch for. Note that the account endpoint makes the opposite
   * choice and repairs the record silently: it is answering a dashboard read
   * where a correct address is the whole answer, while this is about to send
   * funds to one.
   */
  public async getVaultAddress(chain: ChainKey, merchant: Address): Promise<Address> {
    const address = this.validateMerchant(merchant);

    this.chainConfig(chain);

    const authoritative = await this.vaultOf(chain, address);
    const stored = await this.storedVaultAddress(chain, address);

    if (stored && !sameAddress(stored, authoritative)) {
      throw new VaultLifecycleError('vault-address-mismatch', {
        details: { chain, merchant: address, stored, expected: authoritative },
      });
    }

    return authoritative;
  }

  /**
   * Whether a contract exists at this address, right now.
   *
   * The only honest way to answer it. A stored address is not evidence — it is
   * a correct address from the moment it is derived — and neither is a
   * non-zero one. A chain that cannot be reached throws rather than answering
   * `false`: "not deployed" is a fact about the vault, and inventing it because
   * a node timed out is how a caller ends up deploying a second vault or
   * reporting a merchant's funds as missing.
   */
  public async isVaultDeployed(chain: ChainKey, address: Address): Promise<boolean> {
    this.chainConfig(chain);

    try {
      return await this.vaults.isDeployed(chain, address);
    } catch (error) {
      throw new VaultLifecycleError('chain-unreachable', {
        details: { chain, address },
        cause: error,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Lazy deployment                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Makes sure a vault exists at the merchant's deterministic address.
   *
   * Idempotent, and safe to call on every request that needs a contract: an
   * already-deployed vault costs one `eth_getCode` and no transaction. When one
   * does have to be deployed, the operator sends it — this backend's own wallet,
   * never a merchant's, and never with a key that leaves this process.
   *
   * `payout` is where the vault's funds will be sent. Omitting it uses the
   * account's stored payout, falling back to the merchant's own address, which
   * is the value the vault's `payout()` reports when nothing has been
   * initialised. Because the factory sets the payout in the same call that
   * creates the vault, this argument is the only chance to choose it: whatever
   * is passed here is what the vault will hold.
   *
   * Everything below the fast path runs under a lock keyed by merchant and
   * chain, so two requests that both find an empty address do not both deploy.
   * The lock is an optimisation — the factory's `VaultExists` revert makes a
   * double deployment impossible anyway — but it means the loser of a race
   * usually adopts the winner's vault instead of paying for a revert.
   */
  public async ensureVaultDeployed(
    chain: ChainKey,
    merchant: Address,
    payout?: Address,
  ): Promise<VaultDeployment> {
    const merchantAddress = this.validateMerchant(merchant);

    this.chainConfig(chain);

    const address = await this.getVaultAddress(chain, merchantAddress);
    const expectedPayout = await this.resolvePayout(merchantAddress, payout);

    // The common case for a live vault, and the reason this is cheap to call
    // defensively: one code check, no lock, no transaction.
    if (await this.isVaultDeployed(chain, address)) {
      return { chain, merchant: merchantAddress, address, deployedByUs: false, transactionHash: null };
    }

    return withLock(
      vaultLockKey(chain, merchantAddress),
      () => this.deploy(chain, merchantAddress, address, expectedPayout),
      { ttlMs: VAULT_LOCK_TTL_MS, waitMs: VAULT_LOCK_WAIT_MS },
    );
  }

  /**
   * Makes sure a vault exists *and* its payout is the expected one.
   *
   * The entry point for anything that is about to move value out of a vault.
   * It deploys when it has to, which is also when the payout gets set, and then
   * reads the vault back and compares.
   *
   * The comparison is not a formality. A merchant's payout can legitimately
   * differ from the address on record — a `changePayout` signed by the merchant
   * moves it and the account record is not updated by that path — so a
   * disagreement here means one of two things, and this service cannot tell
   * which: the record is stale, or the vault has been pointed somewhere the
   * merchant did not intend. Neither is safe to withdraw through, so the answer
   * is the same for both: stop, and require reconciliation. Silently paying the
   * on-chain address would hide a hijack; silently paying the record would
   * ignore the merchant's own signed instruction.
   */
  public async ensureVaultPayoutInitialized(
    chain: ChainKey,
    merchant: Address,
    payout?: Address,
  ): Promise<VaultReadiness> {
    const merchantAddress = this.validateMerchant(merchant);

    const expectedPayout = await this.resolvePayout(merchantAddress, payout);
    const deployment = await this.ensureVaultDeployed(chain, merchantAddress, expectedPayout);
    const config = await this.readConfig(chain, deployment.address);

    if (!sameAddress(config.merchant, merchantAddress)) {
      throw new VaultLifecycleError('merchant-mismatch', {
        details: {
          chain,
          address: deployment.address,
          expected: merchantAddress,
          actual: config.merchant,
        },
      });
    }

    if (!sameAddress(config.payout, expectedPayout)) {
      throw new VaultLifecycleError('payout-mismatch', {
        details: {
          chain,
          address: deployment.address,
          expected: expectedPayout,
          actual: config.payout,
        },
      });
    }

    return {
      ...deployment,
      payout: config.payout,
      payoutNonce: config.nonce,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Deploys the vault. Runs only while holding the lock.
   *
   * Deployment state is re-read as the first thing here rather than trusted
   * from the caller's check: between that check and this point, another request
   * — in this process or another one entirely — may have finished. This is the
   * re-check that makes the lock's absence survivable, so it is not an
   * optimisation to skip.
   */
  private async deploy(
    chain: ChainKey,
    merchant: Address,
    address: Address,
    payout: Address,
  ): Promise<VaultDeployment> {
    if (await this.isVaultDeployed(chain, address)) {
      return { chain, merchant, address, deployedByUs: false, transactionHash: null };
    }

    const sender = this.senderFor(chain);

    await this.assertOperator(chain, sender.account);

    const write = this.factory.buildCreateVaultRequest(chain, merchant, payout);

    const outcome = await executeTransaction(sender, write, {
      // Checked before any retry, and after any failure that leaves the
      // transaction's fate unclear. A vault that exists is the postcondition,
      // whoever produced it — including a previous attempt of our own that the
      // node reported ambiguously.
      isSettled: () => this.isVaultDeployed(chain, address),
    });

    if (outcome.status === 'reverted') {
      throw new VaultLifecycleError('deployment-reverted', {
        details: { chain, address, hash: outcome.hash, nonce: outcome.nonce },
      });
    }

    const deployment = await this.verifyDeployment(chain, merchant, address, payout);

    this.recordDeployment(chain, merchant, outcome).catch((error) => {
      console.warn('[vault] could not record deployment metadata', chain, merchant, error);
    });

    return {
      ...deployment,
      deployedByUs: outcome.status === 'confirmed',
      transactionHash: outcome.hash,
    };
  }

  /**
   * Confirms the deployment actually produced the vault that was asked for.
   *
   * A successful receipt is not enough. It says the transaction was mined and
   * did not revert; it does not say code is at the predicted address, and it
   * says nothing about what the vault was initialised with. So the bytecode is
   * checked, and then the vault itself is asked who it belongs to and where it
   * pays out — a mismatch here would mean funds are about to be routed
   * somewhere the backend did not intend, which is worth failing loudly for.
   */
  private async verifyDeployment(
    chain: ChainKey,
    merchant: Address,
    address: Address,
    payout: Address,
  ): Promise<Omit<VaultDeployment, 'deployedByUs' | 'transactionHash'>> {
    if (!(await this.isVaultDeployed(chain, address))) {
      throw new VaultLifecycleError('deployment-not-confirmed', {
        details: { chain, address, merchant },
      });
    }

    const config = await this.readConfig(chain, address);

    if (!sameAddress(config.merchant, merchant)) {
      throw new VaultLifecycleError('merchant-mismatch', {
        details: { chain, address, expected: merchant, actual: config.merchant },
      });
    }

    if (!sameAddress(config.payout, payout)) {
      throw new VaultLifecycleError('payout-mismatch', {
        details: { chain, address, expected: payout, actual: config.payout },
      });
    }

    return { chain, merchant, address };
  }

  /**
   * Reads the vault's own view of itself, with an unreachable chain reported as
   * such rather than as a decode error.
   */
  private async readConfig(chain: ChainKey, address: Address): Promise<VaultConfig> {
    try {
      return await this.vaults.readConfig(chain, address);
    } catch (error) {
      throw new VaultLifecycleError('chain-unreachable', {
        details: { chain, address },
        cause: error,
      });
    }
  }

  /**
   * Refuses to sign with a wallet the factory does not recognise as operator.
   *
   * One read, before anything is sent, and the reason is the failure it
   * prevents: `createVault` from an unauthorised sender reverts `Unauthorized`,
   * and a revert still costs the gas of the attempt. Worse, it would look like
   * a transient deployment failure and be retried. A rotated operator, or an
   * `OPERATOR_KEY` from the wrong environment, is a configuration mistake, and
   * it should read as one.
   */
  private async assertOperator(chain: ChainKey, account: Address): Promise<void> {
    let expected: Address;

    try {
      expected = await this.factory.operator(chain);
    } catch (error) {
      throw new VaultLifecycleError('factory-unreachable', {
        details: { chain },
        cause: error,
      });
    }

    if (!sameAddress(expected, account)) {
      throw new VaultLifecycleError('operator-mismatch', {
        details: { chain, expected, actual: account },
      });
    }
  }

  /** The factory's answer for a merchant, with an unreachable node reported as such. */
  private async vaultOf(chain: ChainKey, merchant: Address): Promise<Address> {
    try {
      return await this.factory.vaultOf(chain, merchant);
    } catch (error) {
      throw new VaultLifecycleError('factory-unreachable', {
        details: { chain, merchant },
        cause: error,
      });
    }
  }

  /**
   * Where a vault for this merchant should pay out.
   *
   * An explicit address wins. Otherwise the account's stored payout is used,
   * and if there is none the merchant's own address is — which is what the
   * vault reports from `payout()` when nothing has been initialised, because
   * `initPayout` only runs when the payout differs from the merchant.
   *
   * The stored value is validated rather than passed through: it is written by
   * an earlier request, and a malformed address that reached the database
   * should fail here, as a validation error the caller can see, rather than be
   * baked into a vault that can never be fixed.
   */
  private async resolvePayout(merchant: Address, explicit?: Address): Promise<Address> {
    if (explicit !== undefined) {
      if (!isAddress(explicit)) {
        throw new VaultLifecycleError('invalid-payout', { details: { payout: explicit } });
      }

      return getAddress(explicit);
    }

    const user = await this.users.findOne({ address: merchant.toLowerCase() }).select('payTo');
    const stored = user?.payTo;

    if (!stored) return merchant;

    if (!isAddress(stored)) {
      throw new VaultLifecycleError('invalid-payout', { details: { payout: stored } });
    }

    return getAddress(stored);
  }

  /** The address on record for a merchant on one chain, if there is one. */
  private async storedVaultAddress(chain: ChainKey, merchant: Address): Promise<string | null> {
    const user = await this.users.findOne({ address: merchant.toLowerCase() }).select('vaults');

    return user?.vaults?.get(chain)?.address ?? null;
  }

  /**
   * Caches the deployment on the account record. Best effort, always.
   *
   * The chain is the authority on whether the vault exists, so this is
   * indexing information rather than state: it is here so a support question
   * can be answered without a block-explorer search, and its absence changes
   * nothing about how the vault lifecycle behaves. That is why it is written
   * after the deployment is already verified, why a failure only logs, and why
   * it is skipped entirely for a `'reverted'` outcome — there is no deployment
   * to record.
   *
   * Only an account that already has a vault record is updated. The dot-paths
   * would otherwise create a partial subdocument with no `address`, which is a
   * record claiming a vault was deployed at nowhere.
   */
  private async recordDeployment(
    chain: ChainKey,
    merchant: Address,
    outcome: TransactionOutcome,
  ): Promise<void> {
    if (outcome.status !== 'confirmed') return;

    await this.users.updateOne(
      {
        address: merchant.toLowerCase(),
        [`vaults.${chain}.address`]: { $exists: true },
      },
      {
        $set: {
          [`vaults.${chain}.transactionHash`]: outcome.hash,
          [`vaults.${chain}.blockNumber`]: Number(outcome.receipt.blockNumber),
          [`vaults.${chain}.deployedAt`]: new Date(),
        },
      },
    );
  }

  /**
   * Rejects a chain this deployment does not know.
   *
   * A chain key reaches this service from a request, so it may be anything at
   * all. Failing here means every later step can treat the configuration as
   * present, rather than each one guarding against a missing contract address
   * and one of them eventually forgetting to.
   */
  private chainConfig(chain: ChainKey): void {
    const config = CHAINS[chain];

    if (!config?.contracts?.factory) {
      throw new VaultLifecycleError('chain-config', { details: { chain } });
    }

    // Read for the same reason: a chain whose id cannot be resolved would
    // produce a transaction the node rejects for an unrelated-looking reason.
    chainByKey(chain);
  }

  /** Narrows a request-supplied address, or fails as a bad request. */
  private validateMerchant(merchant: Address): Address {
    if (!isAddress(merchant)) {
      throw new VaultLifecycleError('invalid-merchant', { details: { merchant } });
    }

    return getAddress(merchant);
  }
}

export default VaultLifecycleService;
