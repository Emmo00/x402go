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

  interface IVault {
    address: string;
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
    /**
     * The merchant's vault address — one address, the same on every supported
     * network. Optional: it is recorded when the merchant signs in, so an
     * account that has never done so has none, and `default: undefined` keeps
     * "has none" distinct from "has an empty one" in the document.
     */
    vaults?: IVault;
    transactionTag?: string;
  }

  type IUserDocument = IUser & Document;

  /**
   * A short-lived mutual-exclusion record, held in the database rather than in
   * this process's memory.
   *
   * `_id` is the resource being locked, not a generated id, so "only one
   * holder" is enforced by the `_id` uniqueness rule the database already
   * guarantees. `owner` identifies the holder so only it can release the lock:
   * a lock that expires and is taken by someone else must not be deleted by the
   * previous holder when it finally finishes.
   *
   * `expiresAt` is what makes the lock recoverable. A process that dies mid
   * operation never releases, and without an expiry the resource would be
   * locked forever; the TTL index is the janitor for that case, and the
   * acquire query treats an expired record as free.
   */
  interface ILock {
    _id: string;
    owner: string;
    expiresAt: Date;
  }
}
