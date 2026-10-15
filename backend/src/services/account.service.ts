import userModel from '../models/users.model';
import { getPublicClient } from '@/utils/chainClient';
import { FACTORY } from '@facilitator/types/shared/evm';
import { factoryAbi } from '@/abi';
import { Address } from 'viem';

export class AccountService {
  private readonly users = userModel;

  async ensureVault(userId: string, address: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new Error(`User with ID ${userId} not found`);
    }

    if (!user?.vaults?.address) {
      user.vaults = { address: await this.fetchDeterministicVaultAddress(address) };

      await user.save();
    }
  }

  async fetchDeterministicVaultAddress(merchantAddress: string): Promise<string> {
    const vaultAddress = getPublicClient('celo-sepolia').readContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: 'vaultOf',
      args: [merchantAddress],
    }) as unknown as Address;

    return vaultAddress;
  }
}

export default AccountService;
