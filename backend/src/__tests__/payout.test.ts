import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Wallet } from 'ethers';
import type { Application } from 'express';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { SiweMessage } from 'siwe';
import request from 'supertest';

import AuthRoute from '../routes/auth.route';
import PayoutRoute from '../routes/payout.route';

/**
 * End-to-end tests for the payout address.
 *
 * Like the API-key suite, these run against the real Express app and a real
 * MongoDB: what is under test is the session-gated route, the schema's
 * normalisation, and the fact that an account can only ever reach its own
 * address — all properties of the wiring and the database write, not of a
 * mock.
 *
 * Bun auto-loads `.env`, which in this project points at a hosted cluster, so
 * `MONGO_CONNECTION_URL` is overwritten before the app is constructed and the
 * URI is checked to be loopback before anything writes to it.
 */

let mongo: MongoMemoryServer;
let apiApp: Application;

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
  const verifyResponse = await agent
    .post('/auth/verify')
    .send({ address, message, signature });

  expect(verifyResponse.status).toBe(200);

  return { agent, address };
}

/** A checksummed address of the sort a wallet hands to a UI. */
function someAddress(): string {
  return Wallet.createRandom().address;
}

async function storedPayTo(address: string) {
  const document = await usersCollection().findOne({ address });

  return document?.payTo as string | undefined;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();

  if (!/^mongodb:\/\/127\.0\.0\.1:\d+/.test(uri)) {
    throw new Error(`Refusing to run payout tests against a non-loopback database: ${uri}`);
  }

  process.env.NODE_ENV = 'test';
  process.env.MONGO_CONNECTION_URL = uri;
  process.env.SESSION_SECRET = 'payout-test-session-secret';
  process.env.API_KEY_PEPPER = 'payout-test-pepper';
  process.env.PORT = '0';

  await mongoose.connect(uri);

  // Imported after the environment is redirected so the app connects to the
  // in-memory instance rather than whatever `.env` pointed at.
  const { default: App } = await import('../app');

  apiApp = new App([new AuthRoute(), new PayoutRoute()]).getServer();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  await usersCollection().deleteMany({});
});

describe('GET /payout', () => {
  test('reports null for an account that has not set an address', async () => {
    const { agent } = await signIn();

    const response = await agent.get('/payout');

    expect(response.status).toBe(200);
    expect(response.body.payTo).toBeNull();
  });

  test('refuses an unauthenticated caller', async () => {
    const response = await request(apiApp).get('/payout');

    expect(response.status).toBe(401);
    expect(response.body.payTo).toBeUndefined();
  });

  test('returns the address that was set', async () => {
    const { agent } = await signIn();
    const payTo = someAddress();

    await agent.put('/payout').send({ payTo });

    const response = await agent.get('/payout');

    expect(response.status).toBe(200);
    expect(response.body.payTo).toBe(payTo.toLowerCase());
  });

  test('never returns another account’s address', async () => {
    const first = await signIn();
    const second = await signIn();

    await first.agent.put('/payout').send({ payTo: someAddress() });

    const response = await second.agent.get('/payout');

    expect(response.body.payTo).toBeNull();
  });
});

describe('PUT /payout', () => {
  test('stores the address and echoes it back', async () => {
    const { agent, address } = await signIn();
    const payTo = someAddress();

    const response = await agent.put('/payout').send({ payTo });

    expect(response.status).toBe(200);
    expect(response.body.payTo).toBe(payTo.toLowerCase());
    expect(await storedPayTo(address)).toBe(payTo.toLowerCase());
  });

  test('normalises the address to lower case', async () => {
    const { agent, address } = await signIn();
    // A checksummed address — mixed case on the wire, one value on disk.
    const payTo = someAddress();
    expect(payTo).not.toBe(payTo.toLowerCase());

    await agent.put('/payout').send({ payTo });

    const stored = await storedPayTo(address);

    expect(stored).toBe(payTo.toLowerCase());
    expect(stored).toMatch(/^0x[0-9a-f]{40}$/);
  });

  test('accepts an all-lowercase address', async () => {
    const { agent } = await signIn();
    const payTo = someAddress().toLowerCase();

    const response = await agent.put('/payout').send({ payTo });

    expect(response.status).toBe(200);
    expect(response.body.payTo).toBe(payTo);
  });

  test('is idempotent', async () => {
    const { agent, address } = await signIn();
    const payTo = someAddress();

    await agent.put('/payout').send({ payTo });
    const second = await agent.put('/payout').send({ payTo });

    expect(second.status).toBe(200);
    expect(second.body.payTo).toBe(payTo.toLowerCase());
    expect(await storedPayTo(address)).toBe(payTo.toLowerCase());
  });

  test('replaces a previously set address', async () => {
    const { agent, address } = await signIn();
    const original = someAddress();
    const replacement = someAddress();

    await agent.put('/payout').send({ payTo: original });
    const response = await agent.put('/payout').send({ payTo: replacement });

    expect(response.body.payTo).toBe(replacement.toLowerCase());
    expect(await storedPayTo(address)).toBe(replacement.toLowerCase());
    expect(await storedPayTo(address)).not.toBe(original.toLowerCase());
  });

  test('refuses an unauthenticated caller', async () => {
    const payTo = someAddress();

    const response = await request(apiApp).put('/payout').send({ payTo });

    expect(response.status).toBe(401);
    expect(await usersCollection().countDocuments({ payTo: payTo.toLowerCase() })).toBe(0);
  });

  test('rejects a malformed address', async () => {
    const { agent, address } = await signIn();

    for (const payTo of [
      '',
      'not-an-address',
      '0x',
      '0x1234',
      // 41 bytes, and 19 bytes — one digit either side of correct.
      `0x${'a'.repeat(41)}`,
      `0x${'a'.repeat(39)}`,
      // Right length, wrong alphabet.
      `0x${'z'.repeat(40)}`,
      someAddress().slice(2),
    ]) {
      const response = await agent.put('/payout').send({ payTo });

      expect(response.status).toBe(400);
      expect(response.body.payTo).toBeUndefined();
    }

    expect(await storedPayTo(address)).toBeUndefined();
  });

  test('rejects the zero address', async () => {
    const { agent, address } = await signIn();

    const response = await agent
      .put('/payout')
      .send({ payTo: `0x${'0'.repeat(40)}` });

    expect(response.status).toBe(400);
    expect(await storedPayTo(address)).toBeUndefined();
  });

  test('rejects a missing or non-string payTo', async () => {
    const { agent, address } = await signIn();

    for (const body of [{}, { payTo: null }, { payTo: 42 }, { payTo: [someAddress()] }]) {
      const response = await agent.put('/payout').send(body);

      expect(response.status).toBe(400);
    }

    expect(await storedPayTo(address)).toBeUndefined();
  });

  test('never writes to another account', async () => {
    const first = await signIn();
    const second = await signIn();
    const firstPayTo = someAddress();
    const secondPayTo = someAddress();

    await first.agent.put('/payout').send({ payTo: firstPayTo });

    // The other account's address is not a field this endpoint reads, so
    // including it changes nothing about whose record is written. The write
    // lands on the session's account and leaves the first account alone.
    await second.agent
      .put('/payout')
      .send({ payTo: secondPayTo, address: first.address, userId: 'ignored' });

    expect(await storedPayTo(first.address)).toBe(firstPayTo.toLowerCase());
    expect(await storedPayTo(second.address)).toBe(secondPayTo.toLowerCase());
  });
});
