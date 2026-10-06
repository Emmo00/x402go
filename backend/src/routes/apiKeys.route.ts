import { Router } from 'express';
import ApiKeysController from '../controllers/apiKeys.controller';
import requireAuth from '../middlewares/requireAuth.middleware';

class ApiKeysRoute implements IAppRoute {
  public path = '/api-keys';
  public router = Router();
  public apiKeysController = new ApiKeysController();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes() {
    // Handlers are wrapped rather than passed by reference so they keep their
    // `this`. Express invokes a handler as a bare function call, so an unbound
    // method would find `this` undefined the moment it touches its service.
    //
    // Both routes are gated on the same session middleware the rest of the API
    // uses — the account is taken from the authenticated session, never from
    // the request body, so a caller cannot ask for someone else's key.
    this.router.post(`/`, requireAuth, (req, res, next) =>
      this.apiKeysController.createApiKey(req, res, next),
    );
    this.router.post(`/rotate`, requireAuth, (req, res, next) =>
      this.apiKeysController.rotateApiKey(req, res, next),
    );
  }
}

export default ApiKeysRoute;
