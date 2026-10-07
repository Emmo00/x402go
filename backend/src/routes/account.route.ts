import { Router } from 'express';
import AccountController from '../controllers/account.controller';
import requireAuth from '../middlewares/requireAuth.middleware';

class AccountRoute implements IAppRoute {
  public path = '/account';
  public router = Router();
  public accountController: AccountController;

  /** Injectable so a test can mount this route over a stubbed service. */
  constructor(accountController: AccountController = new AccountController()) {
    this.accountController = accountController;
    this.initializeRoutes();
  }

  private initializeRoutes() {
    // Wrapped rather than passed by reference so the handler keeps its `this` —
    // Express invokes a handler as a bare function call, so an unbound method
    // would find `this` undefined the moment it touches its service.
    //
    // The account comes from the session, so there is no path parameter and no
    // way to ask for another merchant's vaults.
    this.router.get(`/`, requireAuth, (req, res, next) =>
      this.accountController.getAccount(req, res, next),
    );
  }
}

export default AccountRoute;
