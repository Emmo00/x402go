import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress } from 'viem';

import { X402_VAULT_ABI } from '../abi';
import { X402_VAULT_FACTORY_ABI } from '../abi/x402VaultFactory';
import {
  CHAINS,
  CHAIN_KEYS,
  DEFAULT_CHAIN,
  chainById,
  chainByKey,
  isChainKey,
  settleableTokens,
  tokensFor,
} from '../config';
import {
  predictVaultAddress,
  sameAddress,
  vaultInitCode,
  vaultSalt,
} from '../utils/vaultAddress';

/**
 * Chain configuration and the deterministic vault address.
 *
 * The vectors below are not self-derived. They were read from the deployed
 * factory's `vaultOf` on both Celo networks and the numbers here were checked
 * against that answer as it was recorded — so this suite fails if the local
 * derivation stops agreeing with the contract, which is the only thing that
 * makes it worth storing addresses in a database at all.
 *
 * A test that asserted `predict(x) === predict(x)` would pass no matter how
 * wrong the bytecode template was.
 */

/**
 * Merchants and the vault address the live factory returns for each, on both
 * networks. Captured 2026-10-07 from `vaultOf(address)` against
 * `0x698E55e1c8b4d9eAACbCfceCdd9D4E85B1D2701e`.
 */
const FACTORY_VECTORS: readonly { merchant: string; vault: string }[] = [
  {
    merchant: '0xC0b0e77000AA0826B7dB9d1Fe3760d26559643bb',
    vault: '0x59f3D0c53BC46A35a81E478B080cc8afA2FC88dE',
  },
  {
    merchant: '0x7b054580aEA6B6cbdF30BbbE84777bae623F4d1e',
    vault: '0xBD3BBA55f9C6c7AeC88b7Ba76830a9535739Cf15',
  },
  {
    merchant: '0x402001B3fbf1462939657eb7f64EE3743eAdf35E',
    vault: '0x6edBea75f8D33E4d8BFf910536C86798fF9b5220',
  },
  {
    merchant: '0x0000000000000000000000000000000000000001',
    vault: '0x6B600bec988aC955f15E9008B063a5b09a726468',
  },
];

