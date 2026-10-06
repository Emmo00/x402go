import { NextFunction, Request, Response } from 'express';
import ApiKeyService, { IIssueOutcome, IIssuedApiKey } from '../services/apiKeys.service';

/**
 * The body returned the one and only time a key is readable.
 *
 * Everything except `apiKey` is safe to show again later; `apiKey` is not
 * recoverable after this response is sent, which is why it is returned here and
 * nowhere else.
 */
function issuedKeyBody(key: IIssuedApiKey) {
  return {
    apiKey: key.apiKey,
    suffix: key.suffix,
    maskedKey: key.maskedKey,
    createdAt: key.createdAt,
    ...(key.rotatedAt ? { rotatedAt: key.rotatedAt } : {}),
  };
}

class ApiKeysController {
  private apiKeyService = new ApiKeyService();

  /**
   * `POST /api-keys` — issues the account's first API key.
   *
   * An account may hold exactly one key, so this is not idempotent: a second
   * call is a 409 and the caller is pointed at rotation instead. The check and
   * the write are the same database operation, so two concurrent requests
   * cannot both succeed.
   */
  async createApiKey(req: Request, res: Response, next: NextFunction) {
    const user = req.user;

    if (!user) {
      // `requireAuth` has already run and guarantees a user; this only covers a
      // route being mounted without it.
      return res.status(401).json({ message: 'Authentication required' });
    }

    const outcome: IIssueOutcome = await this.apiKeyService.createApiKey(String(user._id));

    switch (outcome.status) {
      case 'issued':
        return res.status(201).json(issuedKeyBody(outcome.key));
      case 'exists':
        return res.status(409).json({
          message: 'This account already has an API key. Rotate it to issue a new one.',
        });
      default:
        return res.status(401).json({ message: 'Authentication required' });
    }
  }

  /**
   * `POST /api-keys/rotate` — replaces the account's API key.
   *
   * The response carries the new plaintext key, once. The previous key stops
   * authenticating as a side effect of the same write, so there is no window in
   * which both keys are accepted. The old key is never returned and is not
   * recoverable from what is stored.
   */
  async rotateApiKey(req: Request, res: Response, next: NextFunction) {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const outcome: IIssueOutcome = await this.apiKeyService.rotateApiKey(String(user._id));

    switch (outcome.status) {
      case 'issued':
        return res.status(200).json(issuedKeyBody(outcome.key));
      case 'no-key':
        return res.status(409).json({
          message: 'This account does not have an API key yet. Create one first.',
        });
      default:
        return res.status(404).json({ message: 'Account not found' });
    }
  }
}

export default ApiKeysController;
