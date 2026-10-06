import { RainbowKitProvider } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { WagmiProvider } from 'wagmi';
import { describe, expect, test } from 'vitest';

import '@rainbow-me/rainbowkit/styles.css';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { wagmiConfig } from './auth/wagmi';
import { x402RainbowKitTheme } from './theme/rainbowkitTheme';

/**
 * Mounts the real provider tree from src/index.jsx against the real wagmi
 * config and theme.
 *
 * A mismatched RainbowKit theme, a provider in the wrong order or a missing
 * context all fail here as a blank screen in the browser but build cleanly, so
 * the whole tree is exercised rather than the pages in isolation.
 */
function renderApp(path) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <MemoryRouter initialEntries={[path]}>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <RainbowKitProvider theme={x402RainbowKitTheme} modalSize="compact">
            <AuthProvider>
              <App />
            </AuthProvider>
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </MemoryRouter>,
  );
}

describe('provider tree', () => {
  test('renders the landing page at /', () => {
    renderApp('/');

    expect(
      screen.getByRole('heading', { level: 1, name: 'x402Go' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /get your api key/i })).toHaveLength(2);
  });

  test('guards the dashboard behind the sign-in gate', () => {
    renderApp('/dashboard');

    expect(
      screen.getByRole('heading', { level: 1, name: 'Connect your wallet' }),
    ).toBeInTheDocument();
    // The dashboard chrome must not leak to a disconnected visitor.
    expect(screen.queryByRole('navigation', { name: 'Dashboard sections' })).not.toBeInTheDocument();
  });

  test('sends the landing page calls to action to the gate', () => {
    renderApp('/signup');

    expect(
      screen.getByRole('heading', { level: 1, name: 'Connect your wallet' }),
    ).toBeInTheDocument();
  });

  test('renders an unknown path as the landing page', () => {
    renderApp('/nope');

    expect(
      screen.getByRole('heading', { level: 1, name: 'x402Go' }),
    ).toBeInTheDocument();
  });
});
