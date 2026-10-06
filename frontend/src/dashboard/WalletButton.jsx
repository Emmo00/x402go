import { ConnectButton } from '@rainbow-me/rainbowkit';
import { Badge, Button, cx, truncateAddress } from '../components/ui/primitives';

/**
 * The wallet connection control.
 *
 * RainbowKit's default button is a rounded pill, which fights the 1px-radius,
 * monospace-label system in DESIGN.md. `ConnectButton.Custom` lets the same
 * wagmi state drive our own `.btn` markup, so the control is indistinguishable
 * from the rest of the interface while RainbowKit still owns the connect modal.
 */
export default function WalletButton({ className }) {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
        // `mounted` is false during the first render so the server and client
        // markup agree; RainbowKit requires we render nothing until it flips.
        const ready = mounted;
        const connected = ready && account && chain;

        return (
          <div
            className={cx('wallet-button', className)}
            {...(!ready && {
              'aria-hidden': true,
              style: { opacity: 0, pointerEvents: 'none', userSelect: 'none' },
            })}
          >
            {!connected ? (
              <Button onClick={openConnectModal}>
                {ready ? 'Connect wallet' : 'Connect'}
              </Button>
            ) : (
              <div className="wallet-button__connected">
                {chain.unsupported ? (
                  <Button variant="ghost" onClick={openChainModal}>
                    Wrong network
                  </Button>
                ) : (
                  <button
                    type="button"
                    className="wallet-button__chain"
                    onClick={openChainModal}
                    aria-label={`Network: ${chain.name}. Change network`}
                  >
                    <Badge tone="neutral">{chain.name}</Badge>
                  </button>
                )}
                <button
                  type="button"
                  className="wallet-button__account"
                  onClick={openAccountModal}
                  aria-label={`Account ${account.address}. Open account menu`}
                >
                  {truncateAddress(account.address)}
                  {account.displayName && account.displayName !== account.address ? (
                    <span className="wallet-button__alias">{account.displayName}</span>
                  ) : null}
                </button>
              </div>
            )}
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}
