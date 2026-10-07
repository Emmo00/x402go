import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

import { VaultLifecycleError } from '../exceptions/VaultLifecycleError';
import lockModel from '../models/lock.model';
import { clearLocks, release, tryAcquire, vaultLockKey, withLock } from '../services/lock.service';

/**
 * The deployment lock, against a real MongoDB.
 *
 * The mechanism under test is a database operation, so a stubbed database would
 * be testing the stub: the whole claim is that one `findOneAndUpdate` upsert
 * makes "did I get it" a single atomic answer. That claim is about MongoDB's
 * behaviour, and only a real MongoDB can settle it.
 *
 * This is the heaviest thing in this suite — a second in-memory server — and it
 * is worth it for the one property that cannot be checked any other way:
 * that the loser of a race is told it lost rather than being handed the lock.
 */

let mongo: MongoMemoryServer;

const KEYS = {
  celo: vaultLockKey('celo', '0xAbC0000000000000000000000000000000000001'),
  sepolia: vaultLockKey('celoSepolia', '0xAbC0000000000000000000000000000000000001'),
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();

  if (!/^mongodb:\/\/127\.0\.0\.1:\d+/.test(uri)) {
    throw new Error(`Refusing to run lock tests against a non-loopback database: ${uri}`);
  }

  process.env.NODE_ENV = 'test';
  process.env.MONGO_CONNECTION_URL = uri;

  await mongoose.connect(uri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  await clearLocks();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('lock keys', () => {
  test('separates networks and ignores address casing', () => {
    const lower = vaultLockKey('celo', '0xabc0000000000000000000000000000000000001');
    const upper = vaultLockKey('celo', '0xABC0000000000000000000000000000000000001');

    // One merchant, one lock per network: the same address in two casings must
    // not be able to hold two locks and deploy the same vault twice.
    expect(lower).toBe(upper);
    expect(KEYS.celo).not.toBe(KEYS.sepolia);
  });
});

describe('taking a lock', () => {
  test('grants a free lock and refuses a second caller', async () => {
    const first = await tryAcquire(KEYS.celo);
    const second = await tryAcquire(KEYS.celo);

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    // The refusal is a duplicate-key collision on the `_id`, caught and read as
    // "someone else holds it" — so there must be exactly one record, belonging
    // to the first caller.
    const stored = await lockModel.findById(KEYS.celo);

    expect(stored?.owner).toBe(first!.owner);
  });

  test('grants locks on different keys to different callers at once', async () => {
    const celo = await tryAcquire(KEYS.celo);
    const sepolia = await tryAcquire(KEYS.sepolia);

    expect(celo).not.toBeNull();
    expect(sepolia).not.toBeNull();
  });

  test('frees the lock when the holder releases it', async () => {
    const first = await tryAcquire(KEYS.celo);

    await release(first!);

    const second = await tryAcquire(KEYS.celo);

    expect(second).not.toBeNull();
    // The new holder is a different owner, so the old holder can no longer
    // delete it out from under them.
    expect(second!.owner).not.toBe(first!.owner);
  });

  test('a stale holder cannot release the lock someone else now holds', async () => {
    const stale = await tryAcquire(KEYS.celo, { ttlMs: 25 });

    await sleep(40);

    const fresh = await tryAcquire(KEYS.celo);

    expect(fresh).not.toBeNull();

    // The first holder finishing late tries to clean up after itself. Its
    // release must not match: the lock now belongs to the second caller, and
    // deleting it would put two writers on the same vault.
    await release(stale!);

    const stored = await lockModel.findById(KEYS.celo);

    expect(stored?.owner).toBe(fresh!.owner);
  });

  test('takes over a lock whose holder never released it', async () => {
    const abandoned = await tryAcquire(KEYS.celo, { ttlMs: 25 });

    expect(abandoned).not.toBeNull();
    expect(await tryAcquire(KEYS.celo)).toBeNull();

    await sleep(40);

    // The TTL index has almost certainly not run yet — the monitor runs about
    // once a minute — so this is the acquire query treating an expired record
    // as free, which is the behaviour everything else depends on.
    const second = await tryAcquire(KEYS.celo);

    expect(second).not.toBeNull();
    expect(second!.owner).not.toBe(abandoned!.owner);
  });
});

describe('withLock', () => {
  test('runs the operation and releases afterwards', async () => {
    const result = await withLock(KEYS.celo, async () => 'done');

    expect(result).toBe('done');
    expect(await lockModel.findById(KEYS.celo)).toBeNull();
  });

  test('releases even when the operation throws', async () => {
    const failure = withLock(KEYS.celo, async () => {
      throw new Error('deployment exploded');
    });

    await expect(failure).rejects.toThrow('deployment exploded');

    // A failed operation must not lock the merchant out of ever trying again.
    expect(await lockModel.findById(KEYS.celo)).toBeNull();
    expect(await tryAcquire(KEYS.celo)).not.toBeNull();
  });

  test('waits for a contended lock instead of failing', async () => {
    const held = await tryAcquire(KEYS.celo);
    const order: string[] = [];

    const waiting = withLock(
      KEYS.celo,
      async () => {
        order.push('second ran');
        return 'second';
      },
      { waitMs: 2_000, pollMs: 10 },
    );

    await sleep(60);
    order.push('releasing');

    await release(held!);

    expect(await waiting).toBe('second');
    // The waiter ran only after the holder let go — which is the whole point:
    // the second caller of a withdrawal waits, then observes the vault the
    // first one deployed rather than racing it.
    expect(order).toEqual(['releasing', 'second ran']);
  });

  test('gives up with lock-timeout when the holder does not finish', async () => {
    const held = await tryAcquire(KEYS.celo);

    const failure = withLock(KEYS.celo, async () => 'never', { waitMs: 60, pollMs: 10 });

    await expect(failure).rejects.toBeInstanceOf(VaultLifecycleError);

    try {
      await failure;
      throw new Error('expected withLock to reject');
    } catch (error) {
      expect((error as VaultLifecycleError).code).toBe('lock-timeout');
      // The message is what a merchant sees, so it must not name the key or
      // suggest the vault is at fault — somebody else is simply still working.
      expect((error as VaultLifecycleError).status).toBe(503);
      expect((error as VaultLifecycleError).message).not.toContain('vault:');
    }

    // The holder's lock was not disturbed by the loser giving up.
    expect((await lockModel.findById(KEYS.celo))?.owner).toBe(held!.owner);
  });
});
