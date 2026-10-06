import userModel from '../models/users.model';
import {
  apiKeySuffix,
  generateApiKey,
  hashApiKey,
  isWellFormedApiKey,
  maskApiKey,
  verifyApiKey,
} from '../utils/apiKey';

/**
 * The one and only time a plaintext key exists outside the request that asked
 * for it. Nothing here is logged, persisted, or kept on the service — the
 * caller writes it to the response and drops it.
 */
export interface IIssuedApiKey {
  apiKey: string;
  suffix: string;
  maskedKey: string;
  createdAt: Date;
  rotatedAt?: Date;
}

/** Outcome of an attempt to issue a key, so the controller can pick a status. */
export type IIssueOutcome =
  | { status: 'issued'; key: IIssuedApiKey }
  | { status: 'exists' }
  | { status: 'no-account' }
  | { status: 'no-key' };

/**
 * API keys live on the user document rather than in their own collection, and
 * every mutation of them is a single `findOneAndUpdate`. That is what makes an
 * account able to hold exactly one active key: MongoDB applies a single-document
 * update atomically, so two concurrent requests cannot both observe "no key" and
 * both write one. No transaction and no application-level lock is needed.
 */
class ApiKeyService {
  private users = userModel;

  /**
   * Issues the account's first API key.
   *
   * The `apiKey: { $exists: false }` clause is the whole concurrency story: it
   * is evaluated as part of the update, so of two simultaneous requests exactly
   * one matches and gets a document back. The loser sees `null` and is told the
   * account already has a key.
   */
  public async createApiKey(userId: string): Promise<IIssueOutcome> {
    const apiKey = generateApiKey();
    const createdAt = new Date();

    const user = await this.users.findOneAndUpdate(
      { _id: userId, apiKey: { $exists: false } },
      {
        $set: {
          apiKey: {
            hash: hashApiKey(apiKey),
            suffix: apiKeySuffix(apiKey),
            createdAt,
          },
        },
      },
      { new: true },
    );

    if (!user) {
      // `null` means the filter did not match: either the account already has a
      // key, or it vanished between authentication and here. Telling those two
      // apart matters, because they are a 409 and a 401 respectively.
      const exists = await this.users.exists({ _id: userId });

      return exists ? { status: 'exists' } : { status: 'no-account' };
    }

    return {
      status: 'issued',
      key: {
        apiKey,
        suffix: apiKeySuffix(apiKey),
        maskedKey: maskApiKey(apiKey),
        createdAt,
      },
    };
  }

  /**
   * Replaces the account's API key.
   *
   * `hash` and `suffix` are overwritten in the same `$set` that stamps
   * `rotatedAt`. There is no intermediate state in which the old hash is still
   * present, so the previous key stops authenticating the instant this write
   * lands — it is never retained as a secondary credential, and no grace period
   * exists in which both keys work.
   */
  public async rotateApiKey(userId: string): Promise<IIssueOutcome> {
    const apiKey = generateApiKey();
    const rotatedAt = new Date();

    const user = await this.users.findOneAndUpdate(
      { _id: userId, apiKey: { $exists: true } },
      {
        $set: {
          'apiKey.hash': hashApiKey(apiKey),
          'apiKey.suffix': apiKeySuffix(apiKey),
          // `createdAt` tracks the age of the *current* key, so it restarts on
          // rotation; `rotatedAt` records when that rotation happened.
          'apiKey.createdAt': rotatedAt,
          'apiKey.rotatedAt': rotatedAt,
        },
      },
      { new: true },
    );

    if (!user) {
      const exists = await this.users.exists({ _id: userId });

      return exists ? { status: 'no-key' } : { status: 'no-account' };
    }

    return {
      status: 'issued',
      key: {
        apiKey,
        suffix: apiKeySuffix(apiKey),
        maskedKey: maskApiKey(apiKey),
        createdAt: rotatedAt,
        rotatedAt,
      },
    };
  }

  /**
   * Resolves a presented key to its account, or `null` if it does not
   * authenticate.
   *
   * The key is never used as a query value. It is reduced to its suffix, which
   * narrows the search to a handful of candidates, and each candidate's stored
   * hash is then checked in constant time. Because rotation overwrites the hash,
   * a replaced key finds its account here and still fails verification — it is
   * rejected by the hash check, not by a separate revocation list.
   */
  public async findUserByApiKey(apiKey: unknown): Promise<IUserDocument | null> {
    if (!isWellFormedApiKey(apiKey)) {
      return null;
    }

    const candidates = await this.users
      .find({ 'apiKey.suffix': apiKeySuffix(apiKey) })
      // `apiKey.hash` is `select: false`, so it has to be asked for by name.
      .select('+apiKey.hash');

    for (const candidate of candidates) {
      const storedHash = candidate.apiKey?.hash;

      if (storedHash && verifyApiKey(apiKey, storedHash)) {
        return candidate as IUserDocument;
      }
    }

    return null;
  }
}

export default ApiKeyService;
