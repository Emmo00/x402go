import { fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { auth, api } = vi.hoisted(() => ({
  auth: { current: null },
  api: { fetchAccount: vi.fn() },
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => auth.current,
}));

vi.mock('../api/dashboard', () => ({
  fetchPayoutAddress: vi.fn(),
  fetchTransactionTag: vi.fn(),
  fetchOverview: vi.fn(),
  fetchAccount: (...args) => api.fetchAccount(...args),
}));

import { ApiError } from '../api/client';
import VaultAddress from './VaultAddress';

const ADDRESS = '0x59f3d0c53bc46a35a81e478b080cc8afa2fc88de';

function render(ui = <VaultAddress />) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  auth.current = { status: 'authenticated', notifyUnauthorized: vi.fn() };
  api.fetchAccount = vi.fn().mockResolvedValue({
    address: '0xc0b0e77000aa0826b7db9d1fe3760d26559643bb',
    vaults: { address: ADDRESS },
  });
});

describe('VaultAddress', () => {
  test('shows the payment address from the account resource', async () => {
    render();

    expect(await screen.findByText(ADDRESS)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Your payment address' })).toBeInTheDocument();
    expect(screen.getByText(/same on every supported chain/i)).toBeInTheDocument();
  });

  test('accepts the documented array-shaped vault response', async () => {
    api.fetchAccount.mockResolvedValue({
      vaults: [{ address: ADDRESS }],
    });

    render();

    expect(await screen.findByText(ADDRESS)).toBeInTheDocument();
  });

  test('copies the payment address', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });

    render();
    await screen.findByText(ADDRESS);
    fireEvent.click(screen.getByRole('button', { name: 'Copy address to clipboard' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ADDRESS));
    expect(screen.getByRole('button', { name: 'Copy address to clipboard' })).toHaveTextContent(
      'Copied',
    );
  });

  test('renders an empty state for a missing or malformed address', async () => {
    api.fetchAccount.mockResolvedValue({ vaults: { address: 'not-an-address' } });

    render();

    expect(await screen.findByText('Your payment address is still being set up')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  test('renders a request failure and can notify auth on 401', async () => {
    const notifyUnauthorized = vi.fn();
    auth.current = { status: 'authenticated', notifyUnauthorized };
    api.fetchAccount.mockRejectedValue(new ApiError('Authentication required', { status: 401 }));

    render();

    expect(await screen.findByText('Could not load this data')).toBeInTheDocument();
    await waitFor(() => expect(notifyUnauthorized).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
