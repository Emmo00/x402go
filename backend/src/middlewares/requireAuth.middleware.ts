import { Request, Response, NextFunction } from 'express';
import UserService from '../services/users.service';

/**
 * Gates a route on the SIWE session cookie.
 *
 * Express invokes ordinary middleware with `(req, res, next)` — only the
 * terminal error handler takes a leading `error` argument. This previously
 * declared four parameters, which meant Express handed it `req` as `error` and
 * left `next` undefined, so it could never have run a route.
 */
async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const userId = req.session.userId;

  if (!userId) {
    return res.status(401).json({
      message: 'Authentication required',
    });
  }

  const user = await new UserService().findUserById(userId);

  if (!user) {
    return res.status(401).json({
      message: 'Authentication required',
    });
  }

  req.user = user;

  next();
}

export default requireAuth;
