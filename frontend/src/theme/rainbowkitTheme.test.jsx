import { RainbowKitProvider } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { celo } from 'wagmi/chains';
import { describe, expect, test } from 'vitest';
import { x402RainbowKitTheme } from './rainbowkitTheme';

/**
 * RainbowKit resolves its theme through `cssStringFromTheme` during render and
 * throws if the theme's shape does not match its `ThemeVars` contract — for
 * example "Path shadows -> walletLogo does not exist in object". That is a
 * runtime crash on every route, invisible to both the bundler and any test that
 * does not actually mount the provider, so it is asserted here directly.
 */
const config = createConfig({
  chains: [celo],
  connectors: [],
  transports: { [celo.id]: http() },
  ssr: false,
});

function renderWithTheme(theme) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={theme}>
          <p>app</p>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>,
  );
}

describe('x402RainbowKitTheme', () => {
  test('mounts RainbowKitProvider without a theme contract error', () => {
    renderWithTheme(x402RainbowKitTheme);

    expect(screen.getByText('app')).toBeInTheDocument();
  });

  test('satisfies every key of the ThemeVars contract', () => {
    // The complete contract, from sprinkles.css.d.ts. An extra or missing key in
    // any of these groups throws at render time.
    expect(Object.keys(x402RainbowKitTheme.shadows).sort()).toEqual([
      'connectButton',
      'dialog',
      'profileDetailsAction',
      'selectedOption',
      'selectedWallet',
      'walletLogo',
    ]);
    expect(Object.keys(x402RainbowKitTheme.radii).sort()).toEqual([
      'actionButton',
      'connectButton',
      'menuButton',
      'modal',
      'modalMobile',
    ]);
    expect(x402RainbowKitTheme.blurs).toHaveProperty('modalOverlay');
  });

  test('keeps every radius at the 1px the design system specifies', () => {
    // DESIGN.md allows exactly one radius, on every element.
    expect(new Set(Object.values(x402RainbowKitTheme.radii))).toEqual(new Set(['1px']));
  });

  test('uses no drop shadows anywhere', () => {
    expect(new Set(Object.values(x402RainbowKitTheme.shadows))).toEqual(new Set(['none']));
  });
});
