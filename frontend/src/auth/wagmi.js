import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
  safeWallet,
  valoraWallet,
  walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { createConfig, http } from 'wagmi';
import { celo, celoSepolia } from 'wagmi/chains';
import { WALLETCONNECT_PROJECT_ID } from '../env';

/**
 * wagmi + RainbowKit configuration.
 *
 * x402Go settles on Celo, so the wallet list is curated rather than taken from
 * RainbowKit's `getDefaultConfig`: Valora (Celo's flagship mobile wallet) leads,
 * followed by the wallets Celo developers most often connect with.
 *
 * Only the two chains the contracts are deployed to are offered, so a user
 * cannot end up on a network where the facilitator has no vault.
 *
 * Valora, MetaMask, Rainbow and WalletConnect are all implemented as
 * WalletConnect connectors in RainbowKit, and every one of them throws
 * "No projectId found" at config time when no project id is set. They are
 * therefore offered only once one is configured; Coinbase, Safe and injected
 * wallets work without it, so the app still connects on a bare checkout.
 */
const hasWalletConnect = Boolean(WALLETCONNECT_PROJECT_ID);

const recommendedWallets = hasWalletConnect
  ? [valoraWallet, metaMaskWallet, walletConnectWallet]
  : [];

const moreWallets = hasWalletConnect
  ? [rainbowWallet, coinbaseWallet, injectedWallet, safeWallet]
  : [coinbaseWallet, injectedWallet, safeWallet];

const connectors = connectorsForWallets(
  [
    ...(recommendedWallets.length > 0
      ? [{ groupName: 'Recommended', wallets: recommendedWallets }]
      : []),
    { groupName: 'More wallets', wallets: moreWallets },
  ],
  {
    appName: 'x402Go',
    // Required by the signature. Only the WalletConnect-based connectors above
    // read it, and none of them are listed unless a real id is configured.
    projectId: WALLETCONNECT_PROJECT_ID,
  },
);

export const wagmiConfig = createConfig({
  connectors,
  chains: [celo, celoSepolia],
  transports: {
    [celo.id]: http(),
    [celoSepolia.id]: http(),
  },
  ssr: false,
});
