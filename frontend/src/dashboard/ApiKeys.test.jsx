import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { OnboardingHandoff } from './onboardingHandoff';

const ISSUED_KEY = 'x402go_K7fQ2mZ0pLxVbN4tRwYcHs8dJgAeUiOn3qB6vXzM1kP';
const ROTATED_KEY = 'x402go_Zq4Wn1sT8bYdF5hJm2Kp6RcXv9LgEaUo7iN3wBy0DS';

const FIRST = {
  apiKey: ISSUED_KEY,
  suffix: 'a91f',
  maskedKey: '••••••••••••a91f',
  createdAt: '2026-10-05T09:41:07.412Z',
};

const ROTATED = {
  apiKey: ROTATED_KEY,
  suffix: 'b7c2',
  maskedKey: '••••••••••••b7c2',
  createdAt: '2026-10-06T10:00:00.000Z',
  rotatedAt: '2026-10-06T10:00:00.000Z',
};

function setAuth(overrides) {
  auth.current = {
    status: 'authenticated',
    address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    notifyUnauthorized: vi.fn(),
    ...overrides,
  };
  return auth.current;
}

/** `handoff` is the onboarding intent the gate publishes; null on a plain visit. */
function renderKeys(handoff = null) {
  return render(
    <OnboardingHandoff.Provider value={handoff}>
      <ApiKeys />
    </OnboardingHandoff.Provider>,
  );
}

const openRotation = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Rotate API key' }));
  return screen.getByRole('dialog');
};

