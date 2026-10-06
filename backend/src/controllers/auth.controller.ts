import { NextFunction, Request, Response } from 'express';
import { generateNonce, SiweMessage } from 'siwe';
import UserService from '../services/users.service';

class AuthController {
  private userService = new UserService();

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

        req.session.userId = (
          (await this.userService.findUserByAddress(address)) as IUserDocument
        )?._id.toString(); // Store the user's ID in the session

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
