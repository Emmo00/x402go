import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { updatePayoutAddress, updateTransactionTag } from '../api/dashboard';
import { RESOURCES } from '../api/resources';
import { useAuth } from '../auth/AuthContext';
import { Address, Button, Card, CardHeader, CopyButton, Field, Notice, StatePanel } from '../components/ui/primitives';
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
  const queryClient = useQueryClient();
  const resource = useResource(RESOURCES.payout);
  const transactionTagResource = useResource(RESOURCES.transactionTag);

  const [payoutWallet, setPayoutWallet] = useState('');
  const [transactionTagDraft, setTransactionTagDraft] = useState(null);
  const [payoutWalletTouched, setPayoutWalletTouched] = useState(false);
  const [transactionTagTouched, setTransactionTagTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [transactionTagPending, setTransactionTagPending] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [transactionTagActionError, setTransactionTagActionError] = useState(null);
  const [updated, setUpdated] = useState(null);
  const [transactionTagUpdated, setTransactionTagUpdated] = useState(null);

  const storedTransactionTag = transactionTagResource.data?.transactionTag ?? '';
  const transactionTag = transactionTagDraft ?? storedTransactionTag;

  const trimmed = payoutWallet.trim();
  const validationError = validatePayoutAddress(trimmed);
  const transactionTagValidationError =
    transactionTag.trim().length > 32
      ? 'Transaction tag must be 32 characters or less'
      : transactionTag.trim().length === 0
        ? 'Transaction tag cannot be empty'
        : null;

  async function handleSubmit(event) {
    event.preventDefault();
    setPayoutWalletTouched(true);
    setActionError(null);
    setUpdated(null);

    if (validationError) return;

    setPending(true);
    try {
      // `PUT /payout` echoes the stored address, so the response is the new
      // value rather than something to assume.
      const result = await updatePayoutAddress(checksumPayoutAddress(trimmed));
      setUpdated(result?.payTo ?? checksumPayoutAddress(trimmed));
      setPayoutWallet('');
      setPayoutWalletTouched(false);
      // The payout wallet is a cached read shared with the onboarding gate, so
      // the write invalidates it rather than refetching through this screen.
      queryClient.invalidateQueries({ queryKey: RESOURCES.payout.key });
    } catch (cause) {
      if (isUnauthorized(cause)) notifyUnauthorized();
      setActionError(cause);
    } finally {
      setPending(false);
    }
  }

  async function handleTransactionTagSubmit(event) {
    event.preventDefault();
    setTransactionTagTouched(true);
    setTransactionTagActionError(null);
    setTransactionTagUpdated(null);

    if (transactionTagValidationError) return;

    setTransactionTagPending(true);
    try {
      const result = await updateTransactionTag(transactionTag.trim());
      const saved = result?.transactionTag ?? transactionTag.trim();
      setTransactionTagUpdated(saved);
      // Keep the saved value as the draft (rather than resetting to `null`) so
      // the input doesn't flash the old tag while the invalidated query refetches.
      setTransactionTagDraft(saved);
      setTransactionTagTouched(false);
      queryClient.invalidateQueries({ queryKey: RESOURCES.transactionTag.key });
    } catch (cause) {
      if (isUnauthorized(cause)) notifyUnauthorized();
      setTransactionTagActionError(cause);
    } finally {
      setTransactionTagPending(false);
    }
  }

  return (
    <div className="dash-page">
      <header className="page-head">
        <h1 className="page-head__title">Settings</h1>
        <p className="page-head__desc">The account details your facilitator uses to settle and deliver payments.</p>
      </header>

      <section className="section" aria-labelledby="current-payout">
        <h2 className="section__label" id="current-payout">
          Payout wallet
        </h2>
        <ResourceState resource={resource} label="Payout wallet" loadingTitle="Loading your payout wallet…">
          {(data) =>
            data?.payTo ? (
              <Card>
                <CardHeader title="Payout wallet" description="The wallet where your settled x402 payments are sent." />
                <p className="payout-current">
                  <Address value={data.payTo} full />
                </p>
                <div className="actions">
                  <CopyButton value={data.payTo} label="Copy address" />
                </div>
              </Card>
            ) : (
              <StatePanel label="No payout wallet" title="No payout wallet set" data-empty="payout-wallet">
                Settled payments have nowhere to go until you set one. Reload this page to finish onboarding.
              </StatePanel>
            )
          }
        </ResourceState>
      </section>

      <Notice title="Authorization required">Changing this wallet requires authorization from your wallet.</Notice>

      <Card as="form" onSubmit={handleSubmit} noValidate>
        <CardHeader title="Change payout wallet" description="Point settled payments at a different wallet." />

        <Field
          id="payout-wallet"
          label="New wallet address"
          placeholder="0x…"
          value={payoutWallet}
          onChange={(event) => setPayoutWallet(event.target.value)}
          onBlur={() => setPayoutWalletTouched(true)}
          error={payoutWalletTouched ? validationError : null}
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

      <Card as="form" onSubmit={handleTransactionTagSubmit} noValidate>
        <CardHeader title="Change Transaction Tag" description="Change the tag used for tracking transactions." />

        <Field
          id="transaction-tag"
          label="New transaction tag"
          placeholder="celo_123456789"
          value={transactionTag}
          onChange={(event) => setTransactionTagDraft(event.target.value)}
          onBlur={() => setTransactionTagTouched(true)}
          error={transactionTagTouched ? transactionTagValidationError : null}
          hint=""
          autoComplete="off"
          spellCheck="false"
        />

        <div className="actions">
          <Button type="submit" disabled={transactionTagPending} aria-busy={transactionTagPending || undefined}>
            {transactionTagPending ? 'Saving…' : 'Update transaction tag'}
          </Button>
        </div>

        {transactionTagUpdated ? (
          <Notice title="Transaction tag updated">
            Settled payments now use the tag <code>{transactionTagUpdated}</code>.
          </Notice>
        ) : null}

        <ActionErrorNotice error={transactionTagActionError} />
      </Card>
    </div>
  );
}
