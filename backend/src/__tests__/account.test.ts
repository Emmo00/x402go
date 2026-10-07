import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Wallet } from 'ethers';
import type { Application } from 'express';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { SiweMessage } from 'siwe';
import request from 'supertest';
import { getAddress, type Address } from 'viem';

import AccountController from '../controllers/account.controller';
import { CHAINS, CHAIN_KEYS, chainByKey, type ChainKey } from '../config';
import AccountRoute from '../routes/account.route';
import AuthRoute from '../routes/auth.route';
import AccountService from '../services/account.service';
import VaultFactoryService from '../services/vaultFactory.service';
import VaultService from '../services/vault.service';
import { predictVaultAddress } from '../utils/vaultAddress';

/**
 * The account endpoint, and the vault addresses recorded at sign-in.
 *
 * Two things are under test and they need different fixtures.
 *
 * The database behaviour — that sign-in records an address, once, without
 * touching a chain — runs against the real auth flow, because that is where it
 * happens. The only chain reads the account path performs are the deployment
 * checks on `GET /account`, so those are the one thing stubbed: everything
 * else in this file is the real service, the real route, and a real MongoDB.
 *
 * Stubbing the deployment check is not a shortcut around a hard test — the
 * alternative is a suite whose result depends on whether a public Celo RPC
 * answers, which is not a property of this code. The states that matter
 * (deployed, not deployed, unreachable) cannot all be produced on demand from
 * a live chain anyway.
 */

let mongo: MongoMemoryServer;
let apiApp: Application;

/**
 * Deployment answers the stubbed chain reader gives, per network. An `Error`
 * stands for a chain that cannot be reached.
 */
const deployment: Partial<Record<ChainKey, boolean | Error>> = {};

/** Every deployment check the account path made, in order. */
const queried: { chain: ChainKey; address: string }[] = [];

/**
 * A `VaultService` with only its chain reads replaced.
 *
 * Subclassed rather than mocked wholesale so `explorerUrl` stays the real
 * implementation — the endpoint's own output is partly what is under test, and
 * a hand-written explorer URL in the test would agree with a hand-written one
 * in the fixture while both disagreed with the config.
 */
class StubVaultService extends VaultService {
  public override async isDeployed(chain: ChainKey, address: Address): Promise<boolean> {
    queried.push({ chain, address });

    const state = deployment[chain];

    if (state instanceof Error) throw state;

    return state ?? false;
  }
}

/**
 * A factory whose answer depends on the chain.
 *
 * Both Celo networks currently derive the same address for a merchant, because
 * both factories were deployed with the same implementation — so the real
 * configuration cannot demonstrate that two networks are kept apart. This
 * makes them differ on purpose, which is the only way to test that a write or
 * a repair touching one network leaves the other alone.
 */
class ChainSpecificFactory extends VaultFactoryService {
  public override predict(chain: ChainKey, merchant: Address): Address {
    const base = super.predict(chain, merchant);

    // Replace the last byte with one derived from the chain, so every network
    // gets a distinct but still well-formed address.
    const marker = (chainByKey(chain).chainId % 256).toString(16).padStart(2, '0');

    return getAddress(`${base.slice(0, -2)}${marker}`);
  }
}

const usersCollection = () => mongoose.connection.db!.collection('users');

/** A fresh authenticated session, established through the real SIWE flow. */
async function signIn(): Promise<{ agent: ReturnType<typeof request.agent>; address: string }> {
  const agent = request.agent(apiApp);
  const wallet = Wallet.createRandom();
  const address = wallet.address.toLowerCase();

  const nonceResponse = await agent.get('/auth/nonce').query({ address });
  expect(nonceResponse.status).toBe(200);

  const message = new SiweMessage({
    domain: 'localhost',
    address: wallet.address,
    statement: 'Sign in to x402Go',
    uri: 'http://localhost',
    version: '1',
    chainId: 42220,
    nonce: nonceResponse.body.nonce,
  }).prepareMessage();

  const signature = await wallet.signMessage(message);
  const verifyResponse = await agent.post('/auth/verify').send({ address, message, signature });

  expect(verifyResponse.status).toBe(200);

  return { agent, address };
}

/** The stored vault entry for a merchant on one network, straight from BSON. */
async function storedVault(address: string, chain: ChainKey) {
  const document = await usersCollection().findOne({ address });
  const vaults = document?.vaults as Record<string, { address: string; chainId: number; createdAt: Date }> | undefined;

  return vaults?.[chain];
}

