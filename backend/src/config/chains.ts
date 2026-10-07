import { TOKENS, type TokenConfig } from './tokens';

/**
 * Chain and contract configuration.
 *
 * Every address x402Go talks to lives in this file. Nothing downstream —
 * service, controller or test — should contain a literal `0x…` contract
 * address, so that redeploying the factory is a one-line change here rather
 * than a search across the backend.
 *
 * Public contract addresses are *not* environment variables. They are part of
 * what the application is, not a per-deployment setting: a backend pointed at
 * the wrong factory is broken, not configured differently, and an env var only
 * makes that state reachable. The things that genuinely vary per deployment —
 * RPC endpoints, because an operator may have a paid provider — are read from
 * the environment, with the public endpoint as the fallback.
 */

/** The chains x402Go settles on. Used as the key for every per-chain lookup. */
export type ChainKey = 'celo' | 'celoSepolia';

export interface ChainConfig {
  /** Stable identifier, and the key this chain is stored under on a user. */
  readonly key: ChainKey;
  /** EIP-155 chain id, as it appears in a signature and on the wire. */
  readonly chainId: number;
  /** Human-readable network name, for the dashboard. */
  readonly name: string;
  /** Block explorer root, without a trailing slash. */
  readonly explorerUrl: string;
  /**
   * The JSON-RPC endpoint for this chain.
   *
   * Read from the environment so an operator can point a deployment at a paid
   * provider without a code change, falling back to the public Forno endpoint
   * — which is rate-limited and best-effort, fine for development and the
   * reason this is overridable for anything real.
   *
   * Resolved on each read rather than captured when this module loads, so a
   * test that redirects the environment before touching the app sees its own
   * value instead of whichever one happened to be set at import time.
   */
  readonly rpcUrl: string;
  /**
   * The Celo facilitator this chain's payments are settled through.
   *
   * Per chain because the hosted facilitator runs one deployment per network,
   * and a payment signed for one is rejected by the other. Read from the
   * environment like `rpcUrl`, and for the same reason — an operator may run
   * their own facilitator — with the hosted endpoint as the fallback.
   */
  readonly facilitatorUrl: string;
  readonly contracts: {
    /**
     * The deployed factory. Identical on both Celo networks, because the
     * CREATE2 salt and the constructor arguments are, but recorded per chain
     * rather than shared: they are two independent deployments that happen to
     * agree today, and either could be replaced on its own.
     */
    readonly factory: `0x${string}`;
    /**
     * The X402Vault implementation the factory clones, read from
     * `factory.implementation()`. The factory creates it with a plain CREATE
     * in its constructor, so this address is a function of the factory's
     * address and nonce — it is *not* something to recompute by hand, and it
     * is verified against the factory at runtime (see `VaultFactoryService`).
     */
    readonly vaultImplementation: `0x${string}`;
  };
}

/**
 * Addresses below were read from `factory.implementation()`, `owner()` and
 * `operator()` on both networks on 2026-10-07, and cross-checked against the
 * deployment broadcast in `contracts/broadcast/`. They are not copied from the
 * deployment script's output, which cannot be trusted to describe what is
 * actually at the address today.
 */
const CELO: ChainConfig = {
  key: 'celo',
  chainId: 42220,
  name: 'Celo Mainnet',
  explorerUrl: 'https://celoscan.io',
  get rpcUrl() {
    return process.env.CELO_RPC_URL || 'https://forno.celo.org';
  },
  get facilitatorUrl() {
    return process.env.CELO_FACILITATOR_URL || 'https://api.x402.celo.org';
  },
  contracts: {
    factory: '0x698E55e1c8b4d9eAACbCfceCdd9D4E85B1D2701e',
    vaultImplementation: '0xAc67386A25CfCE52a769957554CBb825641780d2',
  },
};

const CELO_SEPOLIA: ChainConfig = {
  key: 'celoSepolia',
  chainId: 11142220,
  name: 'Celo Sepolia',
  explorerUrl: 'https://celo-sepolia.blockscout.com',
  get rpcUrl() {
    return (
      process.env.CELO_SEPOLIA_RPC_URL || 'https://forno.celo-sepolia.celo-testnet.org'
    );
  },
  get facilitatorUrl() {
    return process.env.CELO_SEPOLIA_FACILITATOR_URL || 'https://api.x402.sepolia.celo.org';
  },
  contracts: {
    factory: '0x698E55e1c8b4d9eAACbCfceCdd9D4E85B1D2701e',
    vaultImplementation: '0xAc67386A25CfCE52a769957554CBb825641780d2',
  },
};

/** Every supported chain, keyed by `ChainKey`. */
export const CHAINS: Readonly<Record<ChainKey, ChainConfig>> = {
  celo: CELO,
  celoSepolia: CELO_SEPOLIA,
};

/**
 * The order chains are presented in, mainnet first.
 *
 * A user's vaults are provisioned and displayed in this order, so it is the
 * one thing that has to be stable: the dashboard reads left to right, and a
 * record built under one order must line up with a record built under the next.
 */
export const CHAIN_KEYS: readonly ChainKey[] = ['celo', 'celoSepolia'];

/**
 * The chain the dashboard leads with, and the one a client gets when it does
 * not name one. Mainnet, so an unqualified request is never quietly answered
 * from a testnet.
 */
export const DEFAULT_CHAIN: ChainKey = 'celo';

/** Narrows an arbitrary string — a query parameter, a database value — to a chain. */
export function isChainKey(value: unknown): value is ChainKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CHAINS, value);
}

/** Looks a chain up by key. Throws rather than returning undefined: the caller
 * has already decided which chain it means, and a silent `undefined` would
 * resurface later as a confusing property read. */
export function chainByKey(key: ChainKey): ChainConfig {
  return CHAINS[key];
}

/** Looks a chain up by EIP-155 id — the form a wallet or a signature carries. */
export function chainById(chainId: number): ChainConfig | undefined {
  return CHAIN_KEYS.map((key) => CHAINS[key]).find((chain) => chain.chainId === chainId);
}

/** A chain with its token list attached, for the docs endpoint and the UI. */
export interface ChainWithTokens extends ChainConfig {
  readonly tokens: readonly TokenConfig[];
}

/** Every supported chain with its assets, in presentation order. */
export function chainsWithTokens(): readonly ChainWithTokens[] {
  return CHAIN_KEYS.map((key) => ({ ...CHAINS[key], tokens: TOKENS[key] }));
}
