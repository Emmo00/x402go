import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  fetchPayoutAddress: (...args) => api.fetchPayoutAddress(...args),
  updatePayoutAddress: (...args) => api.updatePayoutAddress(...args),
  createApiKey: (...args) => api.createApiKey(...args),
  rotateApiKey: (...args) => api.rotateApiKey(...args),
  fetchApiKey: (...args) => api.fetchApiKey(...args),
}));

import { ApiError } from '../api/client';
import Settings from './Settings';

const CURRENT = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
// Typed all in lower case, as a wallet or block explorer would hand it over.
const TYPED = '0x9f3f5391b2a4a3b0f4c1d2e3a4b5c6d7e8f90123';
// The canonical EIP-55 form, which is what the dashboard submits.
const CANONICAL = '0x9f3F5391b2A4a3b0F4C1D2e3a4b5c6D7E8F90123';

function setAuth(overrides) {
  auth.current = {
    status: 'authenticated',
    address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    notifyUnauthorized: vi.fn(),
    ...overrides,
  };
  return auth.current;
}

const updateTo = (value) => {
  fireEvent.change(screen.getByLabelText('New wallet address'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Update payout wallet' }));
};

beforeEach(() => {
  api.fetchPayoutAddress = vi.fn().mockResolvedValue({ payTo: CURRENT });
  api.updatePayoutAddress = vi.fn().mockResolvedValue({ payTo: CANONICAL });
  api.createApiKey = vi.fn();
  api.rotateApiKey = vi.fn();
  api.fetchApiKey = vi.fn();
  setAuth();
});

describe('Settings', () => {
  test('shows the wallet settled payments are sent to', async () => {
    render(<Settings />);

    expect(
      await screen.findByRole('heading', { level: 3, name: 'Payout wallet' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('The wallet where your settled x402 payments are sent.'),
    ).toBeInTheDocument();
    expect(screen.getByText(CURRENT)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Copy address to clipboard' }),
    ).toBeInTheDocument();
  });

  test('states that the change is authorized by the backend, not the dashboard', async () => {
    render(<Settings />);

    expect(await screen.findByText('Authorization required')).toBeInTheDocument();
  });

  test('updates the payout wallet through the documented endpoint', async () => {
    render(<Settings />);
    await screen.findByRole('heading', { level: 3, name: 'Payout wallet' });

    updateTo(TYPED);

    await waitFor(() => expect(api.updatePayoutAddress).toHaveBeenCalledWith(CANONICAL));
    expect(await screen.findByText(/Settled payments now go to/i)).toBeInTheDocument();
    expect(screen.getByText('New wallet address')).toBeInTheDocument();
  });

  test('refuses an address it cannot validate, without calling the API', async () => {
    render(<Settings />);
    await screen.findByRole('heading', { level: 3, name: 'Payout wallet' });

    updateTo('0xnot-an-address');

    expect(await screen.findByText('That is not a valid Celo address.')).toBeInTheDocument();
    expect(api.updatePayoutAddress).not.toHaveBeenCalled();
  });

  test('explains a failed change and keeps the current wallet in place', async () => {
    api.updatePayoutAddress = vi
      .fn()
      .mockRejectedValue(new ApiError('E11000 duplicate key', { status: 500 }));

    render(<Settings />);
    await screen.findByRole('heading', { level: 3, name: 'Payout wallet' });

    updateTo(TYPED);

    expect(
      await screen.findByText(
        'The facilitator could not complete that request. Try again in a moment.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/E11000/)).not.toBeInTheDocument();
    expect(screen.getByText(CURRENT)).toBeInTheDocument();
    expect(screen.queryByText(/Settled payments now go to/i)).not.toBeInTheDocument();
  });

  test('treats an expired session as a sign-out', async () => {
    const state = setAuth();
    api.updatePayoutAddress = vi
      .fn()
      .mockRejectedValue(new ApiError('Authentication required', { status: 401 }));

    render(<Settings />);
    await screen.findByRole('heading', { level: 3, name: 'Payout wallet' });

    updateTo(TYPED);

    expect(
      await screen.findByText('Your session has expired. Sign in again to continue.'),
    ).toBeInTheDocument();
    expect(state.notifyUnauthorized).toHaveBeenCalledOnce();
  });
});
