import { Router } from 'express';
import PayoutController from '../controllers/payout.controller';
import requireAuth from '../middlewares/requireAuth.middleware';

class PayoutRoute implements IAppRoute {
  public path = '/payout';
  public router = Router();
  public payoutController = new PayoutController();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes() {
    // Handlers are wrapped rather than passed by reference so they keep their
    // `this` — Express invokes a handler as a bare function call, so an unbound
    // method would find `this` undefined the moment it touches its service.
    //
    // Both verbs sit behind the same session middleware as the rest of the API.
    // The account is taken from the session, never from the request body, so a
    // caller cannot read or write another account's payout address.
    this.router.get(`/`, requireAuth, (req, res, next) =>
      this.payoutController.getPayout(req, res, next),
    );
    this.router.put(`/`, requireAuth, (req, res, next) =>
      this.payoutController.setPayout(req, res, next),
    );
  }
}

export default PayoutRoute;
