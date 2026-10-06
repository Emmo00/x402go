import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// `vi.hoisted` keeps the stubs above the mocked modules' own imports, which ESM
// hoisting would otherwise pull ahead of a plain `const`.
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

// Indirection through `api` so each test can install its own outcome.
vi.mock('../api/dashboard', () => ({
  fetchPayoutAddress: (...args) => api.fetchPayoutAddress(...args),
  updatePayoutAddress: (...args) => api.updatePayoutAddress(...args),
  createApiKey: (...args) => api.createApiKey(...args),
  rotateApiKey: (...args) => api.rotateApiKey(...args),
  fetchApiKey: (...args) => api.fetchApiKey(...args),
}));

import { ApiError } from '../api/client';
import PayoutSetup from './PayoutSetup';

const WALLET = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const WALLET_LOWER = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';

function setAuth(overrides) {
  auth.current = {
    status: 'authenticated',
    address: WALLET,
    notifyUnauthorized: vi.fn(),
    ...overrides,
  };
  return auth.current;
}

const submit = (value) => {
  fireEvent.change(screen.getByLabelText('Wallet address'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
};

beforeEach(() => {
  api.updatePayoutAddress = vi.fn().mockResolvedValue({ payTo: WALLET_LOWER });
  setAuth();
});

describe('PayoutSetup', () => {
  test('explains what the wallet is for before asking for it', () => {
    render(<PayoutSetup onConfigured={vi.fn()} />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Set your payout wallet' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/wallet where your settled x402 payments will be sent/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Wallet address')).toHaveValue('');
  });

  test('refuses an address that is not a Celo address', async () => {
    const onConfigured = vi.fn();
    render(<PayoutSetup onConfigured={onConfigured} />);

    submit('0xnot-an-address');

    expect(await screen.findByText('That is not a valid Celo address.')).toBeInTheDocument();
    expect(api.updatePayoutAddress).not.toHaveBeenCalled();
    expect(onConfigured).not.toHaveBeenCalled();
  });

  test('asks for an address rather than submitting an empty field', async () => {
    render(<PayoutSetup onConfigured={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(
      await screen.findByText('Enter the address that should receive your payments.'),
    ).toBeInTheDocument();
    expect(api.updatePayoutAddress).not.toHaveBeenCalled();
  });

  // A mixed-case address claims a checksum, so a mismatch is a typo that would
  // otherwise send money somewhere unrecoverable.
  test('catches an address whose checksum does not match', async () => {
    render(<PayoutSetup onConfigured={vi.fn()} />);

    submit('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD');

    expect(
      await screen.findByText('This address failed its checksum. Copy it again from your wallet.'),
    ).toBeInTheDocument();
    expect(api.updatePayoutAddress).not.toHaveBeenCalled();
  });

  test('saves the wallet and hands the flow on', async () => {
    const onConfigured = vi.fn();
    render(<PayoutSetup onConfigured={onConfigured} />);

    submit(WALLET_LOWER);

    await waitFor(() => expect(onConfigured).toHaveBeenCalledOnce());
    // Submitted in the canonical EIP-55 form the backend stores, whichever
    // casing the user pasted in.
    expect(api.updatePayoutAddress).toHaveBeenCalledWith(WALLET);
  });

  test('stays on the step and explains a save that failed', async () => {
    const onConfigured = vi.fn();
    api.updatePayoutAddress = vi
      .fn()
      .mockRejectedValue(new ApiError('E11000 duplicate key', { status: 500 }));

    render(<PayoutSetup onConfigured={onConfigured} />);
    submit(WALLET_LOWER);

    expect(
      await screen.findByText(
        'The facilitator could not complete that request. Try again in a moment.',
      ),
    ).toBeInTheDocument();
    expect(onConfigured).not.toHaveBeenCalled();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Set your payout wallet' }),
    ).toBeInTheDocument();
    // The server's own wording never reaches the screen.
    expect(screen.queryByText(/E11000/)).not.toBeInTheDocument();
  });

  test('treats an expired session as a sign-out', async () => {
    const state = setAuth();
    api.updatePayoutAddress = vi
      .fn()
      .mockRejectedValue(new ApiError('Authentication required', { status: 401 }));

    render(<PayoutSetup onConfigured={vi.fn()} />);
    submit(WALLET_LOWER);

    expect(
      await screen.findByText('Your session has expired. Sign in again to continue.'),
    ).toBeInTheDocument();
    expect(state.notifyUnauthorized).toHaveBeenCalledOnce();
  });

  test('offers the connected wallet as a shortcut, not an assumption', () => {
    render(<PayoutSetup onConfigured={vi.fn()} />);

    expect(screen.getByLabelText('Wallet address')).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: 'Use this address' }));

    expect(screen.getByLabelText('Wallet address')).toHaveValue(WALLET);
  });
});
