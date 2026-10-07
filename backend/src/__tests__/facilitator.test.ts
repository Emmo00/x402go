import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Wallet } from 'ethers';
import type { Application } from 'express';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { getAddress } from 'viem';

import {
  chainByKey,
  feesFor,
  tokensFor,
  type ChainKey,
  type TokenConfig,
} from '../config';
import FacilitatorController from '../controllers/facilitator.controller';
import settlementModel from '../models/settlements.model';
import FacilitatorRoute from '../routes/facilitator.route';
import ApiKeyService from '../services/apiKeys.service';
import FacilitatorService, { type FetchLike } from '../services/facilitator.service';
import SettlementService from '../services/settlement.service';
import X402Service from '../services/x402.service';
import { predictVaultAddress } from '../utils/vaultAddress';

/**
 * The facilitator proxy, end to end.
 *
 * Everything here is real — the router, the middleware, the controller, both
 * services, and a real MongoDB — except the two things that cannot be: Celo's
 * facilitator, which is scripted through the injectable `fetch`, and the chain
 * itself, which this path never touches.
 *
 * Scripting the facilitator is not a shortcut around a hard test. The cases
 * that decide whether money is counted twice are a timeout, a rejection with an
 * unusable body, and two identical requests arriving at once; none of them can
 * be produced on demand from a live service, and a suite that depended on Celo
 * answering would be testing Celo.
 *
 * The scripted fetch records every request, so the assertions that matter are
 * about what x402Go *sent* — the credential it presented, and whether the
 * signed payload came out the other side unchanged — not only about what it
 * returned.
 */

let mongo: MongoMemoryServer;
let apiApp: Application;
let facilitator: FacilitatorService;

const usersCollection = () => mongoose.connection.db!.collection('users');
const settlementsCollection = () => mongoose.connection.db!.collection('settlements');

/** A token from configuration, so an address is never retyped into a fixture. */
function tokenOn(chain: ChainKey, symbol: string): TokenConfig {
  const token = tokensFor(chain).find((candidate) => candidate.symbol === symbol);

  if (!token) throw new Error(`no ${symbol} is configured on ${chain}`);

  return token;
}

/** Celo Mainnet USDC: six decimals at one dollar, so the fee is 1000 + 1000. */
const USDC = tokenOn('celo', 'USDC');
const USDC_ADDRESS = USDC.address;

/** Celo Mainnet wARS: enabled, 18 decimals, and no dollar value configured. */
const WARS = tokenOn('celo', 'wARS');

/** $0.002 in a six-decimal token, which is what a payment must exceed. */
const TOTAL_FEE = BigInt(2000);

/** A dollar and two thousandths, in six-decimal units — the brief's example. */
const GROSS = BigInt(1_002_000);
const MERCHANT_AMOUNT = BigInt(1_000_000);

/** The facilitator credential the tests run with. It is not a real key. */
const FACILITATOR_KEY = 'test-facilitator-key-not-real';

// ---------------------------------------------------------------------------
// The scripted facilitator
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: any;
}

/** Every request x402Go made to the facilitator, in order. */
const calls: RecordedCall[] = [];

/** What the scripted facilitator should do for one call. */
type Reply =
  | { kind: 'json'; status?: number; body: unknown }
  | { kind: 'raw'; status?: number; text: string }
  | { kind: 'throw'; error: unknown }
  | { kind: 'inspect'; run: () => Promise<void>; then?: Reply };

/** Replies queued per endpoint; the last one repeats. */
const script: {
  supported?: Reply;
  verify?: Reply;
  settle?: Reply[];
} = {};

let settleIndex = 0;

