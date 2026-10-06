import { useState } from 'react';
import { fetchPayoutAddress, updatePayoutAddress } from '../api/dashboard';
import { useAuth } from '../auth/AuthContext';
import {
  Address,
  Button,
  Card,
  CardHeader,
  CopyButton,
  Field,
  Notice,
  StatePanel,
} from '../components/ui/primitives';
import { describeError, isUnauthorized } from './errors';
import { checksumPayoutAddress, validatePayoutAddress } from './payoutAddress';
import ResourceState, { ActionErrorNotice } from './ResourceState';
import { useResource } from './useResource';

/**
 * Settings — where the merchant's funds are sent.
 *
 * The change is submitted through the facilitator's API and nowhere else, so
 * whatever authorization the backend requires — today the signed-in session,
 * later a signature the vault verifies — is applied to the request as written.
 * The dashboard has no path that writes around it.
 */
export default function Settings() {
  const { notifyUnauthorized } = useAuth();
  const resource = useResource(fetchPayoutAddress);

  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [updated, setUpdated] = useState(null);

  const trimmed = value.trim();
  const validationError = validatePayoutAddress(trimmed);

  async function handleSubmit(event) {
    event.preventDefault();
    setTouched(true);
    setActionError(null);
    setUpdated(null);

    if (validationError) return;

    setPending(true);
    try {
      // `PUT /payout` echoes the stored address, so the response is the new
      // value rather than something to assume.
      const result = await updatePayoutAddress(checksumPayoutAddress(trimmed));
      setUpdated(result?.payTo ?? checksumPayoutAddress(trimmed));
      setValue('');
      setTouched(false);
      resource.reload();
    } catch (cause) {
      if (isUnauthorized(cause)) notifyUnauthorized();
      setActionError(cause);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="dash-page">
      <header className="page-head">
        <h1 className="page-head__title">Settings</h1>
        <p className="page-head__desc">
          The account details your facilitator uses to settle and deliver
          payments.
        </p>
      </header>

      <section className="section" aria-labelledby="current-payout">
        <h2 className="section__label" id="current-payout">
          Payout wallet
        </h2>
        <ResourceState
          resource={resource}
          label="Payout wallet"
          loadingTitle="Loading your payout wallet…"
        >
          {(data) =>
            data?.payTo ? (
              <Card>
                <CardHeader
                  title="Payout wallet"
                  description="The wallet where your settled x402 payments are sent."
                />
                <p className="payout-current">
                  <Address value={data.payTo} full />
                </p>
                <div className="actions">
                  <CopyButton value={data.payTo} label="Copy address" />
                </div>
              </Card>
            ) : (
              <StatePanel
                label="No payout wallet"
                title="No payout wallet set"
                data-empty="payout-wallet"
              >
                Settled payments have nowhere to go until you set one. Reload
                this page to finish onboarding.
              </StatePanel>
            )
          }
        </ResourceState>
      </section>

      <Notice title="Authorization required">
        Changing this wallet requires the authorization the facilitator's API
        demands for the change. The dashboard submits the request as documented
        and does not bypass it.
      </Notice>

      <Card as="form" onSubmit={handleSubmit} noValidate>
        <CardHeader
          title="Change payout wallet"
          description="Point settled payments at a different wallet."
        />

        <Field
          id="payout-wallet"
          label="New wallet address"
          placeholder="0x…"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => setTouched(true)}
          error={touched ? validationError : null}
          hint="Must be a Celo address. Payments cannot be reversed, so check it carefully."
          autoComplete="off"
          spellCheck="false"
        />

        <div className="actions">
          <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
            {pending ? 'Saving…' : 'Update payout wallet'}
          </Button>
        </div>

        {updated ? (
          <Notice title="Payout wallet updated">
            Settled payments now go to <Address value={updated} full />.
          </Notice>
        ) : null}

        <ActionErrorNotice error={actionError} />
      </Card>
    </div>
  );
}
