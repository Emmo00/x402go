import type { ChainKey } from './chains';

/**
 * The assets the Celo x402 facilitator will settle.
 *
 * This table is transcribed from the facilitator's own supported-assets list,
 * which is the source of truth: a token is usable by x402Go only if the
 * facilitator advertises it, so an asset added here that the facilitator does
 * not serve would produce 402 challenges no payer could answer.
 *
 * Amounts are never represented as floating point anywhere in the project.
 * `decimals` is the only thing that converts between an on-chain integer and a
 * human-readable figure, and it is applied at the edge — in the UI, with a
 * big-decimal string helper — never in the middle of a calculation.
 */
export interface TokenConfig {
  /** The chain this token settles on. */
  readonly chain: ChainKey;
  /** Contract address, in the facilitator's EIP-55 checksummed form. */
  readonly address: string;
  /** Ticker as the facilitator advertises it. Not unique across chains. */
  readonly symbol: string;
  /** Display name, for a picker. */
  readonly name: string;
  /** Base-10 exponent: 1 unit = 10 ** decimals base units. */
  readonly decimals: number;
  /**
   * How the x402 `exact` scheme moves this token.
   *
   * - `eip3009` — the payer signs a `TransferWithAuthorization`, which the
   *   facilitator submits. The token contract itself enforces the signature.
   * - `permit2` — the payer signs a Permit2 transfer; the allowance is
   *   granted to Permit2 rather than to the facilitator.
   *
   * A facilitator may advertise an asset before it can actually settle it, so
   * this describes the intended mechanism and `enabled` describes whether it
   * is live.
   */
  readonly transferMethod: 'eip3009' | 'permit2';
  /**
   * The EIP-712 domain of the *token contract*, published by the facilitator as
   * `extra.name` / `extra.version`. It is what the payer's wallet signs over,
   * and it is distinct from the X402Vault domain used for `changePayout`.
   *
   * `version` is a string because that is how it enters the EIP-712 domain
   * separator; it is not a number to be arithmetic on.
   */
  readonly eip712: {
    readonly name: string;
    readonly version: string;
  };
  /**
   * Whether the facilitator will currently settle this asset. Assets the
   * facilitator lists as "not enabled yet" are recorded but filtered out of
   * `settleableTokens`, so adding one to live traffic is a deliberate edit to
   * this flag rather than an accident of it already being in the table.
   */
  readonly enabled: boolean;
}

/**
 * Celo Mainnet — `eip155:42220`.
 *
 * Order runs from the assets x402Go launches with (the dollar stablecoins) to
 * the local-currency tokens and finally the ones the facilitator has listed
 * but not yet switched on. `symbol` is what a user recognises; the addresses
 * are what actually matter, since more than one chain has a token called USDC.
 */
