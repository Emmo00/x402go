import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Wallet } from 'ethers';
import express, { type Application } from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { SiweMessage } from 'siwe';
import request from 'supertest';

import apiKeyAuth from '../middlewares/apiKeyAuth.middleware';
import ApiKeysRoute from '../routes/apiKeys.route';
import AuthRoute from '../routes/auth.route';
import ApiKeyService from '../services/apiKeys.service';

/**
 * End-to-end tests for API-key creation and rotation.
 *
 * These run against the real Express app and a real MongoDB, because the
 * properties under test here — atomicity, one-active-key, timing-safe
 * verification, the plaintext never reaching disk — are properties of the
 * database operations and the middleware chain. A mocked model would assert
 * only that the mock was called.
 *
 * The database is a throwaway in-memory instance. Bun auto-loads `.env`, which
 * in this project points at a hosted cluster, so `MONGO_CONNECTION_URL` is
 * overwritten before the app is constructed and the URI is checked to be
 * loopback before anything writes to it.
 */

let mongo: MongoMemoryServer;
let apiApp: Application;
let probeApp: Application;

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
  expect(verifyResponse.body.success).toBe(true);

  return { agent, address };
}

/** Issues a key and returns the plaintext, failing loudly if it was not issued. */
async function createKey(agent: ReturnType<typeof request.agent>): Promise<string> {
  const response = await agent.post('/api-keys');
  expect(response.status).toBe(201);

  return response.body.apiKey as string;
}

/** The account's stored credential, read straight off the wire. */
async function storedKey(address: string) {
  return usersCollection().findOne({ address });
}

/**
 * Calls the probe route with a key presented in the given header.
 *
 * The response is awaited and asserted directly rather than through
 * `expect(...).resolves`, because supertest returns a thenable rather than a
 * real promise and `resolves` does not unwrap it.
 */
