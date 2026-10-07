import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { createApiKey, fetchApiKey, rotateApiKey } from '../api/dashboard';
import { useAuth } from '../auth/AuthContext';
import {
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  LoadingState,
  Notice,
  SecretValue,
  StatePanel,
} from '../components/ui/primitives';
import { isUnauthorized } from './errors';
import { formatTimestamp } from './format';
import { useOnboardingHandoff } from './onboardingHandoff';
import ResourceState, { ActionErrorNotice } from './ResourceState';
import { useResource } from './useResource';
import VaultAddresses from './VaultAddress';

/** The documented 409 from `POST /api-keys`, in the dashboard's own words. */
const ALREADY_HAS_KEY =
  'This account already has an API key. Rotate it to issue a new one.';

/**
 * The stored key, described without its secret.
 *
 * Every field comes from a documented response body; nothing is derived from
 * the plaintext, which is gone by the time this renders.
 */
function KeyRecord({ meta }) {
  const masked = meta.maskedKey ?? `••••••••••••${meta.suffix ?? ''}`;

  return (
    <Card>
      <CardHeader
        title="Active key"
        description="Only the last four characters are kept readable. The full key is not stored and cannot be shown again."
      />
      <dl className="key-meta">
        <div className="key-meta__item">
          <dt className="key-meta__term">Key</dt>
          <dd className="key-meta__detail">{masked}</dd>
        </div>
        <div className="key-meta__item">
          <dt className="key-meta__term">Created</dt>
          <dd className="key-meta__detail">{formatTimestamp(meta.createdAt)}</dd>
        </div>
        {meta.rotatedAt ? (
          <div className="key-meta__item">
            <dt className="key-meta__term">Rotated</dt>
            <dd className="key-meta__detail">{formatTimestamp(meta.rotatedAt)}</dd>
          </div>
        ) : null}
      </dl>
    </Card>
  );
}

/**
 * API keys — the current key, and the create/rotate actions.
 *
 * A newly issued key is held in component state and nowhere else; there is no
 * storage, no URL and no context that outlives the page. Dismissing the reveal
 * drops the plaintext itself, leaving only the fields the API marks as safe to
 * display, so the key cannot be recovered from the running app afterwards.
 */
export default function ApiKeys() {
  const { notifyUnauthorized } = useAuth();
  const handoff = useOnboardingHandoff();

  const resource = useResource(fetchApiKey);

  // The whole documented payload of the last create/rotate. `apiKey` is the one
  // confidential field in it, and the one that gets cleared on dismissal.
  const [issued, setIssued] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [pending, setPending] = useState(null);
  const [confirming, setConfirming] = useState(false);

  const revealed = issued?.apiKey ?? null;

  const run = useCallback(
    async (kind) => {
      setActionError(null);
      setConflict(null);
      setPending(kind);

      try {
        const result = kind === 'create' ? await createApiKey() : await rotateApiKey();

        if (!result?.apiKey) {
          // The contract puts the plaintext in this response and nowhere else,
          // so a body without it leaves nothing safe to show or retry with.
          setActionError(new Error('The API did not return a key.'));
          return;
        }

        setIssued(result);
        setConfirming(false);
      } catch (cause) {
        setConfirming(false);

        if (isUnauthorized(cause)) notifyUnauthorized();

        if (cause instanceof ApiError && cause.status === 409) {
          // Documented as a conflict rather than a failure: the account already
          // holds a key, which is a state it is allowed to be in.
          setConflict(ALREADY_HAS_KEY);
          return;
        }

        setActionError(cause);
      } finally {
        setPending(null);
      }
    },
    [notifyUnauthorized],
  );

  // Onboarding arrives with the intent to issue a first key already recorded,
  // so a brand-new account gets one without a second click. Consuming the flag
  // clears it, and the ref guards against React's double-invoked effects, so
  // neither a remount nor a later visit can silently issue another key.
  const autoCreatedRef = useRef(false);

  useEffect(() => {
    if (!handoff?.autoCreate || autoCreatedRef.current) return;
    autoCreatedRef.current = true;
    handoff.consume();
    run('create');
  }, [handoff, run]);

  const dismiss = useCallback(
    () => setIssued((prev) => (prev ? { ...prev, apiKey: null } : prev)),
    [],
  );

  const hasKey =
    Boolean(issued) || (resource.status === 'ready' && Boolean(resource.data?.suffix));
  const busy = pending !== null;
  const creating = pending === 'create' && !issued;

  return (
    <div className="dash-page">
      <header className="page-head">
        <h1 className="page-head__title">API keys</h1>
        <p className="page-head__desc">
          Manage the keys used to authenticate your x402Go integrations.
        </p>
      </header>

      <Notice title="Keep your API key private">
        Keep your API key private. Never expose it in client-side code or public
        repositories.
      </Notice>

      {revealed ? (
        <Card>
          <CardHeader
            title={issued.rotatedAt ? 'Your new API key' : 'Your API key'}
            description={
              issued.rotatedAt
                ? 'Your API key has been rotated. Your previous key stopped working immediately.'
                : 'Your API key has been created.'
            }
            action={
              <Button variant="ghost" onClick={dismiss}>
                Done
              </Button>
            }
          />
          <SecretValue value={revealed} copyLabel="Copy API key" />
          <p className="section__desc">
            Save this key somewhere secure. You will not be able to view it
            again.
          </p>
        </Card>
      ) : null}

      {conflict ? <Notice title="API key already issued">{conflict}</Notice> : null}

      <ActionErrorNotice error={actionError} />

      <section className="section" aria-labelledby="current-key">
        <h2 className="section__label" id="current-key">
          Current key
        </h2>

        {creating ? (
          <LoadingState label="API key" title="Creating your API key…" />
        ) : issued ? (
          <KeyRecord meta={issued} />
        ) : (
          <ResourceState
            resource={resource}
            label="API key"
            loadingTitle="Loading your API key…"
          >
            {(data) =>
              data?.suffix ? (
                <KeyRecord meta={data} />
              ) : (
                <StatePanel
                  label="No API key"
                  title="You have no API key yet"
                  data-empty="api-key"
                >
                  Create one to start authenticating requests against the
                  facilitator.
                </StatePanel>
              )
            }
          </ResourceState>
        )}
      </section>

      {hasKey ? (
        <Card>
          <CardHeader
            title="Rotate API key"
            description="Issue a replacement key. Your current key stops working the moment the new one is issued, and it cannot be recovered afterwards."
            action={
              <Button variant="ghost" onClick={() => setConfirming(true)} disabled={busy}>
                Rotate API key
              </Button>
            }
          />
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="Create API key"
            description="Issue the key your application uses to authenticate against the facilitator."
            action={
              <Button onClick={() => run('create')} disabled={busy}>
                {pending === 'create' ? 'Creating…' : 'Create API key'}
              </Button>
            }
          />
        </Card>
      )}

      <ConfirmDialog
        open={confirming}
        title="Rotate API key?"
        description="Your current API key will stop working immediately. Any application using it must be updated with the new key."
        confirmLabel="Rotate API key"
        pendingLabel="Rotating…"
        pending={pending === 'rotate'}
        onConfirm={() => run('rotate')}
        onCancel={() => setConfirming(false)}
      />

      {/* Last on the page, deliberately: a key is disclosed exactly once by
          create and rotate, and nothing may sit between the action and the
          value it reveals. */}
      <VaultAddresses />
    </div>
  );
}
