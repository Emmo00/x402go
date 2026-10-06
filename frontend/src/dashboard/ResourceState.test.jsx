import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ApiError, EndpointUnavailableError } from '../api/client';
import ResourceState, { ActionErrorNotice } from './ResourceState';

const renderText = (data) => <p>value: {data.value}</p>;

describe('ResourceState', () => {
  test('shows a busy label while the resource loads', () => {
    render(
      <ResourceState
        resource={{ status: 'loading', data: null, error: null, reload: vi.fn() }}
        label="Overview"
        loadingTitle="Loading your payments…"
      >
        {renderText}
      </ResourceState>,
    );

    expect(screen.getByText('Loading your payments…')).toBeInTheDocument();
    expect(screen.getByText('Overview')).toBeInTheDocument();
  });

  test('renders the screen once the data arrives', () => {
    render(
      <ResourceState
        resource={{ status: 'ready', data: { value: 42 }, error: null, reload: vi.fn() }}
        label="Overview"
      >
        {renderText}
      </ResourceState>,
    );

    expect(screen.getByText('value: 42')).toBeInTheDocument();
  });

  // A missing endpoint is not a failure, so it must not read like one.
  test('distinguishes a missing endpoint from a failed request', () => {
    render(
      <ResourceState
        resource={{
          status: 'endpoint_unavailable',
          data: null,
          error: new EndpointUnavailableError('merchant overview'),
          reload: vi.fn(),
        }}
        label="Overview"
      >
        {renderText}
      </ResourceState>,
    );

    expect(screen.getByText('Not available yet')).toBeInTheDocument();
    expect(screen.getByText('merchant overview')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Could not load/i)).not.toBeInTheDocument();
  });

  test('offers a retry when a request genuinely fails', () => {
    const reload = vi.fn();

    render(
      <ResourceState
        resource={{
          status: 'error',
          data: null,
          error: new ApiError('Cannot reach the x402Go API.', { code: 'network_error' }),
          reload,
        }}
        label="Overview"
      >
        {renderText}
      </ResourceState>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Cannot reach the x402Go API.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe('ActionErrorNotice', () => {
  test('renders nothing when there is no error', () => {
    const { container } = render(<ActionErrorNotice error={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('explains an endpoint that does not exist yet', () => {
    render(<ActionErrorNotice error={new EndpointUnavailableError('API key rotation')} />);

    expect(screen.getByText('Not available yet')).toBeInTheDocument();
    expect(screen.getByText('API key rotation')).toBeInTheDocument();
  });

  // The backend's wording is written for whoever reads the server logs, so it
  // is mapped to the dashboard's own phrasing rather than passed through.
  test('maps a real failure to dashboard wording instead of the raw message', () => {
    render(<ActionErrorNotice error={new ApiError('Nonce has expired', { status: 400 })} />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(
      screen.getByText('The facilitator rejected that value. Check it and try again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Nonce has expired')).not.toBeInTheDocument();
  });
});