const CELO_TOKENS: readonly TokenConfig[] = [
  {
    chain: 'celo',
    address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    transferMethod: 'eip3009',
    eip712: { name: 'USDC', version: '2' },
    enabled: true,
  },
  {
    chain: 'celo',
    address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e',
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    transferMethod: 'eip3009',
    eip712: { name: 'Tether USD', version: '1' },
    enabled: true,
  },
  {
    chain: 'celo',
    address: '0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771',
    symbol: 'USAT',
    name: 'Tether America USD',
    decimals: 6,
    transferMethod: 'eip3009',
    eip712: { name: 'Tether America USD', version: '1' },
    enabled: true,
  },
  {
    chain: 'celo',
    address: '0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D',
    symbol: 'wARS',
    name: 'Peso Argentino',
    decimals: 18,
    transferMethod: 'permit2',
    eip712: { name: 'Peso Argentino', version: '1' },
    enabled: true,
  },
  {
    chain: 'celo',
    address: '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0',
    symbol: 'wBRL',
    name: 'Real Brasileiro',
    decimals: 18,
    transferMethod: 'permit2',
    eip712: { name: 'Real Brasileiro', version: '1' },
    enabled: true,
  },
  {
    chain: 'celo',
    address: '0x8a1D45e102e886510e891d2Ec656a708991e2D76',
    symbol: 'wCOP',
    name: 'Peso Colombiano',
    decimals: 18,
    transferMethod: 'permit2',
    eip712: { name: 'Peso Colombiano', version: '1' },
    enabled: true,
  },
  // Listed by the facilitator, not yet settled by it. Kept so the table mirrors
  // the source of truth exactly and switching one on is a one-word change.
  {
    chain: 'celo',
    address: '0x337E7456B420bD3481e7FA61fA9850343d610d34',
    symbol: 'wMXN',
    name: 'Peso Mexicano',
    decimals: 18,
    transferMethod: 'permit2',
    eip712: { name: 'Peso Mexicano', version: '1' },
    enabled: false,
  },
  {
    chain: 'celo',
    address: '0x4F34c8b3b5FB6D98Da888F0feA543d4d9C9F2eBE',
    symbol: 'wPEN',
    name: 'Sol Peruano',
    decimals: 18,
    transferMethod: 'permit2',
    eip712: { name: 'Sol Peruano', version: '1' },
    enabled: false,
  },
  {
    chain: 'celo',
    address: '0x61D450a098b6a7f69fC4b98CE68198fe59768651',
    symbol: 'wCLP',
    name: 'Peso Chileno',
    decimals: 18,
    transferMethod: 'permit2',
    eip712: { name: 'Peso Chileno', version: '1' },
    enabled: false,
  },
];

/**
 * Celo Sepolia — `eip155:11142220`.
 *
 * The testnet settles USDC only. It is the same ticker as mainnet's but a
 * different contract, which is exactly why every lookup in this project is
 * keyed by chain first and address second — never by symbol.
 */
const CELO_SEPOLIA_TOKENS: readonly TokenConfig[] = [
  {
    chain: 'celoSepolia',
    address: '0x01C5C0122039549AD1493B8220cABEdD739BC44E',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    transferMethod: 'eip3009',
    eip712: { name: 'USDC', version: '2' },
    enabled: true,
  },
];

/** Every asset the facilitator lists, enabled or not, keyed by chain. */
export const TOKENS: Readonly<Record<ChainKey, readonly TokenConfig[]>> = {
  celo: CELO_TOKENS,
  celoSepolia: CELO_SEPOLIA_TOKENS,
};

/** Addresses are compared case-insensitively; nothing hinges on EIP-55 casing. */
function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Every listed asset on a chain, including ones the facilitator has not enabled. */
export function tokensFor(chain: ChainKey): readonly TokenConfig[] {
  return TOKENS[chain];
}

/**
 * The assets on a chain that x402Go may actually settle.
 *
 * This is the accessor the rest of the backend should use. `TOKENS` and
 * `tokensFor` exist for the docs page and for tests that assert the table
 * matches the facilitator; anything that would move money must go through
 * here, so a "not enabled yet" asset cannot reach live traffic by accident.
 */
export function settleableTokens(chain: ChainKey): readonly TokenConfig[] {
  return TOKENS[chain].filter((token) => token.enabled);
}

/**
 * Finds an asset by its contract address, enabled or not.
 *
 * Keyed by address rather than symbol on purpose: USDC means one contract on
 * mainnet and a different one on testnet, so a symbol is not an identifier.
 * Returns `undefined` for an address the facilitator does not list — which is
 * the signal that a settlement request names an asset that cannot be settled.
 */
export function findTokenByAddress(
  chain: ChainKey,
  address: string,
): TokenConfig | undefined {
  return TOKENS[chain].find((token) => sameAddress(token.address, address));
}

/**
 * Finds a settleable asset by address. The counterpart to
 * `settleableTokens` for a single lookup: an address that exists in the table
 * but is not enabled is treated exactly like an unknown one.
 */
export function findSettleableToken(
  chain: ChainKey,
  address: string,
): TokenConfig | undefined {
  const token = findTokenByAddress(chain, address);

  return token?.enabled ? token : undefined;
}
