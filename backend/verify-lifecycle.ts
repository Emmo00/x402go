/**
 * End-to-end verification of Step 1, against the real chains.
 *
 * Throwaway, like `verify-e2e.ts`, and for the same reason: it reads live Celo
 * RPCs, so it can fail for causes that are not properties of this code.
 *
 * What it settles that the suite cannot. The tests script the factory, so they
 * prove the backend does the right thing with an answer — not that the real
 * factory gives that answer. This closes that gap on three points:
 *
 *   1. the operator key in `.env` is the wallet the deployed factory actually
 *      recognises, which no fixture can tell us and which every write depends on;
 *   2. `createVault` really is callable by that operator, checked with
 *      `eth_call` rather than a broadcast — a revert here would mean the
 *      deployment path is broken in a way a scripted sender hides;
 *   3. the address `vaultOf` returns for a fresh merchant is still empty, which
 *      is the whole premise of deferred deployment.
 *
 * Nothing here sends a transaction. `simulateContract` is a read.
 */

import 'dotenv/config';
import { createPublicClient, getAddress, http, type Address } from 'viem';
import { X402_VAULT_FACTORY_ABI } from './src/abi';
import { CHAIN_KEYS, chainByKey, type ChainKey } from './src/config';
import { getOperatorAddress } from './src/utils/operatorWallet';
import { resetPublicClients } from './src/utils/chainClient';
import VaultFactoryService from './src/services/vaultFactory.service';
import VaultService from './src/services/vault.service';

const line = (label: string, value: string) => console.log(`${label.padEnd(24)} ${value}`);

let failures = 0;

const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

/**
 * A merchant with no history, so every address below is one the factory has
 * never created anything at. Derived from a fixed string rather than random so
 * a re-run compares like with like; it holds nothing and controls nothing.
 */
const MERCHANT = getAddress('0x00000000000000000000000000000000c0ffee01');
const PAYOUT = getAddress('0x00000000000000000000000000000000c0ffee02');

resetPublicClients();

console.log('\n=== 1. The operator this server signs with ===');

const operator = getOperatorAddress();
line('operator address', operator);
// The address is public and printed on purpose. The key it came from is not,
// and no line in this file can print it.
line('operator key', '(present, never printed)');

console.log('\n=== 2. It is the factory’s operator on each chain ===');

const factoryService = new VaultFactoryService();

for (const chain of CHAIN_KEYS) {
  const { name, chainId, contracts } = chainByKey(chain);

  console.log(`\n${name} (chain ${chainId})`);
  line('  factory', contracts.factory);

  try {
    const onChain = await factoryService.operator(chain);

    line('  factory.operator()', onChain);
    check(
      onChain.toLowerCase() === operator.toLowerCase(),
      'the operator key here is the wallet the factory authorises',
    );
  } catch (error) {
    check(false, 'factory.operator() could not be read', String(error).slice(0, 120));
  }
}

console.log('\n=== 3. A fresh merchant has an address and no vault ===');

for (const chain of CHAIN_KEYS) {
  const { name, chainId, contracts, rpcUrl } = chainByKey(chain);

  console.log(`\n${name} (chain ${chainId})`);

  const client = createPublicClient({ transport: http(rpcUrl) });
  const vaultAddress = await factoryService.vaultOf(chain, MERCHANT);
  const code = await client.getCode({ address: vaultAddress });
  const deployed = await new VaultService().isDeployed(chain, vaultAddress);

  line('  vaultOf(merchant)', vaultAddress);
  line('  code at that address', code && code !== '0x' ? `${(code.length - 2) / 2} bytes` : 'none');
  line('  isDeployed', String(deployed));

  check(deployed === false, 'the deterministic address is still empty');
  check(code === undefined || code === '0x', 'nothing is deployed there');
}

console.log('\n=== 4. createVault would be accepted (eth_call, nothing is sent) ===');

for (const chain of CHAIN_KEYS) {
  const { name, chainId, contracts, rpcUrl } = chainByKey(chain);

  console.log(`\n${name} (chain ${chainId})`);

  const client = createPublicClient({ transport: http(rpcUrl) });

  try {
    const { result } = await client.simulateContract({
      address: contracts.factory,
      abi: X402_VAULT_FACTORY_ABI,
      functionName: 'createVault',
      args: [MERCHANT, PAYOUT],
      account: operator,
    });

    line('  simulated vault', result);
    check(
      result.toLowerCase() === (await factoryService.vaultOf(chain, MERCHANT)).toLowerCase(),
      'createVault would deploy at the address the factory promises',
    );
  } catch (error) {
    // A revert here is the finding this script exists for: it would mean the
    // operator is not authorised, or the factory is not what the config says.
    check(false, 'createVault simulated as a revert', String(error).slice(0, 160));
  }

  const after = await client.getCode({
    address: await factoryService.vaultOf(chain, MERCHANT),
  });

  check(after === undefined || after === '0x', 'the simulation deployed nothing');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);

process.exit(failures === 0 ? 0 : 1);