beforeEach(() => {
  api.fetchAccount = vi.fn().mockResolvedValue({
    address: '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed',
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
  api.fetchPayoutAddress = vi.fn();
  api.updatePayoutAddress = vi.fn();
  // What an account with one key reads back once `GET /api-keys` exists.
  api.fetchApiKey = vi.fn().mockResolvedValue({
    suffix: FIRST.suffix,
    maskedKey: FIRST.maskedKey,
    createdAt: FIRST.createdAt,
  });
  api.createApiKey = vi.fn().mockResolvedValue(FIRST);
  api.rotateApiKey = vi.fn().mockResolvedValue(ROTATED);
  setAuth();
});

describe('ApiKeys', () => {
  test('describes the key that is in force without ever showing it', async () => {
    renderKeys();

    expect(await screen.findByText('Active key')).toBeInTheDocument();
    // Only the stored suffix is readable; the key itself is never sent back.
    expect(screen.getByText('••••••••••••a91f')).toBeInTheDocument();
    expect(screen.queryByText(ISSUED_KEY)).not.toBeInTheDocument();
    // A key already exists, so the page offers a replacement, not a second key.
    expect(screen.getByRole('button', { name: 'Rotate API key' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create API key' })).not.toBeInTheDocument();
  });

  test('starts from an empty state when the account has no key', async () => {
    api.fetchApiKey = vi.fn().mockResolvedValue(null);

    renderKeys();

    expect(await screen.findByText('You have no API key yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create API key' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rotate API key' })).not.toBeInTheDocument();
  });

  test('shows a newly created key once, with its copy action', async () => {
    api.fetchApiKey = vi.fn().mockResolvedValue(null);

    renderKeys();
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));

    expect(await screen.findByText(ISSUED_KEY)).toBeInTheDocument();
    expect(screen.getByText('Your API key has been created.')).toBeInTheDocument();
    expect(screen.getByText(/You will not be able to view it again/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Copy API key to clipboard' }),
    ).toBeInTheDocument();
  });

  test('removes the plaintext from state once the reveal is dismissed', async () => {
    api.fetchApiKey = vi.fn().mockResolvedValue(null);

    renderKeys();
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));
    await screen.findByText(ISSUED_KEY);

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(screen.queryByText(ISSUED_KEY)).not.toBeInTheDocument();
    // What is left is the metadata the API marks safe to display.
    expect(screen.getByText('••••••••••••a91f')).toBeInTheDocument();
  });

  test('reports a key that could not be created without inventing one', async () => {
    api.fetchApiKey = vi.fn().mockResolvedValue(null);
    api.createApiKey = vi
      .fn()
      .mockRejectedValue(new ApiError('E11000 duplicate key', { status: 500 }));

    renderKeys();
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));

    expect(
      await screen.findByText(
        'The facilitator could not complete that request. Try again in a moment.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/E11000/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create API key' })).toBeInTheDocument();
  });

  // An account may hold exactly one key, so a second create is a conflict —
  // which is an answer about the account's state, not a failure.
  test('reads a conflict as "you already have a key"', async () => {
    api.fetchApiKey = vi.fn().mockResolvedValue(null);
    api.createApiKey = vi
      .fn()
      .mockRejectedValue(new ApiError('This account already has an API key.', { status: 409 }));

    renderKeys();
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));

    expect(
      await screen.findByText(
        'This account already has an API key. Rotate it to issue a new one.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  test('creates the first key automatically when onboarding hands over', async () => {
    api.fetchApiKey = vi.fn().mockResolvedValue(null);
    const consume = vi.fn();

    renderKeys({ autoCreate: true, consume });

    expect(await screen.findByText(ISSUED_KEY)).toBeInTheDocument();
    expect(api.createApiKey).toHaveBeenCalledOnce();
    // The intent is spent, so nothing can issue a second key on a later visit.
    expect(consume).toHaveBeenCalledOnce();
  });

  test('does not issue a key on a visit that did not come from onboarding', async () => {
    api.fetchApiKey = vi.fn().mockResolvedValue(null);

    renderKeys();

    expect(await screen.findByText('You have no API key yet')).toBeInTheDocument();
    expect(api.createApiKey).not.toHaveBeenCalled();
  });

  test('confirms before rotating, and does nothing if the user declines', async () => {
    renderKeys();

    const dialog = await openRotation();

    expect(within(dialog).getByText('Rotate API key?')).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        'Your current API key will stop working immediately. Any application using it must be updated with the new key.',
      ),
    ).toBeInTheDocument();
    expect(api.rotateApiKey).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.rotateApiKey).not.toHaveBeenCalled();
    expect(screen.getByText('••••••••••••a91f')).toBeInTheDocument();
  });

  test('replaces the key on rotation and reveals the new one once', async () => {
    renderKeys();

    const dialog = await openRotation();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate API key' }));

    expect(await screen.findByText(ROTATED_KEY)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The replaced key is gone from the page entirely, not merely hidden.
    expect(screen.queryByText('••••••••••••a91f')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(screen.queryByText(ROTATED_KEY)).not.toBeInTheDocument();
    expect(screen.getByText('••••••••••••b7c2')).toBeInTheDocument();
    expect(screen.getByText('Rotated')).toBeInTheDocument();
  });

  test('keeps the current key when rotation fails', async () => {
    api.rotateApiKey = vi
      .fn()
      .mockRejectedValue(new ApiError('E11000 duplicate key', { status: 500 }));

    renderKeys();

    const dialog = await openRotation();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate API key' }));

    expect(
      await screen.findByText(
        'The facilitator could not complete that request. Try again in a moment.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The key that is still in force is the one the page already described.
    expect(screen.getByText('••••••••••••a91f')).toBeInTheDocument();
    expect(screen.queryByText(ROTATED_KEY)).not.toBeInTheDocument();
  });

  test('hands an expired session back to sign-in', async () => {
    const state = setAuth();
    api.fetchApiKey = vi.fn().mockResolvedValue(null);
    api.createApiKey = vi
      .fn()
      .mockRejectedValue(new ApiError('Authentication required', { status: 401 }));

    renderKeys();
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));

    await waitFor(() => expect(state.notifyUnauthorized).toHaveBeenCalledOnce());
    expect(
      await screen.findByText('Your session has expired. Sign in again to continue.'),
    ).toBeInTheDocument();
  });
});
