import { Router } from 'express';
import AuthController from '../controllers/auth.controller';

class AuthRoute implements IAppRoute {
  public path = '/auth';
  public router = Router();
  public authController = new AuthController();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes() {
    // Wrapped rather than passed by reference: Express calls a handler as a
    // bare function, so an unbound controller method loses its `this` and
    // throws the first time it reaches for its service.
    this.router.get(`/nonce`, (req, res, next) =>
      this.authController.getNonce(req, res, next),
    );
    this.router.post(`/verify`, (req, res, next) =>
      this.authController.verifySignature(req, res, next),
    );
    this.router.post(`/logout`, (req, res, next) =>
      this.authController.logout(req, res, next),
    );
  }
}

export default AuthRoute;
