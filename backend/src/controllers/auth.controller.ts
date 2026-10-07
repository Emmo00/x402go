import { NextFunction, Request, Response } from 'express';
import { generateNonce, SiweMessage } from 'siwe';
import AccountService from '../services/account.service';
import UserService from '../services/users.service';

class AuthController {
  private userService = new UserService();
  private accountService = new AccountService();

  async getNonce(req: Request, res: Response, next: NextFunction) {
    const address = req.query.address as string;
    const nonce = generateNonce();
    const expiredAt = new Date(Date.now() + 10 * 60 * 1000); // Set expiration time to 10 minutes from now

    await this.userService.findAndUpdateNonce(address, nonce, expiredAt);

    res.json({ nonce });
  }

  async verifySignature(req: Request, res: Response, next: NextFunction) {
    const { address, message, signature } = req.body;

    const authData = await this.userService.findUserNonce(address);

    if (!authData || !authData.nonce || !authData.expiredAt || authData.used) {
      return res
        .status(400)
        .json({ success: false, error: 'Nonce not found for the given address' });
    }

    if (Date.now() > authData.expiredAt.getTime()) {
      return res.status(400).json({ success: false, error: 'Nonce has expired' });
    }

    let siweObject = new SiweMessage(message);

    siweObject.verify({ signature, nonce: authData.nonce }).then(async (result) => {
      if (result.success) {
        // Mark the nonce as used
        await this.userService.markNonceAsUsed(address);

        const user = (await this.userService.findUserByAddress(address)) as IUserDocument;
        const userId = user?._id.toString();

        req.session.userId = userId; // Store the user's ID in the session

        // Record the merchant's deterministic vault address on every supported
        // chain, so the dashboard can show it without deriving it per request.
        //
        // The address is a pure function of the merchant and the factory, so
        // this needs no chain access and deploys nothing — a vault is created
        // when an operation needs one, not because someone signed in.
        //
        // It is deliberately not allowed to fail the sign-in. The merchant is
        // already authenticated by this point, and a dashboard that has not yet
        // recorded a vault address is a recoverable state — the next read
        // derives it — whereas a 500 here would lock a valid user out.
        if (userId) {
          try {
            await this.accountService.ensureVaults(userId, address);
          } catch (error) {
            console.error('[auth] could not record vault addresses at sign-in', error);
          }
        }

        res.json({ success: true });
      } else {
        res.status(401).json({ success: false, error: 'Invalid signature' });
      }
    });
  }

  async logout(req: Request, res: Response, next: NextFunction) {
    req.session.destroy((err) => {
      if (err) {
        return next(err);
      }
      res.clearCookie('connect.sid'); // Clear the session cookie
      res.json({ success: true });
    });
  }
}

export default AuthController;
