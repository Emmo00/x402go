import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The wallet library is mocked rather than driven through a real connector, the
 * way the dashboard's tests stub the auth context: only what `AuthProvider`
 * reads from wagmi is provided, and the test moves the account object to
 * simulate connecting, switching and disconnecting.
 */
const { wallet, api } = vi.hoisted(() => ({
  wallet: { account: {}, signMessageAsync: vi.fn(), disconnect: vi.fn() },
  api: { requestNonce: vi.fn(), verifySignature: vi.fn(), logout: vi.fn() },
}));

vi.mock('wagmi', () => ({
  useAccount: () => wallet.account,
  useSignMessage: () => ({ signMessageAsync: wallet.signMessageAsync }),
  useDisconnect: () => ({ disconnect: wallet.disconnect }),
}));

vi.mock('../api/auth', () => ({
  requestNonce: api.requestNonce,
  verifySignature: api.verifySignature,
  logout: api.logout,
}));

import { AuthProvider, useAuth } from './AuthContext';
import { consumeConnectIntent, markConnectIntent } from './connectIntent';

const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const OTHER_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const CELO_CHAIN_ID = 42220;

function Status() {
  const auth = useAuth();
  return (
    <>
      <p data-testid="status">{auth.status}</p>
      <p data-testid="error">{auth.error?.code ?? ''}</p>
      <button type="button" onClick={auth.signIn}>
        sign in
      </button>
    </>
  );
}

// StrictMode mirrors src/index.jsx, so the double-invoked effects are part of
// every test rather than a case of their own.
function view() {
  return (
    <StrictMode>
      <AuthProvider>
        <Status />
      </AuthProvider>
    </StrictMode>
  );
}

/** A wallet that is connected but has never signed in. */
function connect(address = ADDRESS) {
  wallet.account = { address, chainId: CELO_CHAIN_ID, isConnected: true };
}

function disconnect() {
  wallet.account = { address: undefined, chainId: undefined, isConnected: false };
}

beforeEach(() => {
  window.localStorage.clear();
  // Drain any intent a previous test left behind.
  consumeConnectIntent();
  disconnect();

  wallet.signMessageAsync.mockReset();
  wallet.signMessageAsync.mockResolvedValue('0xsignature');
  wallet.disconnect.mockReset();

  api.requestNonce.mockReset();
  api.requestNonce.mockResolvedValue({ nonce: 'nonceone1' });
  api.verifySignature.mockReset();
  api.verifySignature.mockResolvedValue({ success: true });
  api.logout.mockReset();
});

describe('automatic sign-in after connecting', () => {
  test('a connection the user asked for signs in once, and only once', async () => {
    const { rerender } = render(view());
    expect(screen.getByTestId('status')).toHaveTextContent('disconnected');

    markConnectIntent();
    connect();
    rerender(view());

    await waitFor(() => expect(api.verifySignature).toHaveBeenCalledTimes(1));
    expect(api.requestNonce).toHaveBeenCalledWith(ADDRESS);
    expect(wallet.signMessageAsync).toHaveBeenCalledTimes(1);

    // Repeated renders — a connector event, a session write — ask for nothing
    // more: the intent was consumed by the first attempt.
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    rerender(view());
    rerender(view());

    expect(api.requestNonce).toHaveBeenCalledTimes(1);
    expect(wallet.signMessageAsync).toHaveBeenCalledTimes(1);
  });

  // The same connection appears on every page load, with nobody having clicked
  // anything: it must not sign itself in.
  test('a wallet restored on page load does not sign in', async () => {
    connect();
    render(view());

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
    expect(api.requestNonce).not.toHaveBeenCalled();
    expect(wallet.signMessageAsync).not.toHaveBeenCalled();
  });

  test('an existing session for the connected address skips signing', async () => {
    window.localStorage.setItem(
      'x402go.session',
      JSON.stringify({ address: ADDRESS, authenticatedAt: Date.now() }),
    );

    markConnectIntent();
    connect();
    render(view());

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(api.requestNonce).not.toHaveBeenCalled();
    expect(wallet.signMessageAsync).not.toHaveBeenCalled();
  });

  // A second signature prompt straight after a rejection is the behaviour the
  // automatic flow must not have.
  test('a rejected signature is reported as cancelled and never re-prompted', async () => {
    wallet.signMessageAsync.mockRejectedValue({
      code: 4001,
      message: 'User rejected the request.',
    });

    const { rerender } = render(view());
    markConnectIntent();
    connect();
    rerender(view());

    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('signature_rejected'));
    rerender(view());
    rerender(view());

    expect(api.requestNonce).toHaveBeenCalledTimes(1);
    expect(wallet.signMessageAsync).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'sign in' })).toBeEnabled();
  });
});

describe('cancelling an attempt', () => {
  /** A signature prompt that stays open until the test resolves it. */
  function pendingSignature() {
    let settle;
    wallet.signMessageAsync.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          settle = { resolve, reject };
        }),
    );
    return settle;
  }

  test('a disconnect mid-signature abandons the attempt', async () => {
    const settle = pendingSignature();

    const { rerender } = render(view());
    markConnectIntent();
    connect();
    rerender(view());
    await waitFor(() => expect(wallet.signMessageAsync).toHaveBeenCalledTimes(1));

    disconnect();
    rerender(view());
    expect(screen.getByTestId('status')).toHaveTextContent('disconnected');

    // The wallet's answer arrives after the user has already gone.
    await act(async () => settle.resolve('0xsignature'));

    expect(api.verifySignature).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('x402go.session')).toBeNull();
    expect(screen.getByTestId('status')).toHaveTextContent('disconnected');
  });

  test('an account switch mid-signature abandons the attempt', async () => {
    const settle = pendingSignature();

    const { rerender } = render(view());
    markConnectIntent();
    connect();
    rerender(view());
    await waitFor(() => expect(wallet.signMessageAsync).toHaveBeenCalledTimes(1));

    connect(OTHER_ADDRESS);
    rerender(view());

    await act(async () => settle.resolve('0xsignature'));

    // The nonce belonged to the first address, so nothing is applied to the
    // second — and no error from the abandoned attempt is shown either.
    expect(api.verifySignature).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('x402go.session')).toBeNull();
    expect(screen.getByTestId('error')).toHaveTextContent('');
    expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated');
    expect(wallet.signMessageAsync).toHaveBeenCalledTimes(1);
  });
});

describe('retrying by hand', () => {
  test('signs again with a fresh nonce', async () => {
    wallet.signMessageAsync.mockRejectedValue({
      code: 4001,
      message: 'User rejected the request.',
    });
    api.requestNonce
      .mockResolvedValueOnce({ nonce: 'nonceone1' })
      .mockResolvedValueOnce({ nonce: 'noncetwo2' });

    const { rerender } = render(view());
    markConnectIntent();
    connect();
    rerender(view());

    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('signature_rejected'));

    wallet.signMessageAsync.mockResolvedValue('0xsignature');
    fireEvent.click(screen.getByRole('button', { name: 'sign in' }));

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(api.requestNonce).toHaveBeenCalledTimes(2);
    expect(wallet.signMessageAsync).toHaveBeenCalledTimes(2);

    // The second attempt carries the new challenge, not the one that failed.
    const retryMessage = wallet.signMessageAsync.mock.calls[1][0].message;
    expect(retryMessage).toContain('noncetwo2');
    expect(retryMessage).not.toContain('nonceone1');
  });
});
