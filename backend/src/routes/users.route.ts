import { Router } from 'express';
import UsersController from '../controllers/users.controller';

class UsersRoute implements IAppRoute {
  public path = '/users';
  public router = Router();
  public usersController = new UsersController();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes() {}
}

export default UsersRoute;
