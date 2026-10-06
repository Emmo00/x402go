import { type Router } from 'express';
import type { Document } from 'mongoose';
import 'express-session';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: IUserDocument;
    }
  }

  interface IAppRoute {
    path: string;
    router: Router;
  }

  /**
   * The single API key an account may hold.
   *
   * `hash` is the only credential that is ever persisted — the plaintext key
   * exists solely in the response that creates it. `suffix` is the last few
   * characters of the plaintext, kept so the key can be recognised in the UI
   * and used to narrow candidates before the hash is verified. It is not a
   * secret and cannot be used to authenticate.
   */
  interface IApiKey {
    hash: string;
    suffix: string;
    createdAt: Date;
    rotatedAt?: Date;
  }

  interface IUser {
    address: string;
    authChallenge: {
      nonce: string;
      expiredAt: Date;
      used: boolean;
    };
    apiKey?: IApiKey;
    /**
     * The address settled x402 payments are sent to. Optional: an account has
     * none until it completes onboarding. Stored lowercased, like `address`,
     * so nothing ever hinges on checksum casing.
     */
    payTo?: string;
  }

  type IUserDocument = IUser & Document;
}