/** What the configured factory derives for a merchant. */
function derived(chain: ChainKey, address: string): string {
  const { factory, vaultImplementation } = chainByKey(chain).contracts;

  return predictVaultAddress(factory, vaultImplementation, getAddress(address)).toLowerCase();
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();

  if (!/^mongodb:\/\/127\.0\.0\.1:\d+/.test(uri)) {
    throw new Error(`Refusing to run account tests against a non-loopback database: ${uri}`);
  }

  process.env.NODE_ENV = 'test';
  process.env.MONGO_CONNECTION_URL = uri;
  process.env.SESSION_SECRET = 'account-test-session-secret';
  process.env.API_KEY_PEPPER = 'account-test-pepper';
  process.env.PORT = '0';

  await mongoose.connect(uri);

  const { default: App } = await import('../app');

  // The real service, the real controller, the real route: only the chain
  // provider underneath is stubbed.
  const service = new AccountService(new VaultFactoryService(), new StubVaultService());

  apiApp = new App([
    new AuthRoute(),
    new AccountRoute(new AccountController(service)),
  ]).getServer();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  await usersCollection().deleteMany({});

  queried.length = 0;
  delete deployment.celo;
  delete deployment.celoSepolia;
  deployment.celo = false;
  deployment.celoSepolia = false;
});

describe('vault addresses recorded at sign-in', () => {
  test('records an address for every supported network', async () => {
    const { address } = await signIn();

    for (const chain of CHAIN_KEYS) {
      const stored = await storedVault(address, chain);

      expect(stored).toBeDefined();
      expect(stored!.address).toBe(derived(chain, address));
      expect(stored!.chainId).toBe(chainByKey(chain).chainId);
    }
  });

  test('records the address the factory derives, not one of its own', async () => {
    const { address } = await signIn();
    const stored = await storedVault(address, 'celo');

    // The same value the contract returns for this merchant, computed here
    // from the deployed implementation rather than from the record.
    expect(stored!.address).toBe(
      predictVaultAddress(
        CHAINS.celo.contracts.factory,
        CHAINS.celo.contracts.vaultImplementation,
        getAddress(address),
      ).toLowerCase(),
    );
    expect(stored!.address).toMatch(/^0x[0-9a-f]{40}$/);
  });

  test('stores a lower-case address', async () => {
    const { address } = await signIn();
    const stored = await storedVault(address, 'celo');

    expect(stored!.address).toBe(stored!.address.toLowerCase());
  });

  test('does not recreate an address that is already recorded', async () => {
    const { address } = await signIn();
    const document = await usersCollection().findOne({ address });

    const before = JSON.stringify(document?.vaults);

    // What a merchant signing in repeatedly does to this record. Nothing, in
    // both senses: no write is issued, and if one were, the value is identical.
    const service = new AccountService();
    const userId = String(document!._id);

    await service.ensureVaults(userId, address);
    await service.ensureVaults(userId, address);

    const after = await usersCollection().findOne({ address });

    // Byte-identical: not just the same address, but the same `createdAt`,
    // which is the part a naive upsert churns on every sign-in.
    expect(JSON.stringify(after?.vaults)).toBe(before);
  });

  test('records only the networks that are missing', async () => {
    const { address } = await signIn();
    const document = await usersCollection().findOne({ address });
    const userId = String(document!._id);
    const backdated = new Date('2019-03-04T00:00:00.000Z');

    // Drop one network entirely and backdate the other, as an account recorded
    // before a network was added would look.
    await usersCollection().updateOne(
      { address },
      { $unset: { 'vaults.celoSepolia': '' }, $set: { 'vaults.celo.createdAt': backdated } },
    );

    await new AccountService().ensureVaults(userId, address);

    const celo = await storedVault(address, 'celo');
    const sepolia = await storedVault(address, 'celoSepolia');

    expect(celo!.createdAt.getTime()).toBe(backdated.getTime());
    expect(sepolia!.address).toBe(derived('celoSepolia', address));
  });

  test('touches no chain at sign-in, and therefore deploys nothing', async () => {
    const realFetch = globalThis.fetch;
    const calls: string[] = [];

    // Every outbound HTTP request viem could make goes through `fetch`, so
    // counting them is a direct answer to "did sign-in read or write a chain".
    // It also makes the assertion self-enforcing rather than advisory: a call
    // would throw here instead of quietly succeeding somewhere else.
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));

      throw new Error(`sign-in attempted a network call to ${String(input)}`);
    }) as typeof fetch;

    try {
      const { address } = await signIn();

      expect(calls).toEqual([]);
      // Recorded anyway — the address is arithmetic, not a chain read.
      expect((await storedVault(address, 'celo'))!.address).toBe(derived('celo', address));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('records nothing for an account whose address is malformed', async () => {
    const document = await usersCollection().insertOne({
      address: 'not-an-address',
      authChallenge: { nonce: 'x', expiredAt: new Date(Date.now() + 60_000), used: false },
    });

    await new AccountService().ensureVaults(String(document.insertedId), 'not-an-address');

    const after = await usersCollection().findOne({ _id: document.insertedId });

    expect(after?.vaults).toBeUndefined();
  });
});

