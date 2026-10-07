import { NextFunction, Request, Response } from 'express';

import { DEFAULT_CHAIN, isChainKey, type ChainKey } from '../config';
import { FacilitatorError } from '../exceptions/FacilitatorError';
import FacilitatorService from '../services/facilitator.service';
import SettlementService, { type SettleOutcome } from '../services/settlement.service';
import X402Service, { resolveNetwork, type PaymentContext } from '../services/x402.service';

/**
 * The x402Go facilitator proxy: the three endpoints an x402 client and an x402
 * seller talk to.
 *
 * This layer does no validation, no accounting and no HTTP of its own — it
 * reads what the request says, hands it to the service that owns it, and turns
 * the result into a status code. Every rule about what a payment may be lives
 * in `X402Service`, and every rule about what may be recorded lives in
 * `SettlementService`; putting any of it here would be a second copy to keep in
 * step.
 *
 * ## Which merchant is this?
 *
 * Never the one the body names. `apiKeyAuth` runs first on `/verify` and
 * `/settle` and puts the authenticated account on `req.user`; the merchant and
 * their vault are resolved from that and nothing else. The request body has no
 * field that can choose whose vault a payment is checked against, which is what
 * makes cross-merchant settlement impossible rather than merely rejected.
 *
 * ## `/supported` is public
 *
 * It carries no merchant data — it is Celo's own capability list — and an x402
 * client needs it before it has any credential to present. The Celo API key is
 * never in the response; it is added by `FacilitatorService` on the way *to*
 * Celo and does not exist on the way back.
 */

/** The merchant a request is acting for, taken from the authenticated key. */
function contextFor(user: IUserDocument): PaymentContext {
  return {
    merchantId: String(user._id),
    merchantAddress: user.address,
  };
}

/**
 * The chain a request names, defaulting to mainnet.
 *
 * Accepts the same spellings the payment envelope does, plus the bare chain
 * key, so a caller can ask for a network the same way it would write it in a
 * payment. An unrecognised value is refused rather than defaulted: silently
 * answering a request for an unknown network from mainnet would be a
 * surprising answer to a question nobody asked.
 */
function requestedChain(value: unknown): ChainKey {
  if (value === undefined || value === null || value === '') return DEFAULT_CHAIN;

  if (typeof value === 'string' && isChainKey(value)) return value;

  const resolved = resolveNetwork(value);

  if (!resolved) {
    throw new FacilitatorError('unsupported-network', { details: { received: value } });
  }

  return resolved;
}

class FacilitatorController {
  private readonly payments: X402Service;
  private readonly settlements: SettlementService;
  private readonly facilitator: FacilitatorService;

  /**
   * All three are injectable so the endpoints can be tested against a scripted
   * facilitator and a real in-memory database, without a network. There is no
   * other seam in this path that would let the ambiguous and failing settlement
   * cases — the ones that decide whether money is counted twice — be produced
   * on demand.
   */
  constructor(
    payments: X402Service = new X402Service(),
    settlements: SettlementService = new SettlementService(),
    facilitator: FacilitatorService = new FacilitatorService(),
  ) {
    this.payments = payments;
    this.settlements = settlements;
    this.facilitator = facilitator;
  }

  /**
   * `GET /supported` — what can be paid, straight from Celo.
   *
   * Returned with no reshaping. The response is Celo's own capability list and
   * this endpoint's job is to be a stable URL for it, not to interpret it: a
   * client that reads `kinds` from here and `kinds` from Celo must see the same
   * thing, or the proxy has quietly become a second source of truth about which
   * assets exist.
   */
  async getSupported(req: Request, res: Response, next: NextFunction) {
    try {
      const chain = requestedChain(req.query.network);
      const supported = await this.facilitator.supported(chain);

      return res.status(200).json(supported);
    } catch (error) {
      return next(error);
    }
  }

  /**
   * `POST /verify` — is this payment good?
   *
   * A question, and it changes nothing. No settlement record is written, no
   * balance moves, and no transaction is sent: the only thing that happens is
   * that the payment is checked against this merchant's vault and Celo is asked
   * whether the signature holds. A client that verifies a payment a hundred
   * times has a hundred answers and the same books.
   *
   * The facilitator's answer is passed through as it came, including when it
   * says the payment is invalid — that is a successful *verification*, and the
   * caller learns what it needs from `isValid`, not from the HTTP status.
   */
  async postVerify(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.user;

      if (!user) {
        // `apiKeyAuth` has already run and guarantees a merchant; this only
        // covers this handler being mounted without it.
        return res.status(401).json({ message: 'API key required' });
      }

      const payment = await this.payments.authorize(req.body, contextFor(user));

      const verification = await this.facilitator.verify(payment.chain, {
        x402Version: payment.x402Version,
        paymentPayload: payment.rawPayload,
        paymentRequirements: payment.rawRequirements,
      });

      return res.status(200).json(verification);
    } catch (error) {
      return next(error);
    }
  }

  /**
   * `POST /settle` — move the money, and record that we did.
   *
   * The response keeps the x402 settle shape (`success`, `transaction`,
   * `network`) so a client that already speaks the protocol needs no special
   * case, and adds the `settlement` record underneath it so the caller can see
   * the accounting it was charged.
   *
   * The status codes carry the distinction the protocol alone cannot express:
   * a settlement that happened and one that definitively did not are both 200,
   * because both are answers, while an outcome nobody knows is a **409** — the
   * caller must not retry it, and a retry is exactly what an error status
   * invites.
   */
  async postSettle(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.user;

      if (!user) {
        return res.status(401).json({ message: 'API key required' });
      }

      const payment = await this.payments.authorize(req.body, contextFor(user));

      const outcome = await this.settlements.settle(payment);

      return res
        .status(outcome.status === 'pending_reconciliation' ? 409 : 200)
        .json(settleBody(outcome, payment));
    } catch (error) {
      return next(error);
    }
  }
}

/**
 * The settle response, in x402's shape with the accounting attached.
 *
 * `transaction` is always present and is an empty string when nothing moved,
 * which is what the specification requires of a failed settlement — so a client
 * must read `success`, not the presence of a hash, to decide what happened.
 */
function settleBody(outcome: SettleOutcome, payment: { network: string; payer: string }) {
  const settlement = outcome.settlement;

  if (outcome.status === 'settled') {
    return {
      success: true,
      transaction: settlement.transactionHash ?? '',
      network: payment.network,
      payer: payment.payer,
      amount: settlement.grossAmount,
      // True when this request recognised an existing settlement rather than
      // making one. The caller needs it to tell "I settled this" from "this
      // was already settled" — the money is the same either way.
      duplicate: outcome.duplicate,
      settlement,
    };
  }

  if (outcome.status === 'failed') {
    return {
      success: false,
      errorReason: settlement.failureReason ?? 'settlement_failed',
      transaction: '',
      network: payment.network,
      payer: payment.payer,
      duplicate: outcome.duplicate,
      settlement,
    };
  }

  // Unknown: Celo was asked and x402Go never learned the answer. Reported as a
  // failure to the client so nothing is treated as done, and with a reason that
  // says plainly that it must not simply be retried.
  return {
    success: false,
    errorReason: 'settlement_pending_reconciliation',
    errorMessage:
      'The settlement was submitted but its outcome is unknown. It has not been ' +
      'retried. Do not resubmit this payment; check its status before acting.',
    transaction: '',
    network: payment.network,
    payer: payment.payer,
    duplicate: outcome.duplicate,
    settlement,
  };
}

export default FacilitatorController;
