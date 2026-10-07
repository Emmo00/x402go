import { fetchAccount } from '../api/dashboard';
import { Badge, Card, CardHeader, CopyableValue, StatePanel } from '../components/ui/primitives';
import ResourceState from './ResourceState';
import { useResource } from './useResource';

/**
 * The merchant's vault addresses, one row per network.
 *
 * This is the address an x402 challenge names as `payTo`, so it is the single
 * most load-bearing thing the dashboard has to get right. Two properties of it
 * drive everything below.
 *
 * It exists before the vault does. The address is derived from the merchant's
 * wallet and the deployed factory, so it is final the moment it is computed and
 * deploying the vault does not move it. The page therefore shows it for an
 * account that has never taken a payment, which is the normal state.
 *
 * Being final is not the same as being deployed. A merchant reading "your
 * vault" and assuming funds can already land there would be wrong, and a
 * customer paying the address would only find out when the transfer went
 * nowhere useful. So the deployment state is carried as a separate, plainly
 * worded fact beside the address, read from the chain rather than inferred from
 * the address being present — every address here is present, and most are not
 * deployed.
 */

/**
 * What to say about each deployment state.
 *
 * `deployed` has three values, and the third is the one worth keeping distinct:
 * `null` means the backend could not reach the chain, which is not the same
 * claim as `false`. Reporting an unreachable node as "not deployed" would state
 * a fact about the vault that nobody established.
 *
 * Only `true` is treated as an active state, which is what the design system's
 * green is reserved for. The other two are neutral: neither is a failure, and
 * neither makes the address less correct.
 */
const DEPLOYMENT = {
  true: {
    label: 'Deployed',
    tone: 'active',
    note: 'A vault is deployed at this address and can receive payments.',
  },
  false: {
    label: 'Not deployed yet',
    tone: 'neutral',
    note: 'Your vault has not been deployed yet. This address is already final — it follows from your wallet address, and deploying the vault will not change it.',
  },
  null: {
    label: 'Status unknown',
    tone: 'neutral',
    note: 'The network could not be reached, so whether a vault is deployed here is unknown. Your address is unaffected.',
  },
};

function deploymentOf(value) {
  if (value === true) return DEPLOYMENT.true;
  if (value === false) return DEPLOYMENT.false;

  // Anything that is not a definite `true` or `false` — including a missing
  // field from a body that did not match the specification — is unknown.
  return DEPLOYMENT.null;
}

function VaultRow({ vault }) {
  const deployment = deploymentOf(vault?.deployed);

  return (
    <li className="vault" data-network={vault?.network}>
      <div className="vault__head">
        <span className="vault__network">{vault?.networkName ?? vault?.network}</span>
        {Number.isFinite(vault?.chainId) ? (
          <span className="vault__chain">Chain {vault.chainId}</span>
        ) : null}
        <Badge tone={deployment.tone}>{deployment.label}</Badge>
      </div>

      <CopyableValue value={vault?.address} copyLabel="Copy address" />

      <p className="vault__note">{deployment.note}</p>

      {/* Only worth offering once there is something at the address to look at. */}
      {vault?.deployed === true && vault?.explorerUrl ? (
        <a
          className="vault__explorer"
          href={vault.explorerUrl}
          target="_blank"
          rel="noreferrer"
        >
          View on the block explorer
        </a>
      ) : null}
    </li>
  );
}

function VaultList({ account }) {
  const vaults = Array.isArray(account?.vaults)
    ? account.vaults.filter((vault) => typeof vault?.address === 'string' && vault.address)
    : [];

  if (vaults.length === 0) {
    return (
      <StatePanel
        label="No vault address"
        title="No vault address yet"
        data-empty="vault"
      >
        This account has no vault address recorded. Signing in records one for
        every supported network.
      </StatePanel>
    );
  }

  return (
    <ul className="vault-list">
      {vaults.map((vault) => (
        <VaultRow key={vault.network ?? vault.address} vault={vault} />
      ))}
    </ul>
  );
}

/**
 * The vault addresses for the signed-in merchant, ready to drop onto a page.
 *
 * Used by Overview and by API keys, which are the two places a merchant looks
 * for the address they hand to their own customers.
 */
export default function VaultAddresses() {
  const resource = useResource(fetchAccount);

  return (
    <section className="section" aria-labelledby="vault-addresses">
      <h2 className="section__label" id="vault-addresses">
        Vault
      </h2>

      <ResourceState
        resource={resource}
        label="Vault address"
        loadingTitle="Loading your vault address…"
      >
        {(account) => (
          <Card>
            <CardHeader
              title="Your x402Go vault"
              description="This is the address used as your payTo address for x402 payments. It is derived from your wallet address, so it is the same on every visit."
            />
            <VaultList account={account} />
          </Card>
        )}
      </ResourceState>
    </section>
  );
}
