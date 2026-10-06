import { useState } from 'react';
import { updatePayoutAddress } from '../api/dashboard';
import { useAuth } from '../auth/AuthContext';
import { Address, Button, Field, Notice } from '../components/ui/primitives';
import { describeError, isUnauthorized } from './errors';
import { checksumPayoutAddress, validatePayoutAddress } from './payoutAddress';

/**
 * The onboarding step for accounts that have no payout wallet yet.
 *
 * The backend requires one before an API key can be created, so this is the
 * only thing standing between a signed-in account and the dashboard, and it is
 * shown exactly once per account.
 *
 * The connected wallet is offered as a shortcut but never assumed: a payout
 * wallet does not have to be the wallet that signs in, so the address is taken
 * from the field and submitted as typed — validated, then checksummed.
 */
export default function PayoutSetup({ onConfigured }) {
  const { address, notifyUnauthorized } = useAuth();

  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  const trimmed = value.trim();
  const validationError = validatePayoutAddress(trimmed);
  const usingConnected = Boolean(address) && trimmed.toLowerCase() === address.toLowerCase();

  async function handleSubmit(event) {
    event.preventDefault();
    setTouched(true);
    setError(null);

    if (validationError) return;

    setPending(true);
    try {
      // `PUT /payout` returns the stored address, so a 200 is the backend
      // confirming the write — there is nothing further to check.
      await updatePayoutAddress(checksumPayoutAddress(trimmed));
      onConfigured();
    } catch (cause) {
      if (isUnauthorized(cause)) notifyUnauthorized();
      setError(describeError(cause));
    } finally {
      setPending(false);
    }
  }

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
            <p className="gate__label">Setup · payout wallet</p>
            <h1 className="gate__title">Set your payout wallet</h1>
            <p className="gate__body">
              This is the wallet where your settled x402 payments will be sent.
              Enter a wallet address to continue.
            </p>

            <form className="gate__form" onSubmit={handleSubmit} noValidate>
              <Field
                id="payout-wallet"
                label="Wallet address"
                placeholder="0x…"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onBlur={() => setTouched(true)}
                error={touched ? validationError : null}
                hint="Must be a Celo address. Payments cannot be reversed, so check it carefully."
                autoComplete="off"
                spellCheck="false"
                autoFocus
              />

              {address && !usingConnected ? (
                <p className="gate__session">
                  Connected wallet: <Address value={address} full />{' '}
                  <Button
                    variant="link"
                    onClick={() => {
                      setValue(address);
                      setTouched(false);
                    }}
                  >
                    Use this address
                  </Button>
                </p>
              ) : null}

              {error ? (
                <Notice tone="error" title="Could not save your payout wallet">
                  {error}
                </Notice>
              ) : null}

              <div className="actions">
                <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
                  {pending ? 'Saving…' : 'Continue'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}
