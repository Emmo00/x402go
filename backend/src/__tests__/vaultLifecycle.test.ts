import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { getAddress, type Address, type Hex, type TransactionReceipt } from 'viem';

import { chainByKey, type ChainKey } from '../config';
import { VaultLifecycleError } from '../exceptions/VaultLifecycleError';
import { clearLocks } from '../services/lock.service';
import VaultLifecycleService from '../services/vaultLifecycle.service';
import VaultFactoryService from '../services/vaultFactory.service';
import VaultService, { type VaultConfig } from '../services/vault.service';
import { getOperatorAddress, resetOperatorWallets } from '../utils/operatorWallet';
import type { ContractWrite, TransactionSender } from '../utils/transaction';

/**
 * The vault lifecycle, against a real database and a scripted chain.
 *
 * The database is real because the stored vault address and the stored payout
 * are inputs the lifecycle is required to respect — one of them is checked for
 * disagreement, the other is the value a new vault is initialised with — and a
 * stubbed user model would let both be whatever the test felt like. The lock is
 * real for the same reason: the concurrency cases are the point of having one.
 *
 * The chain is scripted. Every case here is about what the backend does with an
 * answer, and the answers that matter — a vault that is not there, a factory
 * that disagrees, an operator that is not ours, a deployment that produces a
 * different payout than asked — cannot be produced on demand by a live node.
 * The one thing a scripted chain cannot prove is that the real factory behaves
 * as scripted; that is what `verify-e2e.ts` and the ABI drift test are for.
 */

/**
 * A throwaway operator key, set before anything can read it.
 *
 * Nothing in this file uses it — the transaction sender is scripted — but the
 * lifecycle imports `operatorWallet`, and the one outcome that must never be
 * possible is a test signing with the real key from `backend/.env`. Pinning a
 * known key makes that structurally impossible rather than merely unlikely.
 */
const TEST_OPERATOR_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TEST_OPERATOR = getAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');

/**
 * Fixtures are run through `getAddress` rather than written checksummed by
 * hand: viem's `isAddress` rejects a mixed-case address whose EIP-55 checksum
 * does not verify, so a literal typed with the wrong capitalisation would make
 * every "valid merchant" case fail as a bad request.
 */
const MERCHANT = getAddress('0xabc0000000000000000000000000000000000001');
const OTHER_MERCHANT = getAddress('0xabc0000000000000000000000000000000000002');
const PAYOUT = getAddress('0xdef0000000000000000000000000000000000003');
const OTHER_PAYOUT = getAddress('0xdef0000000000000000000000000000000000004');
const STRANGER = getAddress('0x9990000000000000000000000000000000000005');

/**
 * One vault address per network.
 *
 * Deliberately different. The real configuration derives the *same* address on
 * both Celo networks — one factory, one implementation, same salt — so a suite
 * using the real derivation could not tell "kept the networks apart" from
 * "collapsed them into one". These are fixtures, and the tests that depend on
 * them are the ones about independence.
 */
const VAULTS: Record<ChainKey, Address> = {
  celo: getAddress('0x59f3d0c53bc46a35a81e478b080cc8afa2fc88de'),
  celoSepolia: getAddress('0x6b600bec988ac955f15e9008b063a5b09a726468'),
};

const HASH = `0x${'ab'.repeat(32)}` as Hex;

let mongo: MongoMemoryServer;

/* ------------------------------------------------------------------------ */
/* A scripted chain                                                          */
/* ------------------------------------------------------------------------ */

interface FakeVault {
  merchant: Address;
  payout: Address;
  nonce: bigint;
}

