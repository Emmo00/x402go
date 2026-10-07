/**
 * End-to-end verification of Step 0, against the real chain.
 *
 * Throwaway: this is the final-requirement walkthrough, run once and read. It is
 * not a test — it reads live Celo RPCs, so it can fail for reasons that are not
 * properties of this code, which is why the suite stubs them instead.
 *
 * What it does that the tests cannot: it closes the loop on the *deployed*
 * factory. Every other check in this repo compares our derivation against a
 * recorded vector or against another copy of our own arithmetic. This one signs
 * in a fresh wallet, then asks `factory.vaultOf` on both live chains what the
 * address should be, and requires the stored and served values to match it.
 */

import { Wallet } from 'ethers';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { SiweMessage } from 'siwe';
import request from 'supertest';

const mongo = await MongoMemoryServer.create();
const uri = mongo.getUri();

if (!/^mongodb:\/\/127\.0\.0\.1:\d+/.test(uri)) {
  throw new Error(`Refusing to run against a non-loopback database: ${uri}`);
}

process.env.NODE_ENV = 'test';
process.env.MONGO_CONNECTION_URL = uri;
process.env.SESSION_SECRET = 'e2e-verification-session-secret';
process.env.API_KEY_PEPPER = 'e2e-verification-pepper';
process.env.PORT = '0';

await mongoose.connect(uri);

const { default: App } = await import('./src/app');
const AccountController = (await import('./src/controllers/account.controller')).default;
const AccountRoute = (await import('./src/routes/account.route')).default;
const AuthRoute = (await import('./src/routes/auth.route')).default;
const AccountService = (await import('./src/services/account.service')).default;
const VaultFactoryService = (await import('./src/services/vaultFactory.service')).default;
const VaultService = (await import('./src/services/vault.service')).default;
const { CHAIN_KEYS, chainByKey } = await import('./src/config');

// Every service below is the real one, including the chain readers. Nothing is
// stubbed, so the `deployed` verdicts in the response are what the live chains
// actually say.
const factory = new VaultFactoryService();
const service = new AccountService(factory, new VaultService());
const api = new App([new AuthRoute(), new AccountRoute(new AccountController(service))]).getServer();

const line = (label, value) => console.log(`${label.padEnd(22)} ${value}`);

console.log('\n=== 1. Sign in (SIWE, real signature) ===');

const agent = request.agent(api);
const wallet = Wallet.createRandom();
const merchant = wallet.address.toLowerCase();

const nonceResponse = await agent.get('/auth/nonce').query({ address: merchant });
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
const verify = await agent.post('/auth/verify').send({ address: merchant, message, signature });

line('merchant', merchant);
line('POST /auth/verify', verify.status);

console.log('\n=== 2. Deterministic address, per network ===');
console.log('   live factory.vaultOf vs. what the backend predicted and stored\n');

const storedDocument = await mongoose.connection.db
  .collection('users')
  .findOne({ address: merchant });

let failures = 0;

const check = (ok, label, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

for (const chain of CHAIN_KEYS) {
  const { contracts, chainId, name } = chainByKey(chain);
  const stored = storedDocument?.vaults?.[chain];
  const onChain = await factory.vaultOf(chain, wallet.address);

  console.log(`\n${name} (chain ${chainId})`);
  line('  factory', contracts.factory);
  line('  implementation', contracts.vaultImplementation);
  line('  vaultOf (live chain)', onChain);
  line('  stored at sign-in', stored?.address ?? '(nothing stored)');

  check(
    stored?.address?.toLowerCase() === onChain.toLowerCase(),
    'stored address equals the factory’s answer',
  );
  check(stored?.chainId === chainId, 'stored chain id matches the network');
}

console.log('\n=== 3. Exposed through the account API ===');

const account = await agent.get('/account');
line('GET /account', account.status);
console.log('\n--- raw body, which is what the dashboard reads ---');
console.log(JSON.stringify(account.body, null, 2));

const served = account.body?.vaults ?? [];
check(served.length === CHAIN_KEYS.length, `serves one vault per network (${served.length})`);

for (const entry of served) {
  const onChain = await factory.vaultOf(entry.network, wallet.address);
  const deployed = await new VaultService().isDeployed(entry.network, onChain);

  console.log(`\n${entry.networkName ?? entry.network}`);
  line('  address', entry.address);
  line('  deployed', String(entry.deployed));
  line('  explorerUrl', entry.explorerUrl);

  check(entry.address.toLowerCase() === onChain.toLowerCase(), 'served address is the factory’s');
  check(entry.deployed === deployed, 'deployed verdict matches a live getCode check');
  check(
    entry.explorerUrl === `${chainByKey(entry.network).explorerUrl}/address/${entry.address}`,
    'explorer link is built from the network',
  );
}

console.log('\n=== 4. The vault is still not deployed ===');
console.log('   (a fresh merchant, so the addresses above must all be empty)\n');

for (const entry of served) {
  const code = await new VaultService().isDeployed(entry.network, entry.address);
  check(code === false, `${entry.network}: no code at the deterministic address`);

  // The point of the step: an address exists, funds can be addressed to it, and
  // nothing has been deployed — which is the state the rest of the system must
  // be built to cope with.
  check(entry.deployed === false, `${entry.network}: API reports not deployed`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);

await mongoose.disconnect();
await mongo.stop();

process.exit(failures === 0 ? 0 : 1);
