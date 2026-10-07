import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Navigate, Outlet, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { auth, api } = vi.hoisted(() => ({ auth: { current: null }, api: {} }));

vi.mock('../auth/AuthContext', () => ({
  AuthStatus: {
    DISCONNECTED: 'disconnected',
    UNAUTHENTICATED: 'unauthenticated',
    AWAITING_SIGNATURE: 'awaiting_signature',
    VERIFYING: 'verifying',
    AUTHENTICATED: 'authenticated',
    EXPIRED: 'expired',
  },
  useAuth: () => auth.current,
}));

vi.mock('../api/dashboard', () => ({
  fetchAccount: (...args) => api.fetchAccount(...args),
  fetchPayoutAddress: (...args) => api.fetchPayoutAddress(...args),
  updatePayoutAddress: (...args) => api.updatePayoutAddress(...args),
  createApiKey: (...args) => api.createApiKey(...args),
  rotateApiKey: (...args) => api.rotateApiKey(...args),
  fetchApiKey: (...args) => api.fetchApiKey(...args),
}));

import { ApiError } from '../api/client';
import ApiKeys from './ApiKeys';
import OnboardingGate from './OnboardingGate';

const WALLET = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const WALLET_LOWER = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
const ISSUED_KEY = 'x402go_K7fQ2mZ0pLxVbN4tRwYcHs8dJgAeUiOn3qB6vXzM1kP';

const ISSUED = {
  apiKey: ISSUED_KEY,
  suffix: 'a91f',
  maskedKey: '••••••••••••a91f',
  createdAt: '2026-10-05T09:41:07.412Z',
};

function setAuth(overrides) {
  auth.current = {
    status: 'authenticated',
    address: WALLET,
    notifyUnauthorized: vi.fn(),
    ...overrides,
  };
  return auth.current;
}

/**
 * The gate as the app mounts it: a layout route whose child is the API-key
 * screen, so the hand-off from onboarding into key creation is exercised for
 * real rather than asserted against a stub.
 *
 * The index redirect is deliberate — it is what the dashboard has, and it is
 * the thing that used to swallow the hand-off by replacing the history entry.
 */
function renderJourney() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route
          path="/dashboard"
          element={
            <OnboardingGate>
              <Outlet />
            </OnboardingGate>
          }
        >
          <Route index element={<Navigate to="api-keys" replace />} />
          <Route path="api-keys" element={<ApiKeys />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api.fetchAccount = vi.fn().mockResolvedValue({
    address: WALLET_LOWER,
    vaults: [
      {
        network: 'celo',
        networkName: 'Celo Mainnet',
        chainId: 42220,
        address: '0x59f3d0c53bc46a35a81e478b080cc8afa2fc88de',
        deployed: false,
        explorerUrl: 'https://celoscan.io/address/0x59f3d0c53bc46a35a81e478b080cc8afa2fc88de',
      },
    ],
  });
  api.fetchPayoutAddress = vi.fn().mockResolvedValue({ payTo: null });
  api.updatePayoutAddress = vi.fn().mockResolvedValue({ payTo: WALLET_LOWER });
  // Once `GET /api-keys` exists this is what a fresh account reads back: no key.
  api.fetchApiKey = vi.fn().mockResolvedValue(null);
  api.createApiKey = vi.fn().mockResolvedValue(ISSUED);
  api.rotateApiKey = vi.fn();
  setAuth();
});

describe('OnboardingGate', () => {
  test('asks an account with no payout wallet to set one', async () => {
    renderJourney();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Set your payout wallet' }),
    ).toBeInTheDocument();
    // The dashboard is not reachable until the wallet is stored.
    expect(screen.queryByText('API keys')).not.toBeInTheDocument();
    expect(api.createApiKey).not.toHaveBeenCalled();
  });

  test('starts API-key creation as soon as the wallet is saved', async () => {
    renderJourney();

    fireEvent.change(await screen.findByLabelText('Wallet address'), {
      target: { value: WALLET_LOWER },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // No second click and no extra step: storing the wallet continues the flow.
    await waitFor(() => expect(api.createApiKey).toHaveBeenCalledOnce());
    expect(await screen.findByText(ISSUED_KEY)).toBeInTheDocument();
  });

  test('does not ask again when a payout wallet is already set', async () => {
    api.fetchPayoutAddress = vi.fn().mockResolvedValue({ payTo: WALLET_LOWER });

    renderJourney();

    expect(await screen.findByRole('heading', { level: 1, name: 'API keys' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Set your payout wallet' }),
    ).not.toBeInTheDocument();
    // Reaching the dashboard is not a reason to issue a key on its own.
    expect(api.createApiKey).not.toHaveBeenCalled();
  });

  test('keeps the saved wallet when key creation fails', async () => {
    api.createApiKey = vi
      .fn()
      .mockRejectedValue(new ApiError('E11000 duplicate key', { status: 500 }));

    renderJourney();

    fireEvent.change(await screen.findByLabelText('Wallet address'), {
      target: { value: WALLET_LOWER },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(
      await screen.findByText(
        'The facilitator could not complete that request. Try again in a moment.',
      ),
    ).toBeInTheDocument();
    // The wallet is stored, so that step is behind the user and only the key
    // needs retrying.
    expect(api.updatePayoutAddress).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Set your payout wallet' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create API key' })).toBeInTheDocument();
  });

  test('never offers the wallet form when the account cannot be read', async () => {
    api.fetchPayoutAddress = vi.fn().mockRejectedValue(new ApiError('boom', { status: 503 }));

    renderJourney();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'We could not load your account' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Wallet address')).not.toBeInTheDocument();
  });

  test('hands an expired session back to sign-in', async () => {
    const state = setAuth();
    api.fetchPayoutAddress = vi
      .fn()
      .mockRejectedValue(new ApiError('Authentication required', { status: 401 }));

    renderJourney();

    await waitFor(() => expect(state.notifyUnauthorized).toHaveBeenCalledOnce());
    expect(screen.queryByLabelText('Wallet address')).not.toBeInTheDocument();
  });
});
