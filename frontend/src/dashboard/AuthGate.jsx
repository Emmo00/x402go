import { AuthStatus, useAuth } from '../auth/AuthContext';
import { Address, Button, Notice, StatePanel } from '../components/ui/primitives';
import WalletButton from './WalletButton';

/**
 * Holds the dashboard closed until the backend has accepted a signature.
 *
 * The status machine itself lives in `auth/AuthContext`; this component only
 * decides what each state looks like. The two steps mirror the API contract in
 * `backend/src/docs/auth.yaml`: get a nonce and sign it, then post the
 * signature to `/auth/verify`.
 */

const COPY = {
  [AuthStatus.DISCONNECTED]: {
    label: 'Authentication · step 1 of 2',
    title: 'Connect your wallet',
    body: 'x402Go identifies you by wallet address. Connecting does not sign anything and sends no transaction.',
  },
  [AuthStatus.UNAUTHENTICATED]: {
    label: 'Authentication · step 2 of 2',
    title: 'Sign in to x402Go',
    body: 'Your wallet will ask you to sign a short message. Signing is free, sends no transaction, and proves you control this address.',
  },
  [AuthStatus.EXPIRED]: {
    label: 'Session expired',
    title: 'Sign in again to continue',
    body: 'For security, x402Go sessions last one hour. Sign the message again to pick up where you left off.',
  },
  [AuthStatus.AWAITING_SIGNATURE]: {
    label: 'Awaiting signature',
    title: 'Confirm in your wallet',
    body: 'Approve the signature request in your wallet to continue.',
  },
  [AuthStatus.VERIFYING]: {
    label: 'Verifying',
    title: 'Checking your signature…',
    body: 'The facilitator is verifying the signed message. This takes a moment.',
  },
};

function GateActions({ status, onSignIn }) {
  if (status === AuthStatus.DISCONNECTED) {
    return <WalletButton />;
  }

  if (status === AuthStatus.AWAITING_SIGNATURE || status === AuthStatus.VERIFYING) {
    return (
      <Button disabled aria-busy="true">
        {status === AuthStatus.AWAITING_SIGNATURE ? 'Waiting for wallet' : 'Verifying'}
      </Button>
    );
  }

  return (
    <Button onClick={onSignIn}>
      {status === AuthStatus.EXPIRED ? 'Sign in again' : 'Sign in with wallet'}
    </Button>
  );
}

export default function AuthGate({ children }) {
  const { status, error, signIn, dismissError, sessionAddress } = useAuth();

  if (status === AuthStatus.AUTHENTICATED) {
    return children;
  }

  const copy = COPY[status] ?? COPY[AuthStatus.UNAUTHENTICATED];
  const busy = status === AuthStatus.AWAITING_SIGNATURE || status === AuthStatus.VERIFYING;

  return (
    <div className="gate">
      <header className="gate__header">
        <div className="container">
          <a className="logo" href="/" aria-label="x402Go home">
            x402G<span className="logo__accent">o</span>
          </a>
        </div>
      </header>

      <main className="gate__main">
        <div className="container">
          <div className="gate__inner">
            {busy ? (
              <StatePanel label={copy.label} title={copy.title} busy>
                {copy.body}
              </StatePanel>
            ) : (
              <>
                <p className="gate__label">{copy.label}</p>
                <h1 className="gate__title">{copy.title}</h1>
                <p className="gate__body">{copy.body}</p>

                {status === AuthStatus.EXPIRED && sessionAddress ? (
                  <p className="gate__session">
                    Last signed in as <Address value={sessionAddress} />
                  </p>
                ) : null}

                {error ? (
                  <Notice tone="error" title="Sign-in failed">
                    {error.message}
                  </Notice>
                ) : null}
              </>
            )}

            <div className="gate__actions">
              <GateActions status={status} onSignIn={signIn} />
              {error && !busy ? (
                <Button variant="link" onClick={dismissError}>
                  Dismiss
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
