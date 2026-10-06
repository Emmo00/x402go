import { NextFunction, Request, Response } from 'express';
import PayoutService, { IPayoutOutcome } from '../services/payout.service';
import { isValidPayToAddress } from '../utils/payTo';

/** The address is the whole resource, so it is the whole body and response. */
function payoutBody(outcome: Extract<IPayoutOutcome, { status: 'ok' }>) {
  return { payTo: outcome.payTo };
}

class PayoutController {
  private payoutService = new PayoutService();

  /**
   * `GET /payout` — the address settlements are sent to.
   *
   * Returns `null` rather than a 404 when the account has not set one: "not
   * configured yet" is a step in onboarding, not a missing resource, and the
   * dashboard needs to tell those apart without inspecting status codes.
   */
  async getPayout(req: Request, res: Response, next: NextFunction) {
    const user = req.user;

    if (!user) {
      // `requireAuth` has already run and guarantees a user; this only covers a
      // route being mounted without it.
      return res.status(401).json({ message: 'Authentication required' });
    }

    const outcome: IPayoutOutcome = await this.payoutService.getPayTo(String(user._id));

    if (outcome.status === 'no-account') {
      return res.status(404).json({ message: 'Account not found' });
    }

    return res.status(200).json(payoutBody(outcome));
  }

  /**
   * `PUT /payout` — sets or replaces the payout address.
   *
   * Idempotent: sending the same address twice leaves the account in the same
   * state, so this is a `PUT` on a single-value resource rather than a `POST`.
   *
   * The account comes from the authenticated session, never from the body, so
   * a caller cannot set a payout address on someone else's account.
   */
  async setPayout(req: Request, res: Response, next: NextFunction) {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const { payTo } = req.body ?? {};

    if (!isValidPayToAddress(payTo)) {
      return res.status(400).json({
        message:
          'payTo must be a 0x-prefixed 20-byte address and must not be the zero address',
      });
    }

    const outcome: IPayoutOutcome = await this.payoutService.setPayTo(
      String(user._id),
      payTo,
    );

    if (outcome.status === 'no-account') {
      return res.status(404).json({ message: 'Account not found' });
    }

    return res.status(200).json(payoutBody(outcome));
  }
}

export default PayoutController;