function probe(
  apiKey?: string,
  header: 'Authorization' | 'X-API-Key' = 'Authorization',
): request.Test {
  const call = request(probeApp).get('/probe');

  if (apiKey === undefined) {
    return call;
  }

  return call.set(header, header === 'Authorization' ? `Bearer ${apiKey}` : apiKey);
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();

  if (!/^mongodb:\/\/127\.0\.0\.1:\d+/.test(uri)) {
    throw new Error(`Refusing to run API-key tests against a non-loopback database: ${uri}`);
  }

  process.env.NODE_ENV = 'test';
  process.env.MONGO_CONNECTION_URL = uri;
  process.env.SESSION_SECRET = 'api-key-test-session-secret';
  process.env.API_KEY_PEPPER = 'api-key-test-pepper';
  process.env.PORT = '0';

  await mongoose.connect(uri);

  // Imported after the environment is redirected so the app connects to the
  // in-memory instance rather than whatever `.env` pointed at.
  const { default: App } = await import('../app');

  apiApp = new App([new AuthRoute(), new ApiKeysRoute()]).getServer();

  // `apiKeyAuth` gates future routes that do not exist yet, so it is exercised
  // through a probe mounted solely for that purpose — no production endpoint is
  // invented to make it testable.
  probeApp = express();
  probeApp.get('/probe', apiKeyAuth, (req, res) => {
    res.json({ address: req.user?.address });
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  await usersCollection().deleteMany({});
});

describe('POST /api-keys', () => {
  test('issues a key to an authenticated account', async () => {
    const { agent } = await signIn();

    const response = await agent.post('/api-keys');

    expect(response.status).toBe(201);
    expect(typeof response.body.apiKey).toBe('string');
  });

  test('refuses an unauthenticated caller', async () => {
    const response = await request(apiApp).post('/api-keys');

    expect(response.status).toBe(401);
    expect(response.body.apiKey).toBeUndefined();
  });

  test('refuses a second key for an account that already has one', async () => {
    const { agent } = await signIn();
    await createKey(agent);

    const second = await agent.post('/api-keys');

    expect(second.status).toBe(409);
    expect(second.body.apiKey).toBeUndefined();
  });

  test('returns the plaintext key, once, in the creating response', async () => {
    const { agent } = await signIn();

    const response = await agent.post('/api-keys');

    expect(response.status).toBe(201);
    expect(response.body.apiKey).toMatch(/^x402go_[A-Za-z0-9_-]{43}$/);

    // Nothing else in the response repeats it, and no later call reissues it.
    const payload = JSON.stringify(response.body);
    expect(payload.split(response.body.apiKey)).toHaveLength(2);
    expect(JSON.stringify((await agent.post('/api-keys')).body)).not.toContain(
      response.body.apiKey,
    );
  });

  test('never writes the plaintext key to the database', async () => {
    const { agent, address } = await signIn();
    const apiKey = await createKey(agent);

    const document = await storedKey(address);
    const onDisk = JSON.stringify(document);

    expect(typeof document?.apiKey?.hash).toBe('string');
    // Neither the whole key nor its entropy body appears anywhere in the record.
    expect(onDisk).not.toContain(apiKey);
    expect(onDisk).not.toContain(apiKey.slice('x402go_'.length));
  });

  test('stores the key suffix alongside the hash', async () => {
    const { agent, address } = await signIn();
    const apiKey = await createKey(agent);

    const document = await storedKey(address);

    expect(document?.apiKey?.suffix).toBe(apiKey.slice(-4));
    expect(document?.apiKey?.createdAt).toBeInstanceOf(Date);
  });

  test('stores no rotatedAt until the key is rotated', async () => {
    const { agent, address } = await signIn();
    await createKey(agent);

    const document = await storedKey(address);

    expect(document?.apiKey?.rotatedAt).toBeUndefined();
  });

  test('cannot create two active keys under concurrent requests', async () => {
    const { agent, address } = await signIn();

    const responses = await Promise.all([
      agent.post('/api-keys'),
      agent.post('/api-keys'),
      agent.post('/api-keys'),
      agent.post('/api-keys'),
      agent.post('/api-keys'),
    ]);

    const created = responses.filter((response) => response.status === 201);
    const rejected = responses.filter((response) => response.status === 409);

    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(4);

    const document = await storedKey(address);

    // Exactly one credential exists, and it is the one the winner was given.
    expect(typeof document?.apiKey?.hash).toBe('string');
    expect((await probe(created[0].body.apiKey)).status).toBe(200);
  });
});

describe('POST /api-keys/rotate', () => {
  test('issues a new key to an authenticated account', async () => {
    const { agent } = await signIn();
    await createKey(agent);

    const response = await agent.post('/api-keys/rotate');

    expect(response.status).toBe(200);
    expect(response.body.apiKey).toMatch(/^x402go_[A-Za-z0-9_-]{43}$/);
  });

  test('refuses an unauthenticated caller', async () => {
    const response = await request(apiApp).post('/api-keys/rotate');

    expect(response.status).toBe(401);
    expect(response.body.apiKey).toBeUndefined();
  });

  test('reports an account that does not exist', async () => {
    const { agent, address } = await signIn();
    await createKey(agent);

    // An account deleted after the session was issued: the session middleware
    // is what rejects it, before the controller is reached.
    await usersCollection().deleteOne({ address });

    const response = await agent.post('/api-keys/rotate');

    expect(response.status).toBe(401);

    // If that check is raced past, the service still reports the missing
    // account rather than mistaking it for "this account has no key".
    const raced = await new ApiKeyService().rotateApiKey(
      new mongoose.Types.ObjectId().toString(),
    );

    expect(raced.status).toBe('no-account');
  });

  test('invalidates the previous key immediately', async () => {
    const { agent } = await signIn();
    const original = await createKey(agent);

    expect((await probe(original)).status).toBe(200);

    await agent.post('/api-keys/rotate');

    // Same key, same middleware, no waiting: it is no longer a credential.
    expect((await probe(original)).status).toBe(401);
  });

  test('makes the new key valid immediately', async () => {
    const { agent } = await signIn();
    await createKey(agent);

    const rotated = await agent.post('/api-keys/rotate');

    expect((await probe(rotated.body.apiKey)).status).toBe(200);
  });

  test('replaces the stored hash rather than keeping the old one', async () => {
    const { agent, address } = await signIn();
    await createKey(agent);

    const before = await storedKey(address);
    await agent.post('/api-keys/rotate');
    const after = await storedKey(address);

    expect(after?.apiKey?.hash).toBeString();
    expect(after?.apiKey?.hash).not.toBe(before?.apiKey?.hash);
    // The superseded credential is gone, not parked alongside the new one.
    expect(JSON.stringify(after)).not.toContain(before?.apiKey?.hash);
  });

  test('stamps rotatedAt and restarts createdAt', async () => {
    const { agent, address } = await signIn();
    await createKey(agent);

    const before = await storedKey(address);
    await agent.post('/api-keys/rotate');
    const after = await storedKey(address);

    expect(after?.apiKey?.rotatedAt).toBeInstanceOf(Date);
    expect(after?.apiKey?.rotatedAt.getTime()).toBeGreaterThanOrEqual(
      before?.apiKey?.createdAt.getTime(),
    );
    expect(after?.apiKey?.createdAt.getTime()).toBe(after?.apiKey?.rotatedAt.getTime());
  });

  test('returns the rotated plaintext once and never reissues it', async () => {
    const { agent, address } = await signIn();
    await createKey(agent);

    const first = await agent.post('/api-keys/rotate');
    const rotatedKey = first.body.apiKey as string;

    expect(rotatedKey).toMatch(/^x402go_[A-Za-z0-9_-]{43}$/);

    // Not on disk, and not in any later response — including the next rotation.
    const onDisk = JSON.stringify(await storedKey(address));
    expect(onDisk).not.toContain(rotatedKey);
    expect(onDisk).not.toContain(rotatedKey.slice('x402go_'.length));

    const second = await agent.post('/api-keys/rotate');

    expect(second.body.apiKey).not.toBe(rotatedKey);
    expect(JSON.stringify(second.body)).not.toContain(rotatedKey);

    // Only the newest key authenticates; the intermediate one is already dead.
    expect((await probe(rotatedKey)).status).toBe(401);
    expect((await probe(second.body.apiKey)).status).toBe(200);
  });
});

describe('apiKeyAuth', () => {
  test('rejects a request with no key', async () => {
    expect((await probe()).status).toBe(401);
  });

  test('rejects a malformed or unknown key', async () => {
    for (const presented of ['', 'x402go_', 'not-a-key', `x402go_${'A'.repeat(43)}`]) {
      expect((await probe(presented)).status).toBe(401);
    }
  });

  test('accepts the key from either supported header', async () => {
    const { agent, address } = await signIn();
    const apiKey = await createKey(agent);

    const viaAuthorization = await probe(apiKey, 'Authorization');
    expect(viaAuthorization.status).toBe(200);
    expect(viaAuthorization.body.address).toBe(address);

    const viaApiKeyHeader = await probe(apiKey, 'X-API-Key');
    expect(viaApiKeyHeader.status).toBe(200);
    expect(viaApiKeyHeader.body.address).toBe(address);
  });

  test('resolves each key to its own account', async () => {
    const first = await signIn();
    const second = await signIn();
    const firstKey = await createKey(first.agent);
    const secondKey = await createKey(second.agent);

    expect(firstKey).not.toBe(secondKey);
    expect((await probe(firstKey)).body.address).toBe(first.address);
    expect((await probe(secondKey)).body.address).toBe(second.address);
  });
});

describe('logging', () => {
  test('never writes a plaintext key or its hash to the logs', async () => {
    const { agent, address } = await signIn();

    const captured: string[] = [];
    const record = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    };

    const originalConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);

    console.log = record;
    console.info = record;
    console.warn = record;
    console.error = record;
    console.debug = record;
    (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
      record(chunk);
      return originalStdoutWrite(chunk, ...rest);
    };
    (process.stderr as any).write = (chunk: any, ...rest: any[]) => {
      record(chunk);
      return originalStderrWrite(chunk, ...rest);
    };

    let created: string;
    let rotated: string;
    let hash: string;

    try {
      // Exercise every path that touches a key: issue, use, rotate, use again.
      const createResponse = await agent.post('/api-keys');
      created = createResponse.body.apiKey;

      await request(probeApp).get('/probe').set('Authorization', `Bearer ${created}`);
      await request(probeApp).get('/probe').set('Authorization', 'Bearer x402go_invalid');

      const rotateResponse = await agent.post('/api-keys/rotate');
      rotated = rotateResponse.body.apiKey;

      await request(probeApp).get('/probe').set('Authorization', `Bearer ${rotated}`);
      await request(probeApp).get('/probe').set('Authorization', `Bearer ${created}`);
      await agent.post('/api-keys');

      hash = (await storedKey(address))?.apiKey?.hash as string;
    } finally {
      console.log = originalConsole.log;
      console.info = originalConsole.info;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
      console.debug = originalConsole.debug;
      (process.stdout as any).write = originalStdoutWrite;
      (process.stderr as any).write = originalStderrWrite;
    }

    expect(hash).toBeString();

    const log = captured.join('\n');

    expect(log).not.toContain(created);
    expect(log).not.toContain(rotated);
    expect(log).not.toContain(created.slice('x402go_'.length));
    expect(log).not.toContain(hash);
    // The header the key travels in must not be dumped either.
    expect(log.toLowerCase()).not.toContain('x-api-key');
  });
});