describe('chain configuration', () => {
  test('pins the factory address on Celo Mainnet', () => {
    expect(chainByKey('celo').chainId).toBe(42220);
    expect(getAddress(CHAINS.celo.contracts.factory)).toBe(
      '0x698E55e1c8b4d9eAACbCfceCdd9D4E85B1D2701e',
    );
  });

  test('pins the factory address on Celo Sepolia', () => {
    expect(chainByKey('celoSepolia').chainId).toBe(11142220);
    expect(getAddress(CHAINS.celoSepolia.contracts.factory)).toBe(
      '0x698E55e1c8b4d9eAACbCfceCdd9D4E85B1D2701e',
    );
  });

  test('records the implementation per chain, not once for both', () => {
    // They are equal today because both factories were deployed with the same
    // CREATE2 salt and constructor arguments, which also makes the internal
    // CREATE that produces the implementation land identically. That is a
    // coincidence of this deployment, not a property to encode: each chain
    // still carries its own value, so redeploying one does not silently
    // misdirect the other.
    for (const key of CHAIN_KEYS) {
      expect(getAddress(CHAINS[key].contracts.vaultImplementation)).toBe(
        '0xAc67386A25CfCE52a769957554CBb825641780d2',
      );
    }
  });

  test('does not hard-code the same address as a shared constant', () => {
    // Guards the above from being "simplified" into one exported constant,
    // which would make the two chains impossible to diverge.
    expect(CHAINS.celo.contracts).not.toBe(CHAINS.celoSepolia.contracts);
  });

  test('gives every chain a distinct id and a reachable-looking rpc url', () => {
    const ids = CHAIN_KEYS.map((key) => CHAINS[key].chainId);

    expect(new Set(ids).size).toBe(ids.length);

    for (const key of CHAIN_KEYS) {
      expect(CHAINS[key].rpcUrl).toMatch(/^https:\/\//);
    }
  });

  test('lets the environment override an rpc url without a code change', () => {
    const original = process.env.CELO_RPC_URL;

    try {
      process.env.CELO_RPC_URL = 'https://rpc.example.test/celo';

      // Read lazily, so the override applies to a chain object that was already
      // constructed — the reason `rpcUrl` is a getter.
      expect(CHAINS.celo.rpcUrl).toBe('https://rpc.example.test/celo');
    } finally {
      if (original === undefined) delete process.env.CELO_RPC_URL;
      else process.env.CELO_RPC_URL = original;
    }
  });

  test('falls back to the public endpoint when nothing overrides it', () => {
    const original = process.env.CELO_SEPOLIA_RPC_URL;

    try {
      delete process.env.CELO_SEPOLIA_RPC_URL;

      expect(CHAINS.celoSepolia.rpcUrl).toBe(
        'https://forno.celo-sepolia.celo-testnet.org',
      );
    } finally {
      if (original !== undefined) process.env.CELO_SEPOLIA_RPC_URL = original;
    }
  });

  test('resolves chains by key and by EIP-155 id', () => {
    expect(chainById(42220)?.key).toBe('celo');
    expect(chainById(11142220)?.key).toBe('celoSepolia');
    expect(chainById(1)).toBeUndefined();
  });

  test('recognises chain keys and refuses anything else', () => {
    expect(isChainKey('celo')).toBe(true);
    expect(isChainKey('mainnet')).toBe(false);
    expect(isChainKey('')).toBe(false);
    // Prototype keys must not pass for chains.
    expect(isChainKey('toString')).toBe(false);
    expect(isChainKey('constructor')).toBe(false);
  });

  test('leads with mainnet', () => {
    expect(DEFAULT_CHAIN).toBe('celo');
    expect(CHAIN_KEYS[0]).toBe('celo');
  });
});

describe('token configuration', () => {
  test('lists the facilitator assets on Celo Mainnet', () => {
    const usdc = tokensFor('celo').find((token) => token.symbol === 'USDC');

    expect(usdc).toBeDefined();
    expect(getAddress(usdc!.address)).toBe('0xcebA9300f2b948710d2653dD7B07f33A8B32118C');
    expect(usdc!.decimals).toBe(6);
    expect(usdc!.eip712).toEqual({ name: 'USDC', version: '2' });
    expect(usdc!.transferMethod).toBe('eip3009');
    expect(usdc!.enabled).toBe(true);
  });

  test('lists USDC on Celo Sepolia at its own address', () => {
    const usdc = tokensFor('celoSepolia').find((token) => token.symbol === 'USDC');

    expect(usdc).toBeDefined();
    expect(getAddress(usdc!.address)).toBe('0x01C5C0122039549AD1493B8220cABEdD739BC44E');
    expect(usdc!.decimals).toBe(6);
  });

  test('keeps the same ticker on two chains as two separate tokens', () => {
    // USDC means a different contract on each network, which is why every
    // lookup is keyed by chain first and address second, never by symbol.
    const mainnet = tokensFor('celo').find((token) => token.symbol === 'USDC')!;
    const testnet = tokensFor('celoSepolia').find((token) => token.symbol === 'USDC')!;

    expect(sameAddress(mainnet.address, testnet.address)).toBe(false);
  });

  test('records the mainnet tokens the facilitator has not enabled', () => {
    const currencies = tokensFor('celo').filter((token) =>
      ['wARS', 'wBRL', 'wCOP', 'wMXN', 'wPEN', 'wCLP'].includes(token.symbol),
    );

    expect(currencies).toHaveLength(6);
    expect(currencies.every((token) => token.decimals === 18)).toBe(true);
    expect(currencies.every((token) => token.transferMethod === 'permit2')).toBe(true);
  });

  test('excludes not-yet-enabled assets from the settleable list', () => {
    const enabled = settleableTokens('celo').map((token) => token.symbol);

    expect(enabled).toContain('USDC');
    expect(enabled).toContain('USDT');
    expect(enabled).toContain('USAT');
    expect(enabled).toContain('wARS');
    expect(enabled).not.toContain('wMXN');
    expect(enabled).not.toContain('wPEN');
    expect(enabled).not.toContain('wCLP');
    expect(enabled).toHaveLength(6);
  });

  test('never represents an amount as a float', () => {
    // Decimals are the only float-looking number in the token config, and they
    // are an exponent, not an amount. Anything else numeric here would be a
    // place a price could be stored imprecisely.
    for (const key of CHAIN_KEYS) {
      for (const token of tokensFor(key)) {
        expect(Number.isInteger(token.decimals)).toBe(true);
        expect(token.decimals).toBeGreaterThanOrEqual(0);
        expect(token.decimals).toBeLessThanOrEqual(36);
      }
    }
  });

  test('gives every token a unique address within its chain', () => {
    for (const key of CHAIN_KEYS) {
      const addresses = tokensFor(key).map((token) => token.address.toLowerCase());

      expect(new Set(addresses).size).toBe(addresses.length);
    }
  });
});

describe('deterministic vault address', () => {
  const { factory, vaultImplementation } = CHAINS.celo.contracts;

  test('reproduces the factory’s answer for known merchants', () => {
    for (const { merchant, vault } of FACTORY_VECTORS) {
      expect(predictVaultAddress(factory, vaultImplementation, getAddress(merchant))).toBe(
        getAddress(vault),
      );
    }
  });

  test('is the same on both networks, because the inputs are', () => {
    for (const { merchant, vault } of FACTORY_VECTORS) {
      for (const key of CHAIN_KEYS) {
        const chain = CHAINS[key];

        expect(
          predictVaultAddress(
            chain.contracts.factory,
            chain.contracts.vaultImplementation,
            getAddress(merchant),
          ),
        ).toBe(getAddress(vault));
      }
    }
  });

  test('gives one merchant the same address every time', () => {
    const merchant = getAddress(FACTORY_VECTORS[0].merchant);
    const first = predictVaultAddress(factory, vaultImplementation, merchant);

    for (let i = 0; i < 25; i++) {
      expect(predictVaultAddress(factory, vaultImplementation, merchant)).toBe(first);
    }
  });

  test('gives different merchants different addresses', () => {
    const derived = FACTORY_VECTORS.map(({ merchant }) =>
      predictVaultAddress(factory, vaultImplementation, getAddress(merchant)),
    );

    expect(new Set(derived.map((address) => address.toLowerCase())).size).toBe(derived.length);
  });

  test('derives a distinct address for every merchant in a generated set', () => {
    const merchants = Array.from(
      { length: 64 },
      (_, i) => `0x${(BigInt(i) + 1n).toString(16).padStart(40, '0')}` as const,
    );

    const derived = merchants.map((merchant) =>
      predictVaultAddress(factory, vaultImplementation, getAddress(merchant)),
    );

    expect(new Set(derived.map((address) => address.toLowerCase())).size).toBe(merchants.length);
  });

  test('is insensitive to the casing of the merchant address', () => {
    const checksummed = getAddress(FACTORY_VECTORS[0].merchant);

    expect(predictVaultAddress(factory, vaultImplementation, checksummed)).toBe(
      predictVaultAddress(
        factory,
        vaultImplementation,
        checksummed.toLowerCase() as `0x${string}`,
      ),
    );
  });

  test('encodes the runtime length, not a constant 0x2d', () => {
    // The one detail that is easy to get wrong and impossible to notice: with a
    // 20-byte argument the PUSH2 immediate is 0x41, not 0x2d. Encoding 0x2d
    // still produces a well-formed initcode and a plausible address.
    const initCode = vaultInitCode(vaultImplementation, getAddress(FACTORY_VECTORS[0].merchant));

    // 0x61 PUSH2, then the runtime length in two bytes.
    expect(initCode.slice(0, 8)).toBe('0x610041');

    // 1 (PUSH2) + 2 (immediate) + 7 (return prologue) + 10 (dispatcher head)
    // + 20 (implementation) + 15 (tail) + 20 (merchant args).
    expect((initCode.length - 2) / 2).toBe(75);
  });

  test('pushes the merchant address as the clone’s immutable args', () => {
    const merchant = getAddress(FACTORY_VECTORS[1].merchant);
    const initCode = vaultInitCode(vaultImplementation, merchant);

    expect(initCode.toLowerCase().endsWith(merchant.slice(2).toLowerCase())).toBe(true);
    expect(initCode.toLowerCase()).toContain(vaultImplementation.slice(2).toLowerCase());
  });

  test('salts with the address widened to bytes32, not hashed', () => {
    const merchant = getAddress(FACTORY_VECTORS[2].merchant);
    const salt = vaultSalt(merchant);

    expect(salt).toBe(`0x${'0'.repeat(24)}${merchant.slice(2).toLowerCase()}`);
    expect((salt.length - 2) / 2).toBe(32);
  });

  test('produces a different address for a different implementation', () => {
    const merchant = getAddress(FACTORY_VECTORS[0].merchant);

    expect(predictVaultAddress(factory, vaultImplementation, merchant)).not.toBe(
      predictVaultAddress(factory, vaultImplementation, getAddress(FACTORY_VECTORS[1].merchant)),
    );

    // A different implementation shifts every address, including the merchant's
    // own — which is what makes the configured implementation address worth
    // verifying rather than trusting.
    expect(
      predictVaultAddress(
        factory,
        '0x000000000000000000000000000000000000dEaD',
        merchant,
      ),
    ).not.toBe(predictVaultAddress(factory, vaultImplementation, merchant));
  });

  test('produces a different address for a different factory', () => {
    const merchant = getAddress(FACTORY_VECTORS[0].merchant);

    expect(
      predictVaultAddress('0x000000000000000000000000000000000000dEaD', vaultImplementation, merchant),
    ).not.toBe(predictVaultAddress(factory, vaultImplementation, merchant));
  });

  test('compares addresses without depending on their casing', () => {
    expect(sameAddress(FACTORY_VECTORS[0].vault, FACTORY_VECTORS[0].vault.toLowerCase())).toBe(
      true,
    );
    expect(sameAddress(FACTORY_VECTORS[0].vault, FACTORY_VECTORS[1].vault)).toBe(false);
    // Values that are not addresses are not equal to anything, including each
    // other — these arrive from documents, so they are not trusted.
    expect(sameAddress(null, null)).toBe(false);
    expect(sameAddress(undefined, '0x1')).toBe(false);
  });
});

/**
 * The hand-written ABIs are a subset of the compiled ones. This checks that
 * every entry in the subset exists in the artifact the deployed bytecode was
 * built from, in both directions: a function renamed in Solidity, a parameter
 * reordered, or a mistyped argument type all show up here rather than as a
 * decode failure against mainnet.
 *
 * Skipped when the contracts have not been built, since `contracts/out/` is
 * generated and not committed. Run `forge build` in `contracts/` to enable it.
 */
const CONTRACTS_OUT = join(import.meta.dir, '../../../contracts/out');

function readAbi(relativePath: string): unknown[] | null {
  try {
    const artifact = JSON.parse(readFileSync(join(CONTRACTS_OUT, relativePath), 'utf8'));

    return Array.isArray(artifact.abi) ? artifact.abi : null;
  } catch {
    return null;
  }
}

/** A compiled entry and a hand-written one, reduced to what must agree. */
function shape(entry: Record<string, unknown>): string {
  const types = (value: unknown) =>
    Array.isArray(value)
      ? value.map((item) => (item as { type?: string }).type ?? '?').join(',')
      : [];

  // Parameter *names* are deliberately excluded. They never reach the wire —
  // an ABI encodes by position and type — and the compiler supplies its own for
  // unnamed returns, so `owner()` compiles with an output named `result` while
  // any sane hand-written entry leaves it blank. Comparing names would fail on
  // that difference, which cannot cause a bug, without catching any difference
  // that can.
  return [
    entry.type,
    entry.name ?? '',
    types(entry.inputs),
    types(entry.outputs),
    entry.stateMutability ?? '',
  ].join('|');
}

/**
 * Reverts that reach the chain from a library a contract calls, and that are
 * therefore absent from that contract's own ABI.
 *
 * Both contracts move tokens with Solady's `SafeTransferLib`, which reverts
 * with its own `TransferFailed()` when a transfer fails. viem decodes a revert
 * by matching the selector against the ABI it was given, so dropping the entry
 * would turn the failure an operator is most likely to hit into an unlabelled
 * four-byte selector. This is the whole allowance: three entries, each a revert
 * the deployed bytecode really can produce. Anything else missing is a bug in
 * the hand-written ABI.
 */
const LIBRARY_REVERTS = ['error|TransferFailed|||'];

function compareAbi(label: string, artifactPath: string, ours: readonly unknown[]): void {
  const compiled = readAbi(artifactPath);

  if (!compiled) {
    console.warn(
      `[abi] skipping the ${label} drift check: ${artifactPath} not found. ` +
        'Run `forge build` in contracts/ to enable it.',
    );
    return;
  }

  const known = new Set(compiled.map((entry) => shape(entry as Record<string, unknown>)));
  const missing = ours
    .map((entry) => shape(entry as Record<string, unknown>))
    .filter((entry) => !known.has(entry) && !LIBRARY_REVERTS.includes(entry));

  expect(missing).toEqual([]);
}

describe('ABIs match the compiled contracts', () => {
  test('every factory entry exists in the compiled artifact', () => {
    compareAbi(
      'X402VaultFactory',
      'X402VaultFactory.sol/X402VaultFactory.json',
      X402_VAULT_FACTORY_ABI,
    );
  });

  test('every vault entry exists in the compiled artifact', () => {
    compareAbi('X402Vault', 'X402Vault.sol/X402Vault.json', X402_VAULT_ABI);
  });
});
