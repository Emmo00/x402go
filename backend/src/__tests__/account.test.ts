import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Wallet } from 'ethers';
import type { Application } from 'express';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { SiweMessage } from 'siwe';
import request from 'supertest';

import AccountRoute from '../routes/account.route';
import AuthRoute from '../routes/auth.route';

let mongo: MongoMemoryServer;
let apiApp: Application;

async function signIn() {
  const agent = request.agent(apiApp);
  const wallet = Wallet.createRandom();
  const address = wallet.address.toLowerCase();
  const nonce = await agent.get('/auth/nonce').query({ address });
  const message = new SiweMessage({
    domain: 'localhost',
    address: wallet.address,
    statement: 'Sign in to x402Go',
    uri: 'http://localhost',
    version: '1',
    chainId: 42220,
    nonce: nonce.body.nonce,
  }).prepareMessage();

  const signature = await wallet.signMessage(message);
  const response = await agent.post('/auth/verify').send({ address, message, signature });

  expect(response.status).toBe(200);
  return agent;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGO_CONNECTION_URL = mongo.getUri();
  process.env.SESSION_SECRET = 'account-test-session-secret';
  process.env.API_KEY_PEPPER = 'account-test-pepper';
  await mongoose.connect(mongo.getUri());
  const { default: App } = await import('../app');
  apiApp = new App([new AuthRoute(), new AccountRoute()]).getServer();
});

beforeEach(async () => {
  await mongoose.connection.db!.collection('users').deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('GET /account', () => {
  test('requires an authenticated session', async () => {
    const response = await request(apiApp).get('/account');

    expect(response.status).toBe(401);
  });

  test('returns the authenticated account without secret fields', async () => {
    const agent = await signIn();
    const response = await agent.get('/account');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      address: expect.stringMatching(/^0x[0-9a-f]{40}$/),
      apiKey: null,
    });
    expect(response.body).not.toHaveProperty('authChallenge');
    expect(response.body).not.toHaveProperty('apiKeyHash');
  });
});
