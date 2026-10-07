import { createPublicClient, defineChain, http, type Chain, type PublicClient } from 'viem';
import { CHAINS, type ChainKey } from '../config';

/**
 * Read-only RPC access, one client per chain.
 *
 * The chain objects are built from `src/config` rather than imported from
 * `viem/chains`, so the config stays the single place a chain is described. If
 * `viem/chains` and this project ever disagreed about an endpoint, the
 * disagreement would be resolved silently in viem's favour; deriving the chain
 * here means there is only one answer.
 *
 * Everything here is read-only on purpose. x402Go's writes are vault creation
 * and withdrawal, which are the operator's job and belong to a later step —
 * this module has no account attached and cannot sign anything.
 */

/** A factory that hands back a client for a chain. Injectable so tests can
 * supply a stub instead of reaching the network. */
export type ChainClientProvider = (chain: ChainKey) => PublicClient;

/**
 * The two chains, in viem's shape.
 *
 * `nativeCurrency` is CELO on both: Celo Sepolia is a Celo testnet, so its gas
 * token is CELO too, not a faucet token.
 */
function toViemChain(key: ChainKey): Chain {
  const config = CHAINS[key];

  return defineChain({
    id: config.chainId,
    name: config.name,
    nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
    rpcUrls: {
      default: { http: [config.rpcUrl] },
    },
    blockExplorers: {
      default: { name: `${config.name} Explorer`, url: config.explorerUrl },
    },
  });
}

/**
 * Clients are created once and kept.
 *
 * A client owns a connection pool and a request batcher, and building a new one
 * per call would open a fresh pool for every dashboard request. The cache is
 * keyed by chain rather than held as a module-level singleton so a chain added
 * to the config needs no change here.
 */
const clients = new Map<ChainKey, PublicClient>();

/**
 * The default provider: a memoised public client per chain.
 *
 * These point at whatever `rpcUrl` the chain config resolves to, which is the
 * public Forno endpoint unless the environment overrides it. Forno is
 * rate-limited and explicitly best-effort, so a caller that cannot tolerate a
 * transient failure has to handle one — none of the reads in this project
 * treat an RPC error as an answer.
 */
export const getPublicClient: ChainClientProvider = (chain) => {
  const existing = clients.get(chain);

  if (existing) return existing;

  const client = createPublicClient({ chain: toViemChain(chain), transport: http() });
  clients.set(chain, client);

  return client as PublicClient;
};

/** Drops memoised clients. For tests that change the RPC environment between cases. */
export function resetPublicClients(): void {
  clients.clear();
}
