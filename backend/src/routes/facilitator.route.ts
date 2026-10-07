import { Router } from 'express';

import FacilitatorController from '../controllers/facilitator.controller';
import apiKeyAuth from '../middlewares/apiKeyAuth.middleware';

/**
 * The three x402 endpoints, at the root of the API.
 *
 * They are mounted at `/` rather than under a `/facilitator` prefix because
 * these are the URLs an x402 client is configured with — the same paths the
 * Celo facilitator serves — and a proxy that made callers learn a different
 * path would not be a drop-in one. `facilitatorUrl` in the chain configuration
 * is the only URL that should differ between Celo and x402Go.
 *
 * `/supported` is open. `/verify` and `/settle` are behind `apiKeyAuth`, which
 * is what identifies the merchant: the key is the merchant, so there is no
 * merchant identifier in any request body and none is needed.
 */
class FacilitatorRoute implements IAppRoute {
  public path = '/';
  public router = Router();
  public facilitatorController: FacilitatorController;

  constructor(facilitatorController: FacilitatorController = new FacilitatorController()) {
    this.facilitatorController = facilitatorController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    // Public: it is Celo's capability list, it holds nothing about a merchant,
    // and a client needs it before it has a key to present.
    this.router.get(`/supported`, (req, res, next) =>
      this.facilitatorController.getSupported(req, res, next),
    );

    // Authenticated. Wrapped rather than passed by reference so `this` still
    // refers to the controller inside the handler.
    this.router.post(`/verify`, apiKeyAuth, (req, res, next) =>
      this.facilitatorController.postVerify(req, res, next),
    );

    this.router.post(`/settle`, apiKeyAuth, (req, res, next) =>
      this.facilitatorController.postSettle(req, res, next),
    );
  }
}

export default FacilitatorRoute;
