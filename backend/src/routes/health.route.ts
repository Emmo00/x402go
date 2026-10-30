import { Router } from 'express';
import { live, ready } from '../controllers/health.controller';

class HealthRoute implements IAppRoute {
  public path = '/';
  public router = Router();

  constructor() {
    this.router.get('/health', live);
    this.router.get('/health/ready', ready);
  }
}

export default HealthRoute;
