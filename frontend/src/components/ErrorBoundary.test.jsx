import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ErrorBoundary } from './ErrorBoundary';

function Bomb({ shouldThrow }) {
  if (shouldThrow) throw new Error('boom');
  return <p>recovered</p>;
}

describe('ErrorBoundary', () => {
  let consoleError;

  beforeEach(() => {
    // React logs every error a boundary catches, and the boundary's own
    // development logger prints alongside it. Both are expected here.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  test('renders the fallback when a child throws', () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('recovered')).not.toBeInTheDocument();
    // Focus is moved to the heading so the fallback is announced in place.
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toHaveFocus();
  });

  // The error is never shown: only the message React prints, which is mocked
  // above. Nothing about the failure reaches the DOM.
  test('never renders the error message to the user', () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );

    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
  });

  test('renders a custom fallback when one is given', () => {
    render(
      <ErrorBoundary fallback={<p>Custom fallback</p>}>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Custom fallback')).toBeInTheDocument();
  });

  test('re-renders the child when Try again is pressed after the cause is fixed', () => {
    const { rerender } = render(
      <ErrorBoundary>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    rerender(
      <ErrorBoundary>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText('recovered')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('clears the error when resetKeys change', () => {
    const { rerender } = render(
      <ErrorBoundary resetKeys={['/dashboard']}>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    rerender(
      <ErrorBoundary resetKeys={['/']}>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    );

    expect(screen.getByText('recovered')).toBeInTheDocument();
  });

  test('keeps the error when resetKeys are unchanged', () => {
    const { rerender } = render(
      <ErrorBoundary resetKeys={['/dashboard']}>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );

    rerender(
      <ErrorBoundary resetKeys={['/dashboard']}>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
