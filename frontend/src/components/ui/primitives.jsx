import { useCallback, useEffect, useId, useRef, useState } from 'react';
import './ui.css';

/**
 * Design-system primitives for the dashboard.
 *
 * These are presentation only — no wallet or API logic lives here, so they stay
 * reusable and testable on their own.
 */

export function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

export const buttonClass = (variant = 'primary', className) =>
  cx('btn', `btn--${variant}`, className);

/* -------------------------------------------------------------------------- */
/* Button                                                                     */
/* -------------------------------------------------------------------------- */

export function Button({ variant = 'primary', className, type = 'button', ...rest }) {
  return <button type={type} className={buttonClass(variant, className)} {...rest} />;
}

/* -------------------------------------------------------------------------- */
/* Card                                                                       */
/* -------------------------------------------------------------------------- */

export function Card({ as: Tag = 'section', className, children, ...rest }) {
  return (
    <Tag className={cx('card', className)} {...rest}>
      {children}
    </Tag>
  );
}

export function CardHeader({ title, description, action, titleId }) {
  return (
    <header className="card__header">
      <div className="card__heading">
        <h3 className="card__title" id={titleId}>
          {title}
        </h3>
        {description ? <p className="card__desc">{description}</p> : null}
      </div>
      {action ? <div className="card__action">{action}</div> : null}
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* Stats                                                                      */
/* -------------------------------------------------------------------------- */

export function StatsGrid({ children }) {
  return <div className="stats">{children}</div>;
}

export function StatCard({ label, value, hint, muted = false }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className={cx('stat__value', muted && 'stat__value--muted')}>{value}</span>
      {hint ? <span className="stat__hint">{hint}</span> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Badge                                                                      */
/* -------------------------------------------------------------------------- */

export function Badge({ tone = 'active', children }) {
  return (
    <span className={cx('badge', tone !== 'active' && `badge--${tone}`)}>{children}</span>
  );
}

/* -------------------------------------------------------------------------- */
/* Notice                                                                     */
/* -------------------------------------------------------------------------- */

export function Notice({ title, tone = 'neutral', children }) {
  return (
    <div className={cx('notice', tone !== 'neutral' && `notice--${tone}`)}>
      <div className="notice__body">
        {title ? <p className="notice__title">{title}</p> : null}
        {children ? <div className="notice__text">{children}</div> : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* State panel — loading, empty, error, and not-yet-available                 */
/* -------------------------------------------------------------------------- */

export function StatePanel({ label, title, tone = 'neutral', busy = false, children }) {
  return (
    <div
      className={cx('state', tone !== 'neutral' && `state--${tone}`)}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {label ? (
        <p className={cx('state__label', busy && 'state__label--busy')}>{label}</p>
      ) : null}
      {title ? <p className="state__title">{title}</p> : null}
      {children ? <div className="state__text">{children}</div> : null}
    </div>
  );
}

export function LoadingState({ label = 'Loading', title = 'Fetching data…' }) {
  return <StatePanel label={label} title={title} busy />;
}

/* -------------------------------------------------------------------------- */
/* Field                                                                      */
/* -------------------------------------------------------------------------- */

export function Field({ id, label, hint, error, className, ...rest }) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  return (
    <div className={cx('field', className)}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="field__input"
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={cx(errorId, hintId) || undefined}
        {...rest}
      />
      {hint ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field__error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Copy to clipboard                                                          */
/* -------------------------------------------------------------------------- */

async function writeToClipboard(value) {
  // The async Clipboard API needs a secure context; fall back to a hidden
  // textarea so copying still works over plain http during local development.
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(area);
  }
}

export function CopyButton({ value, label = 'Copy', className, ariaLabel }) {
  const [state, setState] = useState('idle');
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async () => {
    try {
      await writeToClipboard(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2000);
  }, [value]);

  return (
    <>
      <Button
        variant="ghost"
        className={className}
        onClick={copy}
        disabled={!value}
        // A page with a dozen code samples has a dozen of these, and "Copy to
        // clipboard" twelve times tells a screen-reader user nothing about
        // which one they are on. `ariaLabel` names the sample; the visible
        // label stays short because the button sits in a labelled block.
        aria-label={ariaLabel ?? `${label} to clipboard`}
      >
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
      </Button>
      {/* Announced to assistive tech without shifting the button label. */}
      <span className="visually-hidden" role="status">
        {state === 'copied' ? 'Copied to clipboard' : ''}
      </span>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Address                                                                    */
/* -------------------------------------------------------------------------- */

export function truncateAddress(value) {
  if (typeof value !== 'string' || value.length <= 14) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function Address({ value, full = false }) {
  if (!value) return <span className="address">—</span>;
  return (
    <span className="address" title={value}>
      {full ? value : truncateAddress(value)}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Secret                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A monospace value with a copy action beside it.
 *
 * For anything a user has to transcribe exactly — a key, an address — where
 * selecting the text by hand is both fiddly and easy to get wrong. The value is
 * shown in full rather than truncated: this is the row that exists so it can be
 * copied, and a truncated value cannot be checked against anything.
 */
export function CopyableValue({ value, copyLabel = 'Copy' }) {
  return (
    <div className="secret">
      <code>{value}</code>
      <CopyButton value={value} label={copyLabel} />
    </div>
  );
}

export function SecretValue({ value, copyLabel = 'Copy' }) {
  return <CopyableValue value={value} copyLabel={copyLabel} />;
}

/* -------------------------------------------------------------------------- */
/* Dialog                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A modal confirmation step.
 *
 * Reserved for actions that cannot be undone by trying again — rotating a key
 * invalidates the old one the moment the server accepts it, so the decision is
 * taken deliberately rather than by a stray click on an inline button.
 *
 * Escape and the backdrop are disabled while the action is in flight: once the
 * request is away, abandoning the dialog would leave the user unsure whether
 * the key had already been replaced.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  pendingLabel,
  pending = false,
  onConfirm,
  onCancel,
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef(null);
  const restoreRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    // Remember where focus was so it can be handed back on close; otherwise it
    // lands on <body> and a keyboard user loses their place.
    restoreRef.current = document.activeElement;
    panelRef.current?.focus();

    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || pending) return;
      event.stopPropagation();
      onCancel?.();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (restoreRef.current instanceof HTMLElement) restoreRef.current.focus();
    };
  }, [open, pending, onCancel]);

  if (!open) return null;

  return (
    <div
      className="dialog"
      // The backdrop dismisses, but only when there is nothing in flight.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel?.();
      }}
    >
      <div
        className="dialog__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        ref={panelRef}
        tabIndex={-1}
      >
        <h3 className="dialog__title" id={titleId}>
          {title}
        </h3>
        {description ? (
          <p className="dialog__text" id={descriptionId}>
            {description}
          </p>
        ) : null}
        <div className="dialog__actions">
          <Button onClick={onConfirm} disabled={pending} aria-busy={pending || undefined}>
            {pending ? (pendingLabel ?? `${confirmLabel}…`) : confirmLabel}
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
