import { Badge, StatePanel } from '../components/ui/primitives';
import { describeStatus, formatAmount, formatTimestamp } from './format';

/**
 * Every payment processed for the merchant: amount, fee, status, token and
 * timestamp. Scrolls horizontally rather than squashing columns on narrow
 * screens, so the numbers stay readable.
 */
export default function TransactionsTable({ transactions }) {
  const rows = Array.isArray(transactions) ? transactions : [];

  if (rows.length === 0) {
    return (
      <StatePanel
        label="No transactions"
        title="No payments yet"
        data-empty="transactions"
      >
        Payments processed through x402Go will appear here as soon as your
        integration starts settling them.
      </StatePanel>
    );
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="visually-hidden">
          Payments processed through x402Go
        </caption>
        <thead>
          <tr>
            <th scope="col">Amount</th>
            <th scope="col">Fee</th>
            <th scope="col">Status</th>
            <th scope="col">Token</th>
            <th scope="col">Timestamp</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((transaction, index) => {
            const status = describeStatus(transaction.status);

            return (
              <tr key={transaction.id ?? `${transaction.timestamp}-${index}`}>
                <td className="table__numeric">
                  {formatAmount(transaction.amount, { token: transaction.token })}
                </td>
                <td className="table__numeric">
                  {formatAmount(transaction.fee, { token: transaction.token })}
                </td>
                <td>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </td>
                <td>{transaction.token ?? '—'}</td>
                <td className="table__numeric">{formatTimestamp(transaction.timestamp)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