interface ChainState {
  /** Lower-cased addresses that have code, as `eth_getCode` would report. */
  deployed: Set<string>;
  /** The vault at each address, for `readConfig`. */
  configs: Map<string, FakeVault>;
  /** What the factory answers for each merchant. */
  addresses: Map<string, Address>;
  operator: Address;
  /** When set, every read throws — the node is unreachable. */
  unreachable: Error | null;
  /** Set to make a "successful" deployment leave no code behind. */
  silentlyFailsToDeploy: boolean;
  /** Set to make the factory create the vault with a payout nobody asked for. */
  deployWithPayout: Address | null;
  /** Set to make the factory create the vault for the wrong merchant. */
  deployForMerchant: Address | null;
}

const state: Record<ChainKey, ChainState> = {
  celo: blankState(),
  celoSepolia: blankState(),
};

function blankState(): ChainState {
  return {
    deployed: new Set(),
    configs: new Map(),
    addresses: new Map(),
    operator: TEST_OPERATOR,
    unreachable: null,
    silentlyFailsToDeploy: false,
    deployWithPayout: null,
    deployForMerchant: null,
  };
}

const key = (address: string) => address.toLowerCase();

/** The address the factory answers, defaulting to the per-network fixture. */
function addressOf(chain: ChainKey, merchant: Address): Address {
  return state[chain].addresses.get(key(merchant)) ?? VAULTS[chain];
}

function guard(chain: ChainKey): void {
  if (state[chain].unreachable) throw state[chain].unreachable!;
}

class StubVaultService extends VaultService {
  public override async isDeployed(chain: ChainKey, address: Address): Promise<boolean> {
    guard(chain);

    return state[chain].deployed.has(key(address));
  }

  public override async readConfig(chain: ChainKey, address: Address): Promise<VaultConfig> {
    guard(chain);

    const vault = state[chain].configs.get(key(address));

    if (!vault) throw new Error(`no contract at ${address} on ${chain}`);

    return { chain, address, merchant: vault.merchant, payout: vault.payout, nonce: vault.nonce };
  }
}

class StubFactoryService extends VaultFactoryService {
  public override async vaultOf(chain: ChainKey, merchant: Address): Promise<Address> {
    guard(chain);

    return addressOf(chain, merchant);
  }

  public override async operator(chain: ChainKey): Promise<Address> {
    guard(chain);

    return state[chain].operator;
  }
}

/**
 * The operator, as far as this suite is concerned.
 *
 * `send` performs what the real `createVault` would: it reverts if the vault is
 * already there, and otherwise leaves code at the address and records the
 * config the factory would have initialised. That is enough to exercise
 * everything the lifecycle does after a send.
 */
class ScriptedSender implements TransactionSender {
  public readonly account = TEST_OPERATOR;
  public readonly chainId: number;

  /** Every call this sender was asked to submit, in order. */
  public readonly sends: ContractWrite[] = [];

  /** How long a submission takes, so a concurrent caller can be made to wait. */
  public delayMs = 0;

  constructor(public readonly chain: ChainKey) {
    this.chainId = chainByKey(chain).chainId;
  }

  public async pendingNonce(): Promise<number> {
    return this.sends.length;
  }

  public async send(write: ContractWrite, _nonce: number): Promise<Hex> {
    this.sends.push(write);

    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    const chainState = state[this.chain];
    const [merchant, payout] = write.args as readonly [Address, Address];
    const address = key(addressOf(this.chain, merchant));

    if (chainState.deployed.has(address)) {
      throw Object.assign(new Error('execution reverted'), {
        name: 'ContractFunctionRevertedError',
        data: { errorName: 'VaultExists' },
      });
    }

    if (!chainState.silentlyFailsToDeploy) {
      chainState.deployed.add(address);
      chainState.configs.set(address, {
        merchant: chainState.deployForMerchant ?? merchant,
        payout: chainState.deployWithPayout ?? payout,
        nonce: BigInt(0),
      });
    }

    return HASH;
  }

  public async waitForReceipt(hash: Hex): Promise<TransactionReceipt> {
    return { transactionHash: hash, status: 'success', blockNumber: BigInt(99) } as TransactionReceipt;
  }

