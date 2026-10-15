import { RESOURCES } from '../api/resources';
import {
  Button,
  Card,
  CardHeader,
  CopyButton,
  StatePanel,
  truncateAddress,
} from '../components/ui/primitives';
import ResourceState from './ResourceState';
import { useResource } from './useResource';

/**
 * The merchant's payment address — the one address their x402 payments are sent
 * to, and the value their own server configuration names as `payTo`.
 *
 * There is exactly one per account and it is identical on every supported
 * network, so this is a value rather than a list, and nothing on screen varies
 * by chain. It is recorded when the merchant signs in and is usable straight
 * away: the vault behind it is created on the first payment, so there is no
 * deployment step to report on and no per-network state to show.
 */

function isAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
}

/**
 * Reads the address out of `GET /account`.
 *
 * That field has two shapes in this repository: the backend stores a single
 * `vaults.address` subdocument, while `backend/src/docs/account.yaml` still
 * documents `vaults` as a list of per-network entries. Both are accepted — the
 * one address is the same on every chain, so either shape carries it.
 *
 * Anything that is not a well-formed address counts as absent. This value is
 * pasted into a server config and used as `payTo`, so a placeholder or a
 * mis-shaped field must never reach the clipboard.
 */
function paymentAddress(account) {
  const vaults = account?.vaults;
  const value = Array.isArray(vaults) ? vaults[0]?.address : vaults?.address;

  return isAddress(value) ? value : null;
}

/**
 * The payment address for the signed-in merchant, ready to drop onto a page.
 *
 * Used by Overview and by API keys, which are the two places a merchant looks
 * for the address they hand to their own customers.
 */
export default function VaultAddress() {
  return <PaymentAddressCard resource={useResource(RESOURCES.account)} />;
}

/**
 * The same card over a resource the caller already holds.
 *
 * The API-keys page reads `GET /account` for its own sake, so it hands that
 * resource down rather than letting this card open a second request for the
 * same document. Both sections then share one load, one error and one retry.
 */
export function PaymentAddressCard({ resource }) {
  return (
    <section className="section" aria-labelledby="payment-address">
      <h2 className="section__label" id="payment-address">
        Payment address
      </h2>

      <ResourceState
        resource={resource}
        label="Payment address"
        loadingTitle="Loading your payment address…"
      >
        {(account) => {
          const address = paymentAddress(account);

          return (
            <Card>
              <CardHeader
                title="Your payment address"
                description="Use this address as the payTo value in your x402 server configuration. It is the same on every supported chain."
              />

              {address ? (
                <>
                  <div className="payment-address">
                    {/* One of the two is shown, by width alone: the full address
                        is what gets checked against a payment, so it is the one
                        given room. */}
                    <code className="payment-address__full">{address}</code>
                    <code className="payment-address__short">{truncateAddress(address)}</code>
                    <CopyButton value={address} label="Copy address" />
                  </div>
                </>
              ) : (
                <>
                  <StatePanel
                    label="No address yet"
                    title="Your payment address is still being set up"
                  >
                    Signing in records an address for your account. This account
                    does not have one yet — try again once it has been set up.
                  </StatePanel>

                  <div className="actions">
                    <Button variant="ghost" onClick={resource.reload}>
                      Retry
                    </Button>
                  </div>
                </>
              )}
            </Card>
          );
        }}
      </ResourceState>
    </section>
  );
}