describe('GET /account', () => {
  test('refuses an unauthenticated caller', async () => {
    const response = await request(apiApp).get('/account');

    expect(response.status).toBe(401);
    expect(response.body.vaults).toBeUndefined();
  });

  test('returns the merchant address and one vault per network', async () => {
    const { agent, address } = await signIn();

    const response = await agent.get('/account');

    expect(response.status).toBe(200);
    expect(response.body.address).toBe(address);
    expect(response.body.vaults).toHaveLength(CHAIN_KEYS.length);

    for (const vault of response.body.vaults) {
      expect(CHAIN_KEYS).toContain(vault.network as ChainKey);
      expect(vault.networkName).toBe(chainByKey(vault.network as ChainKey).name);
      expect(vault.chainId).toBe(chainByKey(vault.network as ChainKey).chainId);
      expect(vault.address).toBe(derived(vault.network as ChainKey, address));
    }
  });

  test('returns the vault address as a usable payTo address', async () => {
    const { agent, address } = await signIn();

    const response = await agent.get('/account');
    const mainnet = response.body.vaults.find((vault: { network: string }) => vault.network === 'celo');

    // The whole point of the endpoint: this is the address a merchant puts in
    // the x402 challenge, and it is known before anything is deployed.
    expect(mainnet).toBeDefined();
    expect(mainnet.address).toBe(derived('celo', address));
    expect(mainnet.address).toMatch(/^0x[0-9a-f]{40}$/);
  });

  test('reports a deployed vault as deployed', async () => {
    const { agent } = await signIn();
    deployment.celo = true;
    deployment.celoSepolia = true;

    const response = await agent.get('/account');

    for (const vault of response.body.vaults) {
      expect(vault.deployed).toBe(true);
    }
  });

  test('reports a vault that has not been deployed as not deployed', async () => {
    const { agent, address } = await signIn();
    deployment.celo = false;
    deployment.celoSepolia = false;

    const response = await agent.get('/account');

    for (const vault of response.body.vaults) {
      expect(vault.deployed).toBe(false);
      // Not deployed, and still the correct address — the two facts are
      // independent, which is the distinction this whole step rests on.
      expect(vault.address).toBe(derived(vault.network as ChainKey, address));
    }
  });

  test('distinguishes deployed from not deployed per network', async () => {
    const { agent } = await signIn();
    deployment.celo = true;
    deployment.celoSepolia = false;

    const response = await agent.get('/account');
    const byNetwork = Object.fromEntries(
      response.body.vaults.map((vault: { network: string; deployed: boolean }) => [
        vault.network,
        vault.deployed,
      ]),
    );

    expect(byNetwork).toEqual({ celo: true, celoSepolia: false });
  });

  test('reports an unreachable chain as unknown rather than as not deployed', async () => {
    const { agent, address } = await signIn();
    deployment.celo = new Error('forno is having a day');

    const response = await agent.get('/account');
    const mainnet = response.body.vaults.find((vault: { network: string }) => vault.network === 'celo');

    // Not `false`: "no contract exists there" is a fact about the vault, and a
    // timed-out node has not established it.
    expect(mainnet.deployed).toBeNull();
    // The address is still served, because it does not depend on the chain.
    expect(mainnet.address).toBe(derived('celo', address));
  });

  test('checks deployment against the derived address, not the stored one', async () => {
    const { agent, address } = await signIn();
    const wrong = Wallet.createRandom().address.toLowerCase();

    await usersCollection().updateOne({ address }, { $set: { 'vaults.celo.address': wrong } });
    queried.length = 0;

    await agent.get('/account');

    const mainnetCheck = queried.find((entry) => entry.chain === 'celo');

    // Asking whether a contract exists at the stale address would answer a
    // question about a vault that is not this merchant's.
    expect(mainnetCheck?.address.toLowerCase()).toBe(derived('celo', address));
    expect(mainnetCheck?.address.toLowerCase()).not.toBe(wrong);
  });

  test('returns an explorer link for each network', async () => {
    const { agent, address } = await signIn();

    const response = await agent.get('/account');

    for (const vault of response.body.vaults) {
      expect(vault.explorerUrl).toBe(
        `${chainByKey(vault.network as ChainKey).explorerUrl}/address/${derived(vault.network as ChainKey, address)}`,
      );
    }
  });

  test('never returns another merchant’s vault', async () => {
    const first = await signIn();
    const second = await signIn();

    const response = await second.agent.get('/account');

    expect(response.body.address).toBe(second.address);
    expect(response.body.vaults[0].address).toBe(derived('celo', second.address));
    expect(response.body.vaults[0].address).not.toBe(derived('celo', first.address));
  });

  test('reports a missing account rather than inventing one', async () => {
    const outcome = await new AccountService().getAccount(
      new mongoose.Types.ObjectId().toString(),
    );

    expect(outcome.status).toBe('no-account');
  });
});

