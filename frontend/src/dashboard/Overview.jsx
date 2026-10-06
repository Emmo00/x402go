import { fetchOverview } from '../api/dashboard';
import { StatCard, StatePanel, StatsGrid } from '../components/ui/primitives';
import { formatAmount } from './format';
import PaymentActivityChart from './PaymentActivityChart';
import ResourceState from './ResourceState';
import TransactionsTable from './TransactionsTable';
import { useResource } from './useResource';

/**
 * Overview — balances, fee totals, payment activity and the transaction feed.
 *
 * Every figure on this screen comes from `fetchOverview`. Until that endpoint
 * exists the page renders an explicit unavailable state rather than zeros or
 * sample values, so the numbers a merchant sees are always real.
 */
export default function Overview() {
  const resource = useResource(fetchOverview);

  return (
    <div className="dash-page">
      <header className="page-head">
        <h1 className="page-head__title">Overview</h1>
        <p className="page-head__desc">
          Track your payments, balance, fees, and usage in one place.
        </p>
      </header>

      <ResourceState
        resource={resource}
        label="Overview"
        loadingTitle="Loading your payments…"
      >
        {(data) => {
          const activity = Array.isArray(data?.activity) ? data.activity : [];
          const transactions = Array.isArray(data?.transactions) ? data.transactions : [];
          const token = data?.token;

          return (
            <>
              <StatsGrid>
                <StatCard
                  label="Available balance"
                  value={formatAmount(data?.availableBalance, { token })}
                  hint="Your current balance available for payout."
                />
                <StatCard
                  label="Total received"
                  value={formatAmount(data?.totalReceived, { token })}
                  hint="The total value of payments processed through x402Go."
                />
                <StatCard
                  label="Total fees"
                  value={formatAmount(data?.totalFees, { token })}
                  hint="The facilitator fees charged across your payments."
                />
                <StatCard
                  label="Transactions"
                  value={Number.isFinite(data?.transactionCount) ? data.transactionCount : '—'}
                  hint="View every payment with its amount, fee, status, token, and timestamp."
                />
              </StatsGrid>

              <section className="section" aria-labelledby="payment-activity">
                <h2 className="section__label" id="payment-activity">
                  Payment activity
                </h2>
                <p className="page-head__desc">
                  Monitor payment volume and revenue over time with clear charts and trends.
                </p>
                {activity.length > 0 ? (
                  <PaymentActivityChart series={activity} />
                ) : (
                  <StatePanel
                    label="No activity"
                    title="No payment activity yet"
                    data-empty="activity"
                  >
                    Volume and revenue trends appear here once your integration
                    has processed its first payments.
                  </StatePanel>
                )}
              </section>

              <section className="section" aria-labelledby="transactions">
                <h2 className="section__label" id="transactions">
                  Transactions
                </h2>
                <TransactionsTable transactions={transactions} />
              </section>
            </>
          );
        }}
      </ResourceState>
    </div>
  );
}
