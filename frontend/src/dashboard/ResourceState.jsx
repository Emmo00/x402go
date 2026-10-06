import { EndpointUnavailableError } from '../api/client';
import { Button, LoadingState, Notice, StatePanel } from '../components/ui/primitives';
import { describeError } from './errors';

/**
 * Renders the loading, unavailable and error states for a screen's data
 * resource, so each page only describes what it does once the data arrives.
 *
 * A missing endpoint is presented as its own state rather than as a failure:
 * nothing is broken, the backend simply does not serve that resource yet, and
 * the dashboard says so instead of inventing placeholder figures.
 */
export default function ResourceState({ resource, label, loadingTitle, children }) {
  const { status, data, error, reload } = resource;

  if (status === 'loading') {
    return <LoadingState label={label} title={loadingTitle} />;
  }

  if (status === 'endpoint_unavailable') {
    return (
      <StatePanel
        label="Endpoint not available"
        title="Not available yet"
        data-unavailable={error.endpoint}
      >
        The x402Go API does not expose <code>{error.endpoint}</code> yet, so
        there is nothing to read from — and no sample data is shown in its
        place. When that endpoint exists, implement it in{' '}
        <code>src/api/dashboard.js</code>; this screen needs no changes.
      </StatePanel>
    );
  }

  if (status === 'error') {
    return (
      <div className="section">
        <StatePanel tone="error" label="Request failed" title="Could not load this data">
          {describeError(error)}
        </StatePanel>
        <div className="actions">
          <Button variant="ghost" onClick={reload}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return children(data);
}

/** Shared error presentation for the actions on the API-key and payout screens. */
export function ActionErrorNotice({ error }) {
  if (!error) return null;

  if (error instanceof EndpointUnavailableError) {
    return (
      <Notice title="Not available yet">
        The x402Go API does not expose <code>{error.endpoint}</code> yet, so
        this action cannot be completed. Implement it in{' '}
        <code>src/api/dashboard.js</code> once the endpoint is defined.
      </Notice>
    );
  }

  // The backend's own wording is never surfaced — it is written for whoever is
  // reading server logs, and it can name internals the user has no use for.
  return (
    <Notice tone="error" title="Something went wrong">
      {describeError(error)}
    </Notice>
  );
}
