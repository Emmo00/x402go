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

  /**
   * One merchant vault, on one chain.
   *
   * `address` is the deterministic address the factory computes for this
   * merchant. It is a real address from the moment it is derived and does not
   * imply that a vault has been deployed there — deployment is a separate fact,
   * read from the chain, and deliberately not stored here. Caching it would
   * make the record claim something it cannot know.
   */
  interface IVault {
    address: string;
    chainId: number;
    createdAt: Date;
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
     * The merchant's vault addresses, keyed by chain (`celo`, `celoSepolia`).
     *
     * A map rather than a list because there is exactly one vault per merchant
     * per chain — a uniqueness rule the storage enforces for free, instead of
     * leaving a duplicate entry to be filtered out at read time. Sparse: an
     * account has no map until its first sign-in derives one.
     *
     * Every entry is a cache of `X402VaultFactory.vaultOf(merchant)`. The
     * factory's answer is authoritative; a stored value that disagrees with it
     * is a bug to be corrected, never a preference to be honoured.
     */
    vaults?: Map<string, IVault>;
  }

  type IUserDocument = IUser & Document;
}
