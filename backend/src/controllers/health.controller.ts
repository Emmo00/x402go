import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import type { Address } from 'viem';
import { CHAINS, type ChainConfig } from '@facilitator/types/shared/evm';
import { factoryAbi } from '@/abi';
import { OPERATOR_ADDRESS, getPublicClient } from '@/utils/chainClient';

const startedAt = Date.now();
const timeoutMs = 3_000;
let cached: { at: number; result: HealthResult } | undefined;
let inFlight: Promise<HealthResult> | undefined;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function check(fn: () => Promise<unknown>): Promise<Check> {
  const start = Date.now();
  try {
    await withTimeout(fn());
    return { ok: true, ms: Date.now() - start };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const note = ['timeout', 'low_balance', 'stuck_transactions', 'signer_missing_operator_role'].includes(message)
      ? message
      : 'unavailable';
    return { ok: false, ms: Date.now() - start, note };
  }
}

async function checkChain(chain: ChainConfig): Promise<ChainChecks> {
  let client: ReturnType<typeof getPublicClient>;
  try {
    client = getPublicClient(chain.network);
  } catch {
    const unavailable = { ok: false, ms: 0, note: 'unavailable' };
    return { rpc: unavailable, gas: unavailable, nonce: unavailable, operatorRole: unavailable };
  }

  const signerAddress = OPERATOR_ADDRESS as Address;
  const [rpc, gas, nonce, operatorRole] = await Promise.all([
    check(() => client.getBlockNumber()),
    check(async () => {
      if ((await client.getBalance({ address: signerAddress })) < chain.minSignerBalance) {
        throw new Error('low_balance');
      }
    }),
    check(async () => {
      const [pending, latest] = await Promise.all([
        client.getTransactionCount({ address: signerAddress, blockTag: 'pending' }),
        client.getTransactionCount({ address: signerAddress, blockTag: 'latest' }),
      ]);
      if (pending - latest > 5) throw new Error('stuck_transactions');
    }),
    check(async () => {
      const role = await client.readContract({
        address: chain.factory,
        abi: factoryAbi,
        functionName: 'OPERATOR_ROLE',
      });
      const hasRole = await client.readContract({
        address: chain.factory,
        abi: factoryAbi,
        functionName: 'hasAnyRole',
        args: [signerAddress, role],
      });
      if (!hasRole) throw new Error('signer_missing_operator_role');
    }),
  ]);

  return { rpc, gas, nonce, operatorRole };
}

async function compute(): Promise<HealthResult> {
  const database = await check(async () => {
    if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
      throw new Error('database_unavailable');
    }
    await mongoose.connection.db.command({ ping: 1 });
  });
  const entries = await Promise.all(
    CHAINS.map(async (chain) => [chain.network, await checkChain(chain)] as const),
  );
  const chains = Object.fromEntries(entries);
  const rpcUp = entries.filter(([, checks]) => checks.rpc.ok).length;
  const allChecksPass = entries.length > 0 && entries.every(([, checks]) =>
    Object.values(checks).every((result) => result.ok),
  );
  const status = !database.ok || rpcUp === 0 ? 'down' : allChecksPass ? 'ok' : 'degraded';

  return {
    code: status === 'down' ? 503 : 200,
    body: { status, checks: { database, chains } },
  };
}

export function live(_req: Request, res: Response): void {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    version: process.env.GIT_SHA ?? 'unknown',
  });
}

export async function ready(req: Request, res: Response): Promise<void> {
  if (process.env.DEMO_MODE === 'true') {
    res.json({ status: 'ok', mode: 'demo' });
    return;
  }

  if (!cached || Date.now() - cached.at > 15_000) {
    if (!inFlight) {
      inFlight = compute().finally(() => {
        inFlight = undefined;
      });
    }
    cached = { at: Date.now(), result: await inFlight };
  }

  const detailed =
    Boolean(process.env.HEALTH_TOKEN) &&
    req.header('x-health-token') === process.env.HEALTH_TOKEN;
  const result = cached.result;
  res.status(result.code).json(detailed ? result.body : { status: result.body.status });
}
