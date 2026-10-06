/** Formatting helpers shared by the dashboard screens. */

/**
 * Formats a token amount for display. Amounts arrive as decimal strings so no
 * precision is lost; anything unparseable falls back to the raw value rather
 * than rendering "NaN".
 */
export function formatAmount(value, { token, maximumFractionDigits = 6, symbol } = {}) {
  if (value === null || value === undefined || value === '') return '—';

  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return String(value);

  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(numeric);

  const unit = symbol ?? token;
  return unit ? `${formatted} ${unit}` : formatted;
}

/** Formats an ISO timestamp, or returns the raw value if it cannot be parsed. */
export function formatTimestamp(value) {
  if (!value) return '—';

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** Short axis label, e.g. "05 Oct". */
export function formatBucketLabel(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value ?? '');

  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(date);
}

/** Payment statuses as they appear on a settlement record. */
export const PAYMENT_STATUS = {
  settled: { label: 'Settled', tone: 'active' },
  pending: { label: 'Pending', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'error' },
};

export function describeStatus(status) {
  if (!status) return { label: 'Unknown', tone: 'neutral' };
  return (
    PAYMENT_STATUS[String(status).toLowerCase()] ?? {
      label: String(status),
      tone: 'neutral',
    }
  );
}
