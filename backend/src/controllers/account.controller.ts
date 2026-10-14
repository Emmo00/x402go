import { NextFunction, Request, Response } from 'express';
import AccountService from '../services/account.service';

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

    return res.status(200).json(user);
  }
}

export default AccountController;