describe('a stored address that disagrees with the factory', () => {
  test('is not served to the client', async () => {
    const { agent, address } = await signIn();
    const wrong = Wallet.createRandom().address.toLowerCase();

    await usersCollection().updateOne({ address }, { $set: { 'vaults.celo.address': wrong } });

    const response = await agent.get('/account');
    const mainnet = response.body.vaults.find((vault: { network: string }) => vault.network === 'celo');

    // The stored value is a cache of the factory's answer, never an authority.
    // Serving it would send a merchant's customers to an address where no
    // vault exists, and their money with them.
    expect(mainnet.address).not.toBe(wrong);
    expect(mainnet.address).toBe(derived('celo', address));
  });

  test('is corrected in the database', async () => {
    const { agent, address } = await signIn();
    const wrong = Wallet.createRandom().address.toLowerCase();

    await usersCollection().updateOne({ address }, { $set: { 'vaults.celo.address': wrong } });
    await agent.get('/account');

    expect((await storedVault(address, 'celo'))!.address).toBe(derived('celo', address));
  });

  test('is corrected case-insensitively, without a spurious repair', async () => {
    const { agent, address } = await signIn();
    const stored = (await storedVault(address, 'celo'))!.address;
    const backdated = new Date('2021-06-01T00:00:00.000Z');

    // Same address, checksummed. That is the same value, so it must not be
    // treated as a disagreement — a repair here would rewrite the document on
    // every dashboard load.
    await usersCollection().updateOne(
      { address },
      {
        $set: {
          'vaults.celo.address': getAddress(stored as Address),
          'vaults.celo.createdAt': backdated,
        },
      },
    );

    await agent.get('/account');

    expect((await storedVault(address, 'celo'))!.createdAt.getTime()).toBe(backdated.getTime());
  });

  test('cannot be set by the caller', async () => {
    const { agent, address } = await signIn();
    const attacker = Wallet.createRandom().address;

    // There is no field on this endpoint a caller could use to move their
    // vault: the address is derived from the session's own merchant address.
    await agent.get('/account').query({ address: attacker, vault: attacker });
    await agent.post('/account').send({ vaults: { celo: { address: attacker } } });

    expect((await storedVault(address, 'celo'))!.address).toBe(derived('celo', address));
  });
});

describe('networks are kept apart', () => {
  test('a demand for one network does not disturb another', async () => {
    const { address } = await signIn();
    const document = await usersCollection().findOne({ address });
    const userId = String(document!._id);

    // Start from an account with nothing recorded, so both writes come from
    // this service.
    await usersCollection().updateOne({ address }, { $unset: { vaults: '' } });

    const service = new AccountService(new ChainSpecificFactory(), new StubVaultService());

    await service.ensureVaults(userId, address);

    const celo = await storedVault(address, 'celo');
    const sepolia = await storedVault(address, 'celoSepolia');

    expect(celo).toBeDefined();
    expect(sepolia).toBeDefined();
    expect(celo!.chainId).toBe(42220);
    expect(sepolia!.chainId).toBe(11142220);
    // Distinct here only because the factory was made chain-aware; the point
    // is that the two entries are written and read independently.
    expect(celo!.address).not.toBe(sepolia!.address);
  });

  test('repairs only the network that disagrees', async () => {
    const { address } = await signIn();
    const document = await usersCollection().findOne({ address });
    const userId = String(document!._id);

    await usersCollection().updateOne({ address }, { $unset: { vaults: '' } });

    const service = new AccountService(new ChainSpecificFactory(), new StubVaultService());

    await service.ensureVaults(userId, address);

    const sepoliaBefore = await storedVault(address, 'celoSepolia');
    const wrong = Wallet.createRandom().address.toLowerCase();

    await usersCollection().updateOne({ address }, { $set: { 'vaults.celo.address': wrong } });

    await service.getAccount(userId);

    const celoAfter = await storedVault(address, 'celo');
    const sepoliaAfter = await storedVault(address, 'celoSepolia');

    expect(celoAfter!.address).not.toBe(wrong);
    expect(sepoliaAfter!.address).toBe(sepoliaBefore!.address);
    expect(sepoliaAfter!.createdAt.getTime()).toBe(sepoliaBefore!.createdAt.getTime());
  });
});

describe('VaultService.explorerUrl', () => {
  test('builds each network’s URL from its configured explorer', () => {
    const service = new VaultService();
    const address = getAddress(Wallet.createRandom().address);

    expect(service.explorerUrl('celo', address)).toBe(
      `https://celoscan.io/address/${address}`,
    );
    expect(service.explorerUrl('celoSepolia', address)).toBe(
      `https://celo-sepolia.blockscout.com/address/${address}`,
    );
  });
});
