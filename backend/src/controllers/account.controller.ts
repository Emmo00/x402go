import { NextFunction, Request, Response } from 'express';
import AccountService from '../services/account.service';

/**
 * The account as a client is allowed to see it.
 *
 * Assembled field by field rather than by serialising the user document. That
 * document also carries the sign-in challenge — `authChallenge.nonce` and its
 * expiry — and the API key's hash, neither of which belongs on the wire. The
 * hash is `select: false` and would not be loaded anyway, but a body built here
 * cannot leak it even if that changes.
 *
 * `apiKey` is the part of the key that is safe to show: the suffix kept in the
 * clear, and the dates it was issued and rotated. The plaintext is returned by
 * the routes that issue it and nowhere else, so `null` here means the account
 * holds no key — not that the key is being withheld.
 */
function accountBody(user: IUserDocument) {
  return {
    address: user.address,
    vaults: user.vaults ?? null,
    apiKey: user.apiKey
      ? {
          suffix: user.apiKey.suffix,
          createdAt: user.apiKey.createdAt,
          rotatedAt: user.apiKey.rotatedAt,
        }
      : null,
  };
}

class AccountController {
  private accountService: AccountService;

  /**
   * The service is injectable so a test can supply one whose chain reads are
   * stubbed rather than reaching Celo's public RPC. `getAccount` reads only what
   * sign-in recorded, so it never calls it.
   */
  constructor(accountService: AccountService = new AccountService()) {
    this.accountService = accountService;
  }

  /**
   * `GET /account` — the merchant's identity, their payment address and their
   * API key.
   *
   * Read-only and cheap on the database: the vault address is recorded at
   * sign-in, so this reads one document and reports it. It never deploys
   * anything — a merchant opening their dashboard is not an instruction to
   * spend gas.
   *
   * The key is described here so a dashboard can show which key is in force
   * without a second request; there is no `GET /api-keys` and no need for one.
   */
  async getAccount(req: Request, res: Response, next: NextFunction) {
    const user = req.user;

    return res.status(200).json(accountBody(user as IUserDocument));
  }
}

export default AccountController;
