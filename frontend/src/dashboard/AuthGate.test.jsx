import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

// `vi.hoisted` keeps the stub above the mocked module's own import, which ESM
// hoisting would otherwise pull ahead of a plain `const`.
const { auth } = vi.hoisted(() => ({ auth: { current: null } }));

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

vi.mock('./WalletButton', () => ({
  default: () => <button type="button">Connect wallet</button>,
}));

import AuthGate from './AuthGate';

function setAuth(overrides) {
  auth.current = {
    status: 'unauthenticated',
    error: null,
    signIn: vi.fn(),
    dismissError: vi.fn(),
    sessionAddress: null,
    ...overrides,
  };
  return auth.current;
}

describe('AuthGate', () => {
  test('asks for a wallet connection before anything else', () => {
    setAuth({ status: 'disconnected' });

    render(
      <AuthGate>
        <p>dashboard</p>
      </AuthGate>,
    );

    expect(
      screen.getByRole('heading', { level: 1, name: 'Connect your wallet' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();
    expect(screen.queryByText('dashboard')).not.toBeInTheDocument();
  });

  test('renders the dashboard once the session is authenticated', () => {
    setAuth({ status: 'authenticated' });

    render(
      <AuthGate>
        <p>dashboard</p>
      </AuthGate>,
    );

    expect(screen.getByText('dashboard')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  test('reports a rejected signature and lets the user dismiss it', () => {
    const state = setAuth({
      status: 'unauthenticated',
      error: { message: 'Signature request rejected in your wallet.' },
    });

    render(
      <AuthGate>
        <p>dashboard</p>
      </AuthGate>,
    );

    expect(screen.getByText('Signature request rejected in your wallet.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(state.dismissError).toHaveBeenCalledOnce();
  });

  test('offers a fresh sign-in when the session has expired', () => {
    setAuth({
      status: 'expired',
      sessionAddress: '0x1234567890abcdef1234567890abcdef12345678',
    });

    render(
      <AuthGate>
        <p>dashboard</p>
      </AuthGate>,
    );

    expect(
      screen.getByRole('heading', { level: 1, name: 'Sign in again to continue' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
    expect(screen.getByText('0x1234…5678')).toBeInTheDocument();
  });

  test('blocks the dashboard while the wallet is signing', () => {
    setAuth({ status: 'awaiting_signature' });

    render(
      <AuthGate>
        <p>dashboard</p>
      </AuthGate>,
    );

    expect(screen.getByText('Confirm in your wallet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Waiting for wallet' })).toBeDisabled();
  });
});
