import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { auth, api } = vi.hoisted(() => ({ auth: { current: null }, api: {} }));

vi.mock('../auth/AuthContext', () => ({
  AuthStatus: {
    DISCONNECTED: 'disconnected',
    UNAUTHENTICATED: 'unauthenticated',
    AWAITING_SIGNATURE: 'awaiting_signature',
    VERIFYING: 'verifying',
    AUTHENTICATED: 'authenticated',
    EXPIRED: 'expired',
  },
  useAuth: () => auth.current,
}));

vi.mock('../api/dashboard', () => ({
  fetchOverview: (...args) => api.fetchOverview(...args),
  fetchAccount: (...args) => api.fetchAccount(...args),
  fetchPayoutAddress: (...args) => api.fetchPayoutAddress(...args),
  updatePayoutAddress: (...args) => api.updatePayoutAddress(...args),
  createApiKey: (...args) => api.createApiKey(...args),
  rotateApiKey: (...args) => api.rotateApiKey(...args),
  fetchApiKey: (...args) => api.fetchApiKey(...args),
}));

import { ApiError, EndpointUnavailableError } from '../api/client';
import ApiKeys from './ApiKeys';
import Overview from './Overview';
import VaultAddresses from './VaultAddress';

/**
 * One real derivation vector, from the backend's own fixtures: this merchant
 * derives this vault on Celo Mainnet. The dashboard never computes it — it
 * renders whatever `GET /account` returns — but a test that used an obvious
 * placeholder like `0x1111…` would not catch a row that rendered the wrong
 * account's address.
 */
const MERCHANT = '0xc0b0e77000aa0826b7db9d1fe3760d26559643bb';
const CELO_VAULT = '0x59f3d0c53bc46a35a81e478b080cc8afa2fc88de';

/**
 * Both real networks derive the *same* address, because the factory and the
 * implementation are deployed at one address on each. So a fixture that only
 * ever used the true addresses could not tell a row-per-network list apart from
 * a list that rendered one address for both. This second address is invented
 * for exactly that reason, and the test that uses it says so.
 */
const SEPOLIA_VAULT = '0x6b600bec988ac955f15e9008b063a5b09a726468';

const VAULT = {
  network: 'celo',
  networkName: 'Celo Mainnet',
  chainId: 42220,
  address: CELO_VAULT,
  deployed: false,
  explorerUrl: `https://celoscan.io/address/${CELO_VAULT}`,
};

const SEPOLIA = {
  network: 'celoSepolia',
  networkName: 'Celo Sepolia',
  chainId: 11142220,
  address: SEPOLIA_VAULT,
  deployed: false,
  explorerUrl: `https://celo-sepolia.blockscout.com/address/${SEPOLIA_VAULT}`,
};

function setAuth(overrides) {
  auth.current = {
    status: 'authenticated',
    address: MERCHANT,
    notifyUnauthorized: vi.fn(),
    ...overrides,
  };
  return auth.current;
}

const account = (...vaults) => ({ address: MERCHANT, vaults });

/** The rows actually rendered, in document order. */
function rows(container) {
  return [...container.querySelectorAll('[data-network]')];
}

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  auth.current = null;
  api.fetchAccount = vi.fn().mockResolvedValue(account(VAULT));
  // Overview's own figures have no endpoint yet; the vault address is the one
  // thing on that page that is real. Mocking it faithfully keeps the page in
  // the state a merchant actually sees.
  api.fetchOverview = vi.fn().mockRejectedValue(new EndpointUnavailableError('merchant overview'));
  api.fetchPayoutAddress = vi.fn();
  api.updatePayoutAddress = vi.fn();
  api.fetchApiKey = vi.fn().mockResolvedValue(null);
  api.createApiKey = vi.fn();
  api.rotateApiKey = vi.fn();
  setAuth();

  writeText.mockClear();
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  Object.defineProperty(window, 'isSecureContext', {
    value: true,
    configurable: true,
  });
});

