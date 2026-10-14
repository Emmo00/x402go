import { type Chain, type PublicClient } from 'viem';
import { createConnectedClient, createSigner } from '@facilitator/types/shared';
import type { Network, ConnectedClient, Signer  } from '@facilitator/types/shared';

export const { OPERATOR_KEY, OPERATOR_ADDRESS } = process.env;

export type ChainClientProvider = (chain: Network | string) => ConnectedClient;
export type SignerClientProvider = (chain: Network | string) => Signer;

/**
 * Clients are created once and kept.
 *
 * A client owns a connection pool and a request batcher, and building a new one
 * per call would open a fresh pool for every dashboard request. The cache is
 * keyed by chain rather than held as a module-level singleton so a chain added
 * to the config needs no change here.
 */
const clients = new Map<Network | string, ConnectedClient>();
const signers = new Map<Network | string, Signer>();

/**
 * The default provider: a memoised public client per chain.
 */
export const getPublicClient: ChainClientProvider = (chain) => {
  const existing = clients.get(chain);

  if (existing) return existing;

  const client = createConnectedClient(chain);
  clients.set(chain, client);

  return client;
};

export const getSignerClient: SignerClientProvider = (chain) => {
  const existing = signers.get(chain);

  if (existing) return existing;

  const signer = createSigner(chain, OPERATOR_KEY!);
  signers.set(chain, signer);
  return signer;
};

/** Drops memoised clients. For tests that change the RPC environment between cases. */
export function resetPublicClients(): void {
  clients.clear();
}
