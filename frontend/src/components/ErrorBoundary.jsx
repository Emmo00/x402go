import { Component, useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

import './ErrorBoundary.css';
import { Button } from './ui/primitives';

/**
 * Catches errors thrown while rendering the tree below it and shows a fallback
 * instead of letting the whole page unmount.
 *
 * Boundaries only see render, lifecycle and constructor errors. Event handlers,
 * async callbacks and rejected promises are outside their reach and report
 * their own failures — see the notes in the dashboard's ResourceState.
 *
 * `resetKeys` clears a caught error when any of them changes, which is how a
 * route change recovers the app without a reload.
 */

function resetKeysChanged(previous, next) {
  if (previous === next) return false;
  if (!Array.isArray(previous) || !Array.isArray(next)) return true;
  return (
    previous.length !== next.length ||
    previous.some((key, index) => !Object.is(key, next[index]))
  );
}

function ErrorFallback({ onReset }) {
  const headingRef = useRef(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="error-state" role="alert">
      <div className="error-state__main">
        <div className="container">
          <div className="error-state__inner">
            <p className="error-state__label">Unexpected error</p>
            <h1 className="error-state__title" ref={headingRef} tabIndex={-1}>
              Something went wrong
            </h1>
            <p className="error-state__body">
              This screen failed to load and could not recover on its own.
            </p>
            <div className="error-state__actions">
              <Button onClick={onReset}>Try again</Button>
              {/* Secondary action, in the outlined ghost style DESIGN.md
                  reserves for it. */}
              <Button variant="ghost" onClick={() => window.location.reload()}>
                Reload page
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, errorInfo) {
    // No error-reporting service is wired into this app, so this is the only
    // sink. It is development-only: production shows the fallback and prints
    // nothing, and the user is never shown the message or the stack.
    if (import.meta.env.DEV) {
      console.error('[x402Go] Render error:', error, errorInfo.componentStack);
    }
  }

  componentDidUpdate(previousProps) {
    if (this.state.error && resetKeysChanged(previousProps.resetKeys, this.props.resetKeys)) {
      this.reset();
    }
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { fallback } = this.props;
    if (typeof fallback === 'function') return fallback({ error, reset: this.reset });
    return fallback ?? <ErrorFallback onReset={this.reset} />;
  }
}

/**
 * The app root's boundary. It sits inside the router so that navigating away
 * from the screen that broke clears the error on its own.
 */
export function AppErrorBoundary({ children }) {
  const { pathname } = useLocation();
  return <ErrorBoundary resetKeys={[pathname]}>{children}</ErrorBoundary>;
}
