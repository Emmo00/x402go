import { cx } from '../components/ui/primitives';
import { formatAmount, formatBucketLabel } from './format';

/**
 * Payment volume and facilitator fees over time.
 *
 * Rendered as plain DOM bars rather than pulling in a charting library: the
 * design system only needs rectangles, and the bars stay crisp and responsive
 * without a fixed viewBox. Both series share one linear scale, so fee bars are
 * genuinely small next to volume — which is the point.
 */
export default function PaymentActivityChart({ series, className }) {
  const buckets = Array.isArray(series) ? series : [];

  if (buckets.length === 0) {
    return null;
  }

  const max = buckets.reduce(
    (highest, bucket) =>
      Math.max(highest, Number(bucket.volume) || 0, Number(bucket.fees) || 0),
    0,
  );

  const heightFor = (value) => {
    const numeric = Number(value) || 0;
    if (max <= 0) return 0;
    return Math.max((numeric / max) * 100, numeric > 0 ? 1.5 : 0);
  };

  const summary = buckets
    .map(
      (bucket) =>
        `${formatBucketLabel(bucket.label)}: ${formatAmount(bucket.volume)} volume, ${formatAmount(bucket.fees)} fees`,
    )
    .join('; ');

  return (
    <div className={cx('chart', className)}>
      <div className="chart__bars" role="img" aria-label={`Payment activity. ${summary}`}>
        {buckets.map((bucket) => (
          <div className="chart__bucket" key={String(bucket.label)}>
            <div className="chart__columns">
              <div
                className="chart__bar"
                style={{ height: `${heightFor(bucket.volume)}%` }}
                title={`${formatAmount(bucket.volume)} volume`}
              />
              <div
                className="chart__bar chart__bar--fee"
                style={{ height: `${heightFor(bucket.fees)}%` }}
                title={`${formatAmount(bucket.fees)} fees`}
              />
            </div>
            <span className="chart__tick">{formatBucketLabel(bucket.label)}</span>
          </div>
        ))}
      </div>

      <div className="chart__legend">
        <span className="chart__legend-item">
          <span className="chart__swatch" aria-hidden="true" />
          Payment volume
        </span>
        <span className="chart__legend-item">
          <span className="chart__swatch chart__swatch--secondary" aria-hidden="true" />
          Facilitator fees
        </span>
      </div>
    </div>
  );
}