describe('VaultAddresses', () => {
  test('shows the merchant the address their customers pay', async () => {
    render(<VaultAddresses />);

    // The whole address, not truncation: this is the row that exists so it can
    // be checked against and copied.
    expect(await screen.findByText(CELO_VAULT)).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: 'Your x402Go vault' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/used as your payTo address/)).toBeInTheDocument();
  });

  test('shows one row per network, each with its own name and chain id', async () => {
    api.fetchAccount = vi.fn().mockResolvedValue(account(VAULT, SEPOLIA));

    const { container } = render(<VaultAddresses />);
    await screen.findByText(CELO_VAULT);

    const list = rows(container);
    expect(list).toHaveLength(2);
    expect(list[0]).toHaveAttribute('data-network', 'celo');
    expect(list[1]).toHaveAttribute('data-network', 'celoSepolia');

    // Each address sits under its own network's heading, so the two are never
    // interchangeable — a merchant paying on Sepolia must not be handed the
    // mainnet address.
    expect(list[0]).toHaveTextContent('Celo Mainnet');
    expect(list[0]).toHaveTextContent('Chain 42220');
    expect(list[0]).toHaveTextContent(CELO_VAULT);
    expect(list[0]).not.toHaveTextContent(SEPOLIA_VAULT);

    expect(list[1]).toHaveTextContent('Celo Sepolia');
    expect(list[1]).toHaveTextContent('Chain 11142220');
    expect(list[1]).toHaveTextContent(SEPOLIA_VAULT);
    expect(list[1]).not.toHaveTextContent(CELO_VAULT);
  });

  test('copies the address to the clipboard', async () => {
    render(<VaultAddresses />);
    await screen.findByText(CELO_VAULT);

    fireEvent.click(screen.getByRole('button', { name: 'Copy address to clipboard' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CELO_VAULT));
    // And says so, so a click that silently did nothing is not mistaken for one
    // that worked.
    expect(await screen.findByRole('button', { name: 'Copy address to clipboard' })).toHaveTextContent(
      'Copied',
    );
  });

  test('does not say the vault is deployed when it is not', async () => {
    render(<VaultAddresses />);
    await screen.findByText(CELO_VAULT);

    expect(screen.getByText('Not deployed yet')).toBeInTheDocument();
    expect(screen.queryByText('Deployed')).not.toBeInTheDocument();

    // The address is final anyway, and the copy has to say so — otherwise a
    // merchant reads "not deployed" as "this address may still change".
    expect(screen.getByText(/already final/)).toBeInTheDocument();
    expect(screen.getByText(/deploying the vault will not change it/)).toBeInTheDocument();
  });

  test('offers the block explorer only once there is something to look at', async () => {
    const { unmount } = render(<VaultAddresses />);
    await screen.findByText(CELO_VAULT);

    expect(screen.queryByRole('link', { name: /block explorer/i })).not.toBeInTheDocument();
    unmount();

    api.fetchAccount = vi.fn().mockResolvedValue(account({ ...VAULT, deployed: true }));
    render(<VaultAddresses />);
    await screen.findByText(CELO_VAULT);

    expect(screen.getByText('Deployed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /block explorer/i })).toHaveAttribute(
      'href',
      VAULT.explorerUrl,
    );
  });

  // `null` is the backend saying it could not reach the chain. Rendering that
  // as "not deployed" would assert something about the vault that nobody
  // established, and the merchant would go looking for a deployment that may
  // already be there.
  test('keeps an unreachable chain distinct from an undeployed vault', async () => {
    api.fetchAccount = vi.fn().mockResolvedValue(account({ ...VAULT, deployed: null }));

    render(<VaultAddresses />);

    expect(await screen.findByText('Status unknown')).toBeInTheDocument();
    expect(screen.queryByText('Not deployed yet')).not.toBeInTheDocument();
    expect(screen.queryByText('Deployed')).not.toBeInTheDocument();
    expect(screen.getByText(/could not be reached/)).toBeInTheDocument();
    // The address does not depend on the chain, so it is still served in full.
    expect(screen.getByText(CELO_VAULT)).toBeInTheDocument();
  });

  test('treats a body without a deployment field as unknown, not as deployed', async () => {
    api.fetchAccount = vi.fn().mockResolvedValue(account({ ...VAULT, deployed: undefined }));

    render(<VaultAddresses />);

    expect(await screen.findByText('Status unknown')).toBeInTheDocument();
  });

  test('offers nothing rather than a blank address when the account has none', async () => {
    api.fetchAccount = vi.fn().mockResolvedValue(account());

    const { container } = render(<VaultAddresses />);

    expect(await screen.findByText('No vault address yet')).toBeInTheDocument();
    expect(rows(container)).toHaveLength(0);
  });

  test('hands an expired session back to sign-in', async () => {
    const state = setAuth();
    api.fetchAccount = vi
      .fn()
      .mockRejectedValue(new ApiError('Authentication required', { status: 401 }));

    render(<VaultAddresses />);

    await waitFor(() => expect(state.notifyUnauthorized).toHaveBeenCalledOnce());
    expect(await screen.findByText('Could not load this data')).toBeInTheDocument();
  });
});

describe('the pages that render it', () => {
  // Overview has no figures to show yet, and the vault address is the one thing
  // on it that is real — so it leads the page rather than sitting below a panel
  // saying the rest is not built.
  test('Overview leads with the vault address', async () => {
    render(<Overview />);

    const heading = await screen.findByRole('heading', { level: 2, name: 'Vault' });
    expect(screen.getByText(CELO_VAULT)).toBeInTheDocument();

    const unavailable = screen.getByText('Not available yet');
    expect(
      heading.compareDocumentPosition(unavailable) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // On the API-keys page the address goes last: a key is disclosed exactly once
  // by create or rotate, and nothing may sit between that action and the value
  // it reveals.
  test('API keys shows the vault address below the key it manages', async () => {
    api.fetchApiKey = vi.fn().mockResolvedValue({
      suffix: 'a91f',
      maskedKey: '••••••••••••a91f',
      createdAt: '2026-10-05T09:41:07.412Z',
    });

    render(<ApiKeys />);

    const heading = await screen.findByRole('heading', { level: 2, name: 'Vault' });
    const rotate = screen.getByRole('button', { name: 'Rotate API key' });

    expect(screen.getByText(CELO_VAULT)).toBeInTheDocument();
    expect(
      rotate.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
