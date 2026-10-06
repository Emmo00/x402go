import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { fetchPayoutAddress } from '../api/dashboard';
import { Button, StatePanel } from '../components/ui/primitives';
import { DASHBOARD_ROUTES } from '../routes';
import { OnboardingHandoff } from './onboardingHandoff';
import PayoutSetup from './PayoutSetup';
import { useResource } from './useResource';

/**
 * Holds the dashboard closed until the account has a payout wallet.
 *
 * `GET /payout` is the authority on whether onboarding is finished — the state
 * is read from the backend rather than remembered in the client, so it survives
 * a new browser, a cleared cache, or a reload, and an account that has already
 * configured a wallet is never asked twice.
 *
 * The gate sits inside `AuthGate`, so `payTo` is only ever read with a live
 * session; a 401 here clears the session and drops the user back to sign-in.
 */

/** The sign-in gate's chrome, reused so onboarding reads as the same flow. */
function GateShell({ children }) {
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
          <div className="gate__inner">{children}</div>
        </div>
      </main>
    </div>
  );
}

export default function OnboardingGate({ children }) {
  const resource = useResource(fetchPayoutAddress);
  const navigate = useNavigate();

  // Set once `PUT /payout` has been accepted. The response already confirms the
  // stored value, so re-reading it would only add a round trip.
  const [configured, setConfigured] = useState(false);

  // The intent to issue a first key, which the API-key screen picks up once it
  // mounts. Consumed by whoever acts on it, so it cannot fire twice.
  const [autoCreate, setAutoCreate] = useState(false);
  const handoff = useMemo(
    () => ({ autoCreate, consume: () => setAutoCreate(false) }),
    [autoCreate],
  );

  if (resource.status === 'loading') {
    return (
      <GateShell>
        <StatePanel label="Setup" title="Checking your account…" busy />
      </GateShell>
    );
  }

  if (resource.status === 'error' || resource.status === 'endpoint_unavailable') {
    return (
      <GateShell>
        <p className="gate__label">Setup</p>
        <h1 className="gate__title">We could not load your account</h1>
        <p className="gate__body">
          The facilitator did not answer, so x402Go cannot tell whether a payout
          wallet is set. Nothing has been changed on your account.
        </p>
        <div className="gate__actions">
          <Button onClick={resource.reload}>Try again</Button>
        </div>
      </GateShell>
    );
  }

  const payTo = resource.data?.payTo ?? null;

  if (!payTo && !configured) {
    return (
      <PayoutSetup
        onConfigured={() => {
          setConfigured(true);
          // The wallet only has to be set once, and the next thing the account
          // needs is a key, so the flow continues straight into issuing one.
          setAutoCreate(true);
          navigate(DASHBOARD_ROUTES.apiKeys, { replace: true });
        }}
      />
    );
  }

  return <OnboardingHandoff.Provider value={handoff}>{children}</OnboardingHandoff.Provider>;
}
