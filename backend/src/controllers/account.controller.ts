import { NextFunction, Request, Response } from 'express';
import AccountService, { AccountOutcome, AccountView } from '../services/account.service';

/**
 * The authenticated merchant's account.
 *
 * `GET /account` is where the dashboard learns who it is looking at and where
 * that merchant's vaults are. The account is taken from the session and never
 * from the request, so there is no identifier to pass and no way to address
 * another merchant.
 */

/** The response body, assembled field by field rather than spread from the service. */
function accountBody(account: AccountView) {
  return {
    address: account.address,
    vaults: account.vaults.map((vault) => ({
      network: vault.network,
      networkName: vault.networkName,
      chainId: vault.chainId,
      address: vault.address,
      deployed: vault.deployed,
      explorerUrl: vault.explorerUrl,
    })),
  };
}

class AccountController {
  private accountService: AccountService;

  /**
   * The service is injectable so a test can supply one whose chain reads are
   * stubbed. `GET /account` is the only route in the backend that touches a
   * node, and without this a test of it would be a test of Celo's public RPC.
   */
  constructor(accountService: AccountService = new AccountService()) {
    this.accountService = accountService;
  }

  /**
   * `GET /account` — the merchant's identity and their vault addresses.
   *
   * Read-only and cheap on the database: the vault addresses are recorded at
   * sign-in, so this reads one document and asks each chain whether a contract
   * exists at the address on record. It never deploys anything — a merchant
   * opening their dashboard is not an instruction to spend gas.
   */
  async getAccount(req: Request, res: Response, next: NextFunction) {
    const user = req.user;

    if (!user) {
      // `requireAuth` has already run and guarantees a user; this only covers a
      // route being mounted without it.
      return res.status(401).json({ message: 'Authentication required' });
    }

    const outcome: AccountOutcome = await this.accountService.getAccount(String(user._id));

    if (outcome.status === 'no-account') {
      return res.status(404).json({ message: 'Account not found' });
    }

    return res.status(200).json(accountBody(outcome.account));
  }
}

export default AccountController;