function replyFor(endpoint: string): Reply | undefined {
  if (endpoint === 'settle') {
    const queue = script.settle ?? [];
    const reply = queue[Math.min(settleIndex, queue.length - 1)];
    settleIndex += 1;

    return reply;
  }

  return script[endpoint as 'supported' | 'verify'];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function resolveReply(reply: Reply): Promise<Response> {
  if (reply.kind === 'throw') throw reply.error;

  if (reply.kind === 'inspect') {
    await reply.run();

    return reply.then ? resolveReply(reply.then) : jsonResponse({});
  }

  if (reply.kind === 'raw') {
    return new Response(reply.text, {
      status: reply.status ?? 200,
      headers: { 'content-type': 'text/html' },
    });
  }

  return jsonResponse(reply.body, reply.status ?? 200);
}

const scriptedFetch: FetchLike = async (url, init) => {
  const endpoint = url.split('/').pop() ?? '';

  calls.push({
    url,
    method: init.method ?? 'GET',
    headers: (init.headers ?? {}) as Record<string, string>,
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  });

  const reply = replyFor(endpoint);

  if (!reply) throw new Error(`the test scripted no reply for ${endpoint}`);

  return resolveReply(reply);
};

/** A plausible facilitator settlement result. */
function settledReply(overrides: Record<string, unknown> = {}): Reply {
  return {
    kind: 'json',
    body: {
      success: true,
      transaction: `0x${'ab'.repeat(32)}`,
      network: 'eip155:42220',
      payer: '0x00000000000000000000000000000000000000aa',
      ...overrides,
    },
  };
}

/** A facilitator reporting that it will not settle this payment. */
function refusedReply(reason = 'insufficient_funds'): Reply {
  return {
    kind: 'json',
    body: {
      success: false,
      errorReason: reason,
      transaction: '',
      network: 'eip155:42220',
    },
  };
}

// ---------------------------------------------------------------------------
// Merchants and payments
// ---------------------------------------------------------------------------

interface Merchant {
  readonly userId: string;
  readonly address: string;
  readonly vault: string;
  readonly apiKey: string;
}

/** The vault the configured factory derives — computed, not read from a record. */
function derivedVault(address: string): string {
  const { factory, vaultImplementation } = chainByKey('celo').contracts;

  return predictVaultAddress(factory, vaultImplementation, getAddress(address)).toLowerCase();
}

/** An account with a vault and a working API key, created without any chain call. */
async function makeMerchant(): Promise<Merchant> {
  const wallet = Wallet.createRandom();
  const address = wallet.address.toLowerCase();

  const inserted = await usersCollection().insertOne({
    address,
    authChallenge: { nonce: 'test', expiredAt: new Date(Date.now() + 60_000), used: true },
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const userId = String(inserted.insertedId);
  const issued = await new ApiKeyService().createApiKey(userId);

  if (issued.status !== 'issued') throw new Error('could not issue a test API key');

  return { userId, address, vault: derivedVault(address), apiKey: issued.key.apiKey };
}

/** A v2 `exact` payment, as an x402 client would send it. */
function payment(options: {
  vault: string;
  amount: bigint;
  payer?: string;
  asset?: string;
  network?: string;
  nonce?: string;
  signedValue?: bigint;
  signedTo?: string;
  requirementsPayTo?: string;
  x402Version?: number;
  scheme?: string;
}) {
  const payer = options.payer ?? Wallet.createRandom().address.toLowerCase();
  const asset = options.asset ?? USDC_ADDRESS;
  const network = options.network ?? 'eip155:42220';
  const nonce = options.nonce ?? `0x${'11'.repeat(32)}`;

  const requirements = {
    scheme: options.scheme ?? 'exact',
    network,
    amount: options.amount.toString(),
    asset,
    payTo: options.requirementsPayTo ?? options.vault,
    maxTimeoutSeconds: 300,
    extra: { name: 'USDC', version: '2' },
  };

  return {
    payer,
    body: {
      x402Version: options.x402Version ?? 2,
      paymentRequirements: requirements,
      paymentPayload: {
        x402Version: options.x402Version ?? 2,
        accepted: requirements,
        payload: {
          signature: `0x${'cd'.repeat(65)}`,
          authorization: {
            from: payer,
            to: options.signedTo ?? options.vault,
            value: (options.signedValue ?? options.amount).toString(),
            validAfter: '0',
            validBefore: '9999999999',
            nonce,
          },
        },
      },
    },
  };
}

/** Posts a settle request with a key, returning the supertest response. */
function settle(apiKey: string, body: unknown) {
  return request(apiApp)
    .post('/settle')
    .set('Authorization', `Bearer ${apiKey}`)
    .send(body as object);
}

function verify(apiKey: string, body: unknown) {
  return request(apiApp)
    .post('/verify')
    .set('Authorization', `Bearer ${apiKey}`)
    .send(body as object);
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();

  if (!/^mongodb:\/\/127\.0\.0\.1:\d+/.test(uri)) {
    throw new Error(`Refusing to run facilitator tests against a non-loopback database: ${uri}`);
  }

  process.env.NODE_ENV = 'test';
  process.env.MONGO_CONNECTION_URL = uri;
  process.env.SESSION_SECRET = 'facilitator-test-session-secret';
  process.env.API_KEY_PEPPER = 'facilitator-test-pepper';
  process.env.OPERATOR_KEY = 'facilitator-test-operator-key';
  process.env.CELO_FACILITATOR_API_KEY = FACILITATOR_KEY;
  process.env.PORT = '0';

  await mongoose.connect(uri);

  // The unique `settlementId` index is the idempotency guarantee, and Mongoose
  // builds indexes in the background. Waiting for it here is what makes the
  // duplicate tests exercise the index rather than its creation timing.
  await settlementModel.init();

  const { default: App } = await import('../app');

  // One facilitator service, shared, so the `/supported` cache and the request
  // log are the ones the endpoints actually used.
  facilitator = new FacilitatorService(scriptedFetch, 500);

  apiApp = new App([
    new FacilitatorRoute(
      new FacilitatorController(
        new X402Service(),
        new SettlementService(facilitator),
        facilitator,
      ),
    ),
  ]).getServer();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  await usersCollection().deleteMany({});
  await settlementsCollection().deleteMany({});

  calls.length = 0;
  settleIndex = 0;
  delete script.supported;

  // `/supported` is cached per chain, and the cache is the endpoint's point —
  // so each test starts from a cold one rather than reading the previous test's.
  facilitator.clearCache();

  script.verify = { kind: 'json', body: { isValid: true, payer: '0x0' } };
  script.settle = [settledReply()];
});

// ---------------------------------------------------------------------------
// The arithmetic the guard is built on
// ---------------------------------------------------------------------------

describe('the fee schedule under test', () => {
  test('six-decimal USDC at one dollar costs 1000 + 1000 units', () => {
    const schedule = feesFor(USDC);

    expect(schedule).not.toBeNull();
    expect(schedule!.x402GoFee).toBe(BigInt(1000));
    expect(schedule!.facilitatorFee).toBe(BigInt(1000));
    expect(schedule!.totalFee).toBe(TOTAL_FEE);
  });

  test('an 18-decimal local-currency token has no fee schedule', () => {
    // Not the same as a zero fee: it means no fee can be computed, which the
    // guard treats as a refusal. See `config/fees.ts`.
    expect(feesFor(WARS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /supported
// ---------------------------------------------------------------------------

const SUPPORTED_BODY = {
  kinds: [
    {
      x402Version: 2,
      scheme: 'exact',
      network: 'eip155:42220',
      extra: { supportedAssets: [{ asset: USDC_ADDRESS, symbol: 'USDC', decimals: 6 }] },
    },
  ],
  extensions: ['eip2612GasSponsoring'],
  signers: { 'eip155:42220': ['0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48'] },
};

describe('GET /supported', () => {
  test('proxies the facilitator response unchanged', async () => {
    script.supported = { kind: 'json', body: SUPPORTED_BODY };

    const response = await request(apiApp).get('/supported');

    expect(response.status).toBe(200);
    // Deep equality, not a field check: the endpoint's job is to be a stable
    // URL for Celo's answer, so reshaping it here would be the bug.
    expect(response.body).toEqual(SUPPORTED_BODY);
  });

  test('needs no API key', async () => {
    script.supported = { kind: 'json', body: SUPPORTED_BODY };

    const response = await request(apiApp).get('/supported');

    expect(response.status).toBe(200);
    expect(response.body.kinds).toBeDefined();
  });

  test('presents the Celo credential on the way out', async () => {
    script.supported = { kind: 'json', body: SUPPORTED_BODY };

    await request(apiApp).get('/supported');

    expect(calls).toHaveLength(1);
    expect(calls[0].headers['X-API-Key']).toBe(FACILITATOR_KEY);
  });

  test('never returns the Celo credential', async () => {
    script.supported = { kind: 'json', body: SUPPORTED_BODY };

    const response = await request(apiApp).get('/supported');

    expect(JSON.stringify(response.body)).not.toContain(FACILITATOR_KEY);
    expect(JSON.stringify(response.headers)).not.toContain(FACILITATOR_KEY);
  });

  test('reports a facilitator that cannot be reached', async () => {
    script.supported = { kind: 'throw', error: new TypeError('fetch failed') };

    const response = await request(apiApp).get('/supported');

    expect(response.status).toBe(503);
    expect(response.body.message).not.toContain(FACILITATOR_KEY);
  });

  test('reports a facilitator that answers with something unusable', async () => {
    script.supported = { kind: 'raw', status: 502, text: '<html>bad gateway</html>' };

    const response = await request(apiApp).get('/supported');

    expect(response.status).toBe(502);
  });

  test('reports a facilitator that answers without the expected shape', async () => {
    script.supported = { kind: 'json', body: { unexpected: true } };

    const response = await request(apiApp).get('/supported');

    expect(response.status).toBe(502);
  });

  test('serves the network that was asked for', async () => {
    script.supported = { kind: 'json', body: SUPPORTED_BODY };

    await request(apiApp).get('/supported').query({ network: 'eip155:11142220' });

    expect(calls[0].url).toBe('https://api.x402.sepolia.celo.org/supported');
  });

  test('defaults to mainnet rather than quietly answering from a testnet', async () => {
    script.supported = { kind: 'json', body: SUPPORTED_BODY };

    await request(apiApp).get('/supported');

    expect(calls[0].url).toBe('https://api.x402.celo.org/supported');
  });

  test('refuses a network it does not serve', async () => {
    const response = await request(apiApp).get('/supported').query({ network: 'eip155:8453' });

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('does not spend a facilitator call on every request', async () => {
    script.supported = { kind: 'json', body: SUPPORTED_BODY };

    await request(apiApp).get('/supported');
    await request(apiApp).get('/supported');

    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// POST /verify
// ---------------------------------------------------------------------------

describe('POST /verify', () => {
  test('requires an API key', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    const response = await request(apiApp).post('/verify').send(body);

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  test('rejects an unknown API key, and says nothing about why', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    const response = await verify('x402go_not_a_real_key', body);

    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Invalid API key');
    expect(calls).toHaveLength(0);
  });

  test('returns the facilitator answer for a well-formed payment', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });
    script.verify = { kind: 'json', body: { isValid: true, payer: '0xabc' } };

    const response = await verify(merchant.apiKey, body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ isValid: true, payer: '0xabc' });
  });

  test('passes an invalid payment through as an answer, not an error', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });
    script.verify = {
      kind: 'json',
      body: { isValid: false, invalidReason: 'insufficient_funds' },
    };

    const response = await verify(merchant.apiKey, body);

    // The verification succeeded; the payment did not. A caller reads `isValid`.
    expect(response.status).toBe(200);
    expect(response.body.isValid).toBe(false);
    expect(response.body.invalidReason).toBe('insufficient_funds');
  });

  test('resolves the merchant from the key and sends them to the facilitator', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    await verify(merchant.apiKey, body);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.x402.celo.org/verify');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['X-API-Key']).toBe(FACILITATOR_KEY);
  });

  test('accepts a payment addressed to the caller own vault', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    const response = await verify(merchant.apiKey, body);

    expect(response.status).toBe(200);
  });

  test('rejects a payment addressed to an arbitrary wallet', async () => {
    const merchant = await makeMerchant();
    const attacker = Wallet.createRandom().address;
    const { body } = payment({ vault: attacker, amount: GROSS });

    const response = await verify(merchant.apiKey, body);

    expect(response.status).toBe(403);
    // Refused before Celo was asked: a payment to the wrong address is not a
    // question worth spending a facilitator call on.
    expect(calls).toHaveLength(0);
  });

  test('rejects a signed payment whose recipient differs from the requirements', async () => {
    const merchant = await makeMerchant();
    const elsewhere = Wallet.createRandom().address;

    const { body } = payment({
      vault: merchant.vault,
      amount: GROSS,
      // The advertised requirements name the merchant's vault, but the payer
      // signed a transfer to somewhere else. Only the signed half moves money.
      signedTo: elsewhere,
    });

    const response = await verify(merchant.apiKey, body);

    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test('rejects a payment to another merchant vault', async () => {
    const victim = await makeMerchant();
    const attacker = await makeMerchant();

    // The attacker presents their own key but a payment made out to the
    // victim's vault. It is not addressed to their own vault, so it is refused.
    const { body } = payment({ vault: victim.vault, amount: GROSS });

    const response = await verify(attacker.apiKey, body);

    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test('rejects an unsupported network', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({
      vault: merchant.vault,
      amount: GROSS,
      network: 'eip155:8453',
    });

    const response = await verify(merchant.apiKey, body);

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('rejects an unsupported token', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({
      vault: merchant.vault,
      amount: GROSS,
      asset: Wallet.createRandom().address,
    });

    const response = await verify(merchant.apiKey, body);

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('rejects a token that has no price configured', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({
      vault: merchant.vault,
      asset: WARS.address,
      amount: BigInt('1002000000000000000000'),
    });

    const response = await verify(merchant.apiKey, body);

    // Not a bad payment — a fee this server cannot compute, so it will not
    // guess at one. Nothing reaches Celo.
    expect(response.status).toBe(500);
    expect(calls).toHaveLength(0);
  });

  test('rejects an x402 version it does not speak', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({
      vault: merchant.vault,
      amount: GROSS,
      x402Version: 1,
    });

    const response = await verify(merchant.apiKey, body);

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('rejects a scheme it does not settle', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({
      vault: merchant.vault,
      amount: GROSS,
      scheme: 'upto',
    });

    const response = await verify(merchant.apiKey, body);

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('rejects an amount equal to the total fees', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: TOTAL_FEE });

    const response = await verify(merchant.apiKey, body);

    expect(response.status).toBe(402);
    expect(calls).toHaveLength(0);
  });

  test('rejects an amount below the total fees', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: TOTAL_FEE - BigInt(1) });

    const response = await verify(merchant.apiKey, body);

    expect(response.status).toBe(402);
    expect(calls).toHaveLength(0);
  });

  test('accepts an amount one unit above the total fees', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: TOTAL_FEE + BigInt(1) });

    const response = await verify(merchant.apiKey, body);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test('rejects a signed value that disagrees with the requirements', async () => {
    const merchant = await makeMerchant();

    // The requirements advertise a large payment; the payer signed a tiny one.
    // Reading the advertised figure would let this through as if it were large.
    const { body } = payment({ vault: merchant.vault, amount: GROSS, signedValue: BigInt(1) });

    const response = await verify(merchant.apiKey, body);

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('forwards the signed payload unchanged', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    await verify(merchant.apiKey, body);

    expect(calls[0].body.paymentPayload).toEqual(body.paymentPayload);
    expect(calls[0].body.paymentRequirements).toEqual(body.paymentRequirements);
  });

  test('never sends the merchant x402Go API key to Celo', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    await verify(merchant.apiKey, body);

    expect(JSON.stringify(calls[0])).not.toContain(merchant.apiKey);
    expect(calls[0].headers['X-API-Key']).toBe(FACILITATOR_KEY);
  });

  test('records nothing — verifying is a question, not a transaction', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    await verify(merchant.apiKey, body);

    expect(await settlementsCollection().countDocuments()).toBe(0);
  });

  test('reports a facilitator that cannot be reached', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });
    script.verify = { kind: 'throw', error: new TypeError('fetch failed') };

    const response = await verify(merchant.apiKey, body);

    expect(response.status).toBe(503);
  });

  test('refuses when this server has no facilitator credential', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    const previous = process.env.CELO_FACILITATOR_API_KEY;
    delete process.env.CELO_FACILITATOR_API_KEY;

    try {
      const response = await verify(merchant.apiKey, body);

      expect(response.status).toBe(500);
      expect(calls).toHaveLength(0);
    } finally {
      process.env.CELO_FACILITATOR_API_KEY = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// POST /settle
// ---------------------------------------------------------------------------

describe('POST /settle', () => {
  test('requires an API key', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    const response = await request(apiApp).post('/settle').send(body);

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
    expect(await settlementsCollection().countDocuments()).toBe(0);
  });

  test('rejects an unknown API key', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    const response = await settle('x402go_not_a_real_key', body);

    expect(response.status).toBe(401);
    expect(await settlementsCollection().countDocuments()).toBe(0);
  });

  test('settles a payment to the caller own vault', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    const response = await settle(merchant.apiKey, body);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.transaction).toBe(`0x${'ab'.repeat(32)}`);
  });

  test('rejects a payment addressed to an arbitrary wallet', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: Wallet.createRandom().address, amount: GROSS });

    const response = await settle(merchant.apiKey, body);

    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(await settlementsCollection().countDocuments()).toBe(0);
  });

  test('will not settle against another merchant vault', async () => {
    const victim = await makeMerchant();
    const attacker = await makeMerchant();
    const { body } = payment({ vault: victim.vault, amount: GROSS });

    const response = await settle(attacker.apiKey, body);

    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
    // Nothing recorded against either merchant.
    expect(await settlementsCollection().countDocuments()).toBe(0);
  });

  test('enforces the fee guard before contacting Celo', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: TOTAL_FEE });

    const response = await settle(merchant.apiKey, body);

    expect(response.status).toBe(402);
    expect(calls).toHaveLength(0);
    expect(await settlementsCollection().countDocuments()).toBe(0);
  });

  test('computes the accounting from the signed amount, server-side', async () => {
    const merchant = await makeMerchant();

    // The brief's own example: $1.000 to the merchant, $0.001 to x402Go,
    // $0.001 to Celo, so the buyer signs $1.002.
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    const response = await settle(merchant.apiKey, body);
    const record = response.body.settlement;

    expect(record.grossAmount).toBe('1002000');
    expect(record.x402GoFee).toBe('1000');
    expect(record.facilitatorFee).toBe('1000');
    expect(record.totalFee).toBe('2000');
    expect(record.merchantAmount).toBe('1000000');

    // The invariant the whole record rests on.
    expect(BigInt(record.grossAmount)).toBe(
      BigInt(record.merchantAmount) + BigInt(record.totalFee),
    );
  });

  test('ignores fee values supplied by the client', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    // A buyer claiming the fees are a thousandth of what they are. Nothing in
    // the request is read for this.
    (body.paymentRequirements as any).extra.fee = '1';
    (body.paymentPayload as any).fee = '1';
    (body as any).totalFee = '1';
    (body as any).merchantAmount = '1002000';

    const response = await settle(merchant.apiKey, body);

    expect(response.body.settlement.totalFee).toBe('2000');
    expect(response.body.settlement.merchantAmount).toBe('1000000');
  });

  test('writes the pending record before calling Celo', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    let atCallTime: any = null;

    // Read the collection at the moment the facilitator is called. If the
    // record were written after the answer, a payment in flight would be
    // invisible — which is exactly the state that has to be representable.
    script.settle = [
      {
        kind: 'inspect',
        run: async () => {
          atCallTime = await settlementsCollection().findOne({});
        },
        then: settledReply(),
      },
    ];

    await settle(merchant.apiKey, body);

    expect(atCallTime).not.toBeNull();
    expect(atCallTime.status).toBe('pending');
    expect(atCallTime.merchantId).toBe(merchant.userId);
    expect(atCallTime.vaultAddress).toBe(merchant.vault);
  });

  test('records the merchant, vault, payer and payment identity', async () => {
    const merchant = await makeMerchant();
    const { body, payer } = payment({ vault: merchant.vault, amount: GROSS });

    const response = await settle(merchant.apiKey, body);
    const record = response.body.settlement;

    expect(record.payTo).toBe(merchant.vault);
    expect(record.payer).toBe(payer);
    expect(record.asset.toLowerCase()).toBe(USDC_ADDRESS.toLowerCase());
    // The record stores the canonical chain key, not the spelling the request
    // happened to use, so one chain cannot appear under two names.
    expect(record.network).toBe('celo');
    expect(record.chainId).toBe(42220);
    expect(record.x402Version).toBe(2);
    expect(record.scheme).toBe('exact');
    expect(record.nonce).toBe(body.paymentPayload.payload.authorization.nonce);
  });

  test('marks the settlement settled and persists the transaction hash', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });
    const hash = `0x${'ef'.repeat(32)}`;
    script.settle = [settledReply({ transaction: hash })];

    const response = await settle(merchant.apiKey, body);

    expect(response.body.settlement.status).toBe('settled');
    expect(response.body.settlement.transactionHash).toBe(hash);
    expect(response.body.settlement.settledAt).toBeDefined();

    const stored = await settlementsCollection().findOne({});
    expect(stored!.status).toBe('settled');
    expect(stored!.transactionHash).toBe(hash);
  });

  test('stores the facilitator response verbatim', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });
    const result = {
      success: true,
      transaction: `0x${'ab'.repeat(32)}`,
      network: 'eip155:42220',
      extra: { somethingCeloAdded: true },
    };
    script.settle = [{ kind: 'json', body: result }];

    await settle(merchant.apiKey, body);

    const stored = await settlementsCollection().findOne({});
    expect(stored!.facilitatorResponse).toEqual(result);
  });

  test('counts nothing until Celo says it succeeded', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    // The read happens at the moment of the call — before any answer exists.
    let whilePending: any = null;
    script.settle = [
      {
        kind: 'inspect',
        run: async () => {
          whilePending = await settlementsCollection().findOne({});
        },
        then: settledReply(),
      },
    ];

    await settle(merchant.apiKey, body);

    expect(whilePending.status).toBe('pending');
    expect(whilePending.settledAt).toBeUndefined();
  });

  test('marks a settlement Celo refused as failed, and credits nothing', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });
    script.settle = [refusedReply()];

    const response = await settle(merchant.apiKey, body);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(false);
    expect(response.body.errorReason).toBe('insufficient_funds');

    const stored = await settlementsCollection().findOne({});
    expect(stored!.status).toBe('failed');
    expect(stored!.settledAt).toBeUndefined();
  });

  test('a failed settlement contributes nothing to the merchant totals', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });
    script.settle = [refusedReply()];

    await settle(merchant.apiKey, body);

    // The ledger projection: only settled records count.
    const totals = await new SettlementService().settledTotals(merchant.userId);
    expect(totals).toEqual([]);
  });

  test('a settled payment appears in the merchant totals', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    await settle(merchant.apiKey, body);

    const totals = await new SettlementService().settledTotals(merchant.userId);
    expect(totals).toHaveLength(1);
    // What the merchant is owed: the gross less both fees.
    expect(totals[0].amount).toBe(MERCHANT_AMOUNT.toString());
    expect(totals[0].asset.toLowerCase()).toBe(USDC_ADDRESS.toLowerCase());
  });

  test('an ambiguous settlement is marked for reconciliation, not failed', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });
    script.settle = [{ kind: 'throw', error: new TypeError('socket hang up') }];

    const response = await settle(merchant.apiKey, body);

    expect(response.status).toBe(409);
    expect(response.body.errorReason).toBe('settlement_pending_reconciliation');

    const stored = await settlementsCollection().findOne({});
    expect(stored!.status).toBe('pending_reconciliation');
    expect(stored!.settledAt).toBeUndefined();
  });

  test('a timeout is ambiguous, not failed', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    const timeout = Object.assign(new Error('timed out'), { name: 'AbortError' });
    script.settle = [{ kind: 'throw', error: timeout }];

    const response = await settle(merchant.apiKey, body);

    expect(response.status).toBe(409);
    expect((await settlementsCollection().findOne({}))!.status).toBe('pending_reconciliation');
  });

  test('a facilitator that answers unusably is ambiguous, not failed', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });
    script.settle = [{ kind: 'raw', status: 502, text: '<html>bad gateway</html>' }];

    const response = await settle(merchant.apiKey, body);

    // The request reached *something*. It may have reached Celo.
    expect(response.status).toBe(409);
    expect((await settlementsCollection().findOne({}))!.status).toBe('pending_reconciliation');
  });

  test('an ambiguous settlement is never retried by the next request', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    script.settle = [{ kind: 'throw', error: new TypeError('socket hang up') }];
    await settle(merchant.apiKey, body);

    const afterFirst = calls.length;

    // The same signed payment presented again. The facilitator must not be
    // asked a second time: it may already have moved the money.
    script.settle = [settledReply()];
    const second = await settle(merchant.apiKey, body);

    expect(calls.length).toBe(afterFirst);
    expect(second.status).toBe(409);
    expect((await settlementsCollection().findOne({}))!.status).toBe('pending_reconciliation');
  });

  test('a duplicate settlement does not settle twice or record twice', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    const first = await settle(merchant.apiKey, body);
    const second = await settle(merchant.apiKey, body);

    expect(first.body.duplicate).toBe(false);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.settlement.settlementId).toBe(first.body.settlement.settlementId);

    // One facilitator call, one record.
    expect(calls).toHaveLength(1);
    expect(await settlementsCollection().countDocuments()).toBe(1);
  });

  test('a duplicate does not credit the merchant twice', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    await settle(merchant.apiKey, body);
    await settle(merchant.apiKey, body);
    await settle(merchant.apiKey, body);

    const totals = await new SettlementService().settledTotals(merchant.userId);

    expect(totals).toHaveLength(1);
    expect(totals[0].amount).toBe(MERCHANT_AMOUNT.toString());
  });

  test('two identical requests in flight at once settle only once', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    // Pause inside the facilitator call so both requests are genuinely in
    // flight together, which is the only way to test the claim-swap.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    script.settle = [{ kind: 'inspect', run: () => gate, then: settledReply() }];

    const both = Promise.all([settle(merchant.apiKey, body), settle(merchant.apiKey, body)]);

    // Let both reach the facilitator boundary before either is answered.
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();

    const [a, b] = await both;

    // Exactly one submission reached Celo, and exactly one record exists.
    expect(calls).toHaveLength(1);
    expect(await settlementsCollection().countDocuments()).toBe(1);
    expect([a.body.duplicate, b.body.duplicate].filter(Boolean)).toHaveLength(1);
  });

  test('a genuinely different payment is a different settlement', async () => {
    const merchant = await makeMerchant();

    const first = payment({ vault: merchant.vault, amount: GROSS });
    const second = payment({
      vault: merchant.vault,
      amount: GROSS,
      nonce: `0x${'22'.repeat(32)}`,
    });

    const a = await settle(merchant.apiKey, first.body);
    const b = await settle(merchant.apiKey, second.body);

    // The replay nonce is what distinguishes them.
    expect(a.body.settlement.settlementId).not.toBe(b.body.settlement.settlementId);
    expect(await settlementsCollection().countDocuments()).toBe(2);
    expect(calls).toHaveLength(2);
  });

  test('a failed settlement is not retried on a duplicate request', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });
    script.settle = [refusedReply()];

    await settle(merchant.apiKey, body);
    const before = calls.length;

    script.settle = [settledReply()];
    const second = await settle(merchant.apiKey, body);

    // Celo already said no to this exact signature; asking again cannot help.
    expect(calls.length).toBe(before);
    expect(second.body.success).toBe(false);
  });

  test('forwards the signed payload unchanged', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    await settle(merchant.apiKey, body);

    expect(calls[0].body.paymentPayload).toEqual(body.paymentPayload);
    expect(calls[0].body.paymentRequirements).toEqual(body.paymentRequirements);
    expect(calls[0].body.x402Version).toBe(2);
  });

  test('never sends the merchant x402Go API key to Celo', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    await settle(merchant.apiKey, body);

    expect(JSON.stringify(calls[0])).not.toContain(merchant.apiKey);
    expect(calls[0].headers['X-API-Key']).toBe(FACILITATOR_KEY);
  });

  test('never returns the Celo credential to the caller', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    const response = await settle(merchant.apiKey, body);

    expect(JSON.stringify(response.body)).not.toContain(FACILITATOR_KEY);
  });

  test('refuses when this server has no facilitator credential', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    const previous = process.env.CELO_FACILITATOR_API_KEY;
    delete process.env.CELO_FACILITATOR_API_KEY;

    try {
      const response = await settle(merchant.apiKey, body);

      // Nothing was sent, so this is the one facilitator failure that is known
      // rather than unknown — and it is recorded as a failure, not as something
      // a human has to reconcile.
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBe('facilitator-key-unusable');
      expect(calls).toHaveLength(0);
      expect((await settlementsCollection().findOne({}))!.status).toBe('failed');
    } finally {
      process.env.CELO_FACILITATOR_API_KEY = previous;
    }
  });

  test('a blank facilitator credential is treated as no credential', async () => {
    const merchant = await makeMerchant();
    const { body } = payment({ vault: merchant.vault, amount: GROSS });

    const previous = process.env.CELO_FACILITATOR_API_KEY;
    process.env.CELO_FACILITATOR_API_KEY = '   ';

    try {
      await settle(merchant.apiKey, body);

      expect((await settlementsCollection().findOne({}))!.status).toBe('failed');
    } finally {
      process.env.CELO_FACILITATOR_API_KEY = previous;
    }
  });

  test('a malformed body is refused without a facilitator call', async () => {
    const merchant = await makeMerchant();

    for (const body of [
      {},
      { x402Version: 2 },
      { x402Version: 2, paymentRequirements: {}, paymentPayload: {} },
      {
        x402Version: 2,
        paymentRequirements: { scheme: 'exact' },
        paymentPayload: { payload: {} },
      },
      { x402Version: '2', paymentRequirements: {}, paymentPayload: {} },
    ]) {
      const response = await settle(merchant.apiKey, body);

      expect(response.status).toBe(400);
    }

    expect(calls).toHaveLength(0);
    expect(await settlementsCollection().countDocuments()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Isolation between merchants
// ---------------------------------------------------------------------------

describe('merchant isolation', () => {
  test('one merchant key cannot settle against another vault', async () => {
    const alice = await makeMerchant();
    const bob = await makeMerchant();

    const toAlice = payment({ vault: alice.vault, amount: GROSS });
    const response = await settle(bob.apiKey, toAlice.body);

    expect(response.status).toBe(403);
    expect(await settlementsCollection().countDocuments()).toBe(0);
  });

  test('a settlement is recorded against the key that authenticated it', async () => {
    const alice = await makeMerchant();
    const bob = await makeMerchant();

    const { body } = payment({ vault: bob.vault, amount: GROSS });
    await settle(bob.apiKey, body);

    const stored = await settlementsCollection().findOne({});
    expect(stored!.merchantId).toBe(bob.userId);
    expect(stored!.merchantId).not.toBe(alice.userId);
  });

  test('totals are per merchant', async () => {
    const alice = await makeMerchant();
    const bob = await makeMerchant();

    const forAlice = payment({ vault: alice.vault, amount: GROSS });
    const forBob = payment({
      vault: bob.vault,
      amount: BigInt(2_002_000),
      nonce: `0x${'33'.repeat(32)}`,
    });

    await settle(alice.apiKey, forAlice.body);
    await settle(bob.apiKey, forBob.body);

    const service = new SettlementService();
    const aliceTotals = await service.settledTotals(alice.userId);
    const bobTotals = await service.settledTotals(bob.userId);

    expect(aliceTotals[0].amount).toBe(MERCHANT_AMOUNT.toString());
    expect(bobTotals[0].amount).toBe('2000000');
  });

  test('a client cannot name the merchant it is paying', async () => {
    const alice = await makeMerchant();
    const bob = await makeMerchant();

    const { body } = payment({ vault: alice.vault, amount: GROSS });

    // Every plausible way of claiming to be somebody else. None of them is read.
    (body as any).merchantId = bob.userId;
    (body as any).merchant = bob.address;
    (body as any).payTo = alice.vault;

    const response = await settle(bob.apiKey, body);

    // Bob's key, Alice's vault: refused, because the vault comes from the key.
    expect(response.status).toBe(403);
    expect(await settlementsCollection().countDocuments()).toBe(0);
  });
});
