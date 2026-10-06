import { NextFunction, Request, Response } from 'express';
import userService from '../services/users.service';

class UsersController {
  public userService = new userService();
}

export default UsersController;