  public async getReceipt(hash: Hex): Promise<TransactionReceipt | null> {
    return { transactionHash: hash, status: 'success', blockNumber: BigInt(99) } as TransactionReceipt;
  }
}

const senders: Partial<Record<ChainKey, ScriptedSender>> = {};

function senderFor(chain: ChainKey): ScriptedSender {
  const existing = senders[chain];

  if (existing) return existing;

  const sender = new ScriptedSender(chain);
  senders[chain] = sender;

  return sender;
}

/** Every submission made on a chain, across however many senders were built. */
function sendsOn(chain: ChainKey): ContractWrite[] {
  return senderFor(chain).sends;
}

function lifecycle(): VaultLifecycleService {
  return new VaultLifecycleService(new StubFactoryService(), new StubVaultService(), senderFor);
}

const users = () => mongoose.connection.db!.collection('users');

/** Creates the account record a signed-in merchant would have. */
async function account(
  merchant: Address,
  options: { vault?: Partial<Record<ChainKey, string>>; payTo?: string } = {},
): Promise<void> {
  const vaults: Record<string, unknown> = {};

  for (const [chain, address] of Object.entries(options.vault ?? {})) {
    vaults[chain] = {
      address: address!.toLowerCase(),
      chainId: chainByKey(chain as ChainKey).chainId,
      createdAt: new Date(),
    };
  }

  await users().insertOne({
    address: key(merchant),
    ...(options.payTo ? { payTo: options.payTo.toLowerCase() } : {}),
    ...(Object.keys(vaults).length > 0 ? { vaults } : {}),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/** Marks a vault as deployed, with a config, without going through a sender. */
function predeploy(
  chain: ChainKey,
  address: Address,
  config: Partial<FakeVault> = {},
): void {
  state[chain].deployed.add(key(address));
  state[chain].configs.set(key(address), {
    merchant: config.merchant ?? MERCHANT,
    payout: config.payout ?? MERCHANT,
    nonce: config.nonce ?? BigInt(0),
  });
}

/** Reads an error's code, asserting it is the type this suite expects. */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(VaultLifecycleError);

    return (error as VaultLifecycleError).code;
  }

  throw new Error('expected the call to throw');
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();

  if (!/^mongodb:\/\/127\.0\.0\.1:\d+/.test(uri)) {
    throw new Error(`Refusing to run lifecycle tests against a non-loopback database: ${uri}`);
  }

  process.env.NODE_ENV = 'test';
  process.env.MONGO_CONNECTION_URL = uri;
  process.env.OPERATOR_KEY = TEST_OPERATOR_KEY;

  await mongoose.connect(uri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  await users().deleteMany({});
  await clearLocks();

  state.celo = blankState();
  state.celoSepolia = blankState();
  delete senders.celo;
  delete senders.celoSepolia;

  // A fresh key each time, so nothing carries an account derived under a
  // previous case's environment.
  process.env.OPERATOR_KEY = TEST_OPERATOR_KEY;
  resetOperatorWallets();
});

/* ------------------------------------------------------------------------ */

describe('the deterministic address', () => {
  test('is the factory’s answer, not a locally computed one', async () => {
    await account(MERCHANT);

    expect(await lifecycle().getVaultAddress('celo', MERCHANT)).toBe(VAULTS.celo);

    // The factory is what was asked. A local derivation would have produced the
    // same address only because the fixtures agree — so point the factory at a
    // different one and require the service to follow it.
    state.celo.addresses.set(key(MERCHANT), OTHER_PAYOUT);

    expect(await lifecycle().getVaultAddress('celo', MERCHANT)).toBe(OTHER_PAYOUT);
  });

  test('is the same on every call, and for the same merchant on one network', async () => {
    await account(MERCHANT);

    const first = await lifecycle().getVaultAddress('celo', MERCHANT);
    const second = await lifecycle().getVaultAddress('celo', MERCHANT);

    expect(first).toBe(second);
  });

  test('differs between merchants', async () => {
    await account(MERCHANT);
    await account(OTHER_MERCHANT);

    state.celo.addresses.set(key(OTHER_MERCHANT), OTHER_PAYOUT);

    const mine = await lifecycle().getVaultAddress('celo', MERCHANT);
    const theirs = await lifecycle().getVaultAddress('celo', OTHER_MERCHANT);

    expect(mine).not.toBe(theirs);
  });

  test('keeps the networks independent', async () => {
    await account(MERCHANT);

    const celo = await lifecycle().getVaultAddress('celo', MERCHANT);
    const sepolia = await lifecycle().getVaultAddress('celoSepolia', MERCHANT);

    expect(celo).not.toBe(sepolia);

    // Deploying on one network must leave the other address empty, which is the
    // failure a shared cache or a chain-less key would produce.
    await lifecycle().ensureVaultDeployed('celo', MERCHANT);

    expect(await lifecycle().isVaultDeployed('celo', celo)).toBe(true);
    expect(await lifecycle().isVaultDeployed('celoSepolia', sepolia)).toBe(false);
    expect(sendsOn('celoSepolia')).toHaveLength(0);
  });

  test('refuses a stored address the factory does not agree with', async () => {
    await account(MERCHANT, { vault: { celo: OTHER_PAYOUT } });

    expect(await codeOf(() => lifecycle().getVaultAddress('celo', MERCHANT))).toBe(
      'vault-address-mismatch',
    );
  });

  test('deploys nothing when the stored address disagrees', async () => {
    await account(MERCHANT, { vault: { celo: OTHER_PAYOUT } });

    await codeOf(() => lifecycle().ensureVaultDeployed('celo', MERCHANT));

    // The account endpoint repairs a divergent record and carries on. This
    // service must not: it is about to send funds to the address, so the
    // disagreement is a stop, and in particular it is not a reason to deploy a
    // second vault somewhere the factory does not name.
    expect(sendsOn('celo')).toHaveLength(0);
    expect(state.celo.deployed.size).toBe(0);
  });

  test('rejects a merchant that is not an address', async () => {
    expect(await codeOf(() => lifecycle().getVaultAddress('celo', '0xnope' as Address))).toBe(
      'invalid-merchant',
    );
  });

  test('rejects a chain this deployment does not have', async () => {
    expect(
      await codeOf(() => lifecycle().getVaultAddress('polygon' as ChainKey, MERCHANT)),
    ).toBe('chain-config');
  });
});

describe('deployment state', () => {
  test('reports an address with no code as not deployed', async () => {
    expect(await lifecycle().isVaultDeployed('celo', VAULTS.celo)).toBe(false);
  });

  test('reports an address with code as deployed', async () => {
    predeploy('celo', VAULTS.celo);

    expect(await lifecycle().isVaultDeployed('celo', VAULTS.celo)).toBe(true);
  });

  test('an unreachable chain is an error, never a "no"', async () => {
    state.celo.unreachable = new Error('ECONNREFUSED');

    // Answering `false` would read "not deployed" from a node that never
    // answered — and a caller would then deploy a vault that may already exist.
    expect(await codeOf(() => lifecycle().isVaultDeployed('celo', VAULTS.celo))).toBe(
      'chain-unreachable',
    );
  });

  test('an unreachable factory is an error, not a locally derived address', async () => {
    state.celo.unreachable = new Error('ECONNREFUSED');

    expect(await codeOf(() => lifecycle().getVaultAddress('celo', MERCHANT))).toBe(
      'factory-unreachable',
    );
  });
});

describe('lazy deployment', () => {
  test('deploys a vault that is not there, and records what it did', async () => {
    await account(MERCHANT);

    const result = await lifecycle().ensureVaultDeployed('celo', MERCHANT);

    expect(result.address).toBe(VAULTS.celo);
    expect(result.deployedByUs).toBe(true);
    expect(result.transactionHash).toBe(HASH);
    expect(sendsOn('celo')).toHaveLength(1);
    expect(await lifecycle().isVaultDeployed('celo', VAULTS.celo)).toBe(true);
  });

  test('sends nothing when the vault is already deployed', async () => {
    await account(MERCHANT);
    predeploy('celo', VAULTS.celo, { merchant: MERCHANT, payout: MERCHANT });

    const result = await lifecycle().ensureVaultDeployed('celo', MERCHANT);

    expect(result.deployedByUs).toBe(false);
    expect(result.transactionHash).toBeNull();
    expect(sendsOn('celo')).toHaveLength(0);
  });

  test('records the deployment against the account, without losing the address', async () => {
    await account(MERCHANT, { vault: { celo: VAULTS.celo } });

    await lifecycle().ensureVaultDeployed('celo', MERCHANT);

    const stored = await users().findOne({ address: key(MERCHANT) });
    const vault = (stored!.vaults as Record<string, Record<string, unknown>>).celo;

    expect(vault.transactionHash).toBe(HASH);
    expect(vault.blockNumber).toBe(99);
    expect(vault.deployedAt).toBeInstanceOf(Date);
    // Written with dot-paths, so the fields the sign-in flow wrote are intact.
    expect(vault.address).toBe(key(VAULTS.celo));
    expect(vault.chainId).toBe(42220);
  });

  test('works for a merchant with no account record yet', async () => {
    await account(MERCHANT);
    await users().drop();

    const result = await lifecycle().ensureVaultDeployed('celo', MERCHANT);

    // A payment can reach a merchant's address before they have ever signed in,
    // and the withdrawal that follows must not depend on a record that was
    // never written. There is nowhere to cache the deployment, which is why the
    // cache is best effort and the chain is what is authoritative.
    expect(result.deployedByUs).toBe(true);
    expect(await lifecycle().isVaultDeployed('celo', VAULTS.celo)).toBe(true);
  });

  test('fails when the transaction is mined but no vault appears', async () => {
    await account(MERCHANT);
    state.celo.silentlyFailsToDeploy = true;

    // A receipt says the transaction was mined and did not revert. It does not
    // say a contract exists at the address the factory promised.
    expect(await codeOf(() => lifecycle().ensureVaultDeployed('celo', MERCHANT))).toBe(
      'deployment-not-confirmed',
    );
  });

  test('refuses to deploy when the vault is not ours to deploy with', async () => {
    await account(MERCHANT);
    state.celo.operator = STRANGER;

    // Caught before the send, because a revert still costs gas and would look
    // like a transient failure worth retrying.
    expect(await codeOf(() => lifecycle().ensureVaultDeployed('celo', MERCHANT))).toBe(
      'operator-mismatch',
    );
    expect(sendsOn('celo')).toHaveLength(0);
  });

  test('refuses a vault the factory created for someone else', async () => {
    await account(MERCHANT);
    state.celo.deployForMerchant = STRANGER;

    expect(await codeOf(() => lifecycle().ensureVaultDeployed('celo', MERCHANT))).toBe(
      'merchant-mismatch',
    );
  });

  test('refuses a vault whose payout is not the one it asked for', async () => {
    await account(MERCHANT, { payTo: PAYOUT });
    state.celo.deployWithPayout = OTHER_PAYOUT;

    expect(await codeOf(() => lifecycle().ensureVaultDeployed('celo', MERCHANT))).toBe(
      'payout-mismatch',
    );
  });
});

describe('the payout', () => {
  test('is initialised in the same transaction that deploys the vault', async () => {
    await account(MERCHANT, { payTo: PAYOUT });

    const result = await lifecycle().ensureVaultPayoutInitialized('celo', MERCHANT);

    expect(result.payout).toBe(PAYOUT);
    expect(result.deployedByUs).toBe(true);
    expect(sendsOn('celo')).toHaveLength(1);
  });

  test('uses the payout already on record when the vault is first deployed', async () => {
    await account(MERCHANT, { payTo: PAYOUT });

    await lifecycle().ensureVaultDeployed('celo', MERCHANT);

    // The payout is an argument to the only call that can ever set it, so this
    // is not a preference being saved for later — it is the value the vault
    // holds, and it came from the account rather than from the caller.
    const [, payout] = sendsOn('celo')[0].args as readonly [Address, Address];

    expect(payout).toBe(PAYOUT);
  });

  test('pays the merchant when no payout has been configured', async () => {
    await account(MERCHANT);

    await lifecycle().ensureVaultDeployed('celo', MERCHANT);

    const [merchant, payout] = sendsOn('celo')[0].args as readonly [Address, Address];

    expect(merchant).toBe(MERCHANT);
    // What `payout()` reports when nothing was initialised, because the factory
    // only calls `initPayout` when the payout differs from the merchant.
    expect(payout).toBe(MERCHANT);
  });

  test('refuses a stored payout that is not an address', async () => {
    await account(MERCHANT, { payTo: 'not-an-address' });

    expect(await codeOf(() => lifecycle().ensureVaultDeployed('celo', MERCHANT))).toBe(
      'invalid-payout',
    );
    expect(sendsOn('celo')).toHaveLength(0);
  });

  test('does not re-initialise a vault that is already deployed and correct', async () => {
    await account(MERCHANT, { payTo: PAYOUT });
    predeploy('celo', VAULTS.celo, { merchant: MERCHANT, payout: PAYOUT });

    const result = await lifecycle().ensureVaultPayoutInitialized('celo', MERCHANT);

    // There is no second call to make: `initPayout` is factory-only and
    // one-shot, and the factory will not create the vault twice. "Initialise
    // again" is not a thing this system can do, so the only correct behaviour
    // is to confirm and move on.
    expect(result.deployedByUs).toBe(false);
    expect(sendsOn('celo')).toHaveLength(0);
  });

  test('stops rather than withdraw through a payout mismatch', async () => {
    await account(MERCHANT, { payTo: OTHER_PAYOUT });
    predeploy('celo', VAULTS.celo, { merchant: MERCHANT, payout: PAYOUT });

    // The record says one address, the vault says another. Either the record is
    // stale or the vault was pointed somewhere the merchant did not intend, and
    // this service cannot tell which — so it does not guess, and it does not
    // quietly pay the on-chain address either.
    expect(await codeOf(() => lifecycle().ensureVaultPayoutInitialized('celo', MERCHANT))).toBe(
      'payout-mismatch',
    );
    expect(sendsOn('celo')).toHaveLength(0);
  });

  test('proceeds when the caller names the payout the vault actually has', async () => {
    await account(MERCHANT, { payTo: OTHER_PAYOUT });
    predeploy('celo', VAULTS.celo, { merchant: MERCHANT, payout: PAYOUT });

    // An explicit address is the caller taking responsibility for it: a
    // `changePayout` the merchant signed moves the vault and leaves the record
    // behind, and that is the path by which the two are reconciled.
    const result = await lifecycle().ensureVaultPayoutInitialized('celo', MERCHANT, PAYOUT);

    expect(result.payout).toBe(PAYOUT);
  });

  test('reads the replay nonce the merchant’s next signature will need', async () => {
    await account(MERCHANT, { payTo: PAYOUT });
    predeploy('celo', VAULTS.celo, { merchant: MERCHANT, payout: PAYOUT, nonce: BigInt(4) });

    const result = await lifecycle().ensureVaultPayoutInitialized('celo', MERCHANT);

    expect(result.payoutNonce).toBe(BigInt(4));
  });

  test('refuses a vault belonging to a different merchant', async () => {
    await account(MERCHANT, { payTo: PAYOUT });
    predeploy('celo', VAULTS.celo, { merchant: STRANGER, payout: PAYOUT });

    expect(await codeOf(() => lifecycle().ensureVaultPayoutInitialized('celo', MERCHANT))).toBe(
      'merchant-mismatch',
    );
  });
});

describe('concurrent requests', () => {
  test('two callers deploy one vault, and the second adopts it', async () => {
    await account(MERCHANT);
    senderFor('celo').delayMs = 60;

    const [first, second] = await Promise.all([
      lifecycle().ensureVaultDeployed('celo', MERCHANT),
      lifecycle().ensureVaultDeployed('celo', MERCHANT),
    ]);

    expect(sendsOn('celo')).toHaveLength(1);
    expect(first.address).toBe(second.address);
    expect(first.address).toBe(VAULTS.celo);

    // Exactly one of them sent the transaction; the other waited for the lock,
    // re-read the chain, and found the vault. Both are successes.
    const byUs = [first, second].filter((result) => result.deployedByUs);

    expect(byUs).toHaveLength(1);
  });

  test('two callers initialise the payout once', async () => {
    await account(MERCHANT, { payTo: PAYOUT });
    senderFor('celo').delayMs = 60;

    const [first, second] = await Promise.all([
      lifecycle().ensureVaultPayoutInitialized('celo', MERCHANT),
      lifecycle().ensureVaultPayoutInitialized('celo', MERCHANT),
    ]);

    expect(sendsOn('celo')).toHaveLength(1);
    expect(first.payout).toBe(PAYOUT);
    expect(second.payout).toBe(PAYOUT);
  });

  test('separate networks do not wait on each other', async () => {
    await account(MERCHANT);
    senderFor('celo').delayMs = 80;

    await Promise.all([
      lifecycle().ensureVaultDeployed('celo', MERCHANT),
      lifecycle().ensureVaultDeployed('celoSepolia', MERCHANT),
    ]);

    // Both deployed, each in its own transaction: the lock is keyed by chain as
    // well as merchant, so a slow mainnet deployment does not stall a testnet
    // one behind it.
    expect(sendsOn('celo')).toHaveLength(1);
    expect(sendsOn('celoSepolia')).toHaveLength(1);
  });
});

describe('the operator wallet', () => {
  test('derives the address of the configured key', () => {
    expect(getOperatorAddress().toLowerCase()).toBe(TEST_OPERATOR.toLowerCase());
  });

  test('reports an unusable key without ever naming it', () => {
    process.env.OPERATOR_KEY = 'oops';
    resetOperatorWallets();

    try {
      getOperatorAddress();
      throw new Error('expected getOperatorAddress to throw');
    } catch (error) {
      const typed = error as VaultLifecycleError;

      expect(typed.code).toBe('operator-key-unusable');
      // The whole point of the error path: a malformed key may still be a real
      // secret with a typo in it, and an error is the one object guaranteed to
      // be printed somewhere.
      expect(JSON.stringify(typed.details)).not.toContain('oops');
      expect(typed.message).not.toContain('oops');
      expect(typed.cause).toBeUndefined();
    }
  });

  test('reports a missing key', () => {
    delete process.env.OPERATOR_KEY;
    resetOperatorWallets();

    try {
      getOperatorAddress();
      throw new Error('expected getOperatorAddress to throw');
    } catch (error) {
      expect((error as VaultLifecycleError).code).toBe('operator-key-unusable');
    }
  });

  test('re-derives after the key changes', () => {
    expect(getOperatorAddress().toLowerCase()).toBe(TEST_OPERATOR.toLowerCase());

    process.env.OPERATOR_KEY = `0x${'11'.repeat(32)}`;
    resetOperatorWallets();

    expect(getOperatorAddress().toLowerCase()).not.toBe(TEST_OPERATOR.toLowerCase());
  });
});
