import settlementModel from '../models/settlements.model';
import { FacilitatorError, isFacilitatorError } from '../exceptions/FacilitatorError';
import FacilitatorService, {
  type FacilitatorSettlement,
} from './facilitator.service';
import type { AuthorizedPayment } from './x402.service';

/**
 * The accounting boundary: the one place a payment becomes a record.
 *
 * `POST /verify` deliberately writes nothing — it is a question, and answering
 * it must not change the books. This service is what does change them, and it
 * is written so that the two ways money can be counted wrongly are structurally
 * impossible rather than merely guarded against:
 *
 *   **counted twice** — the record is written *before* the facilitator is
 *   called, keyed by a deterministic id derived from the signed payment under a
 *   unique index. A second request carrying the same payment cannot insert a
 *   second record, and cannot submit a second settlement, because the right to
 *   submit is claimed by a compare-and-swap on `submittedAt` that only one
 *   caller can win.
 *
 *   **counted when it did not happen** — the only transition that makes a
 *   payment count is `pending → settled`, and it is only ever taken on a
 *   response that actually said `success: true`. A failure, a refusal, and an
 *   unknown outcome all leave the payment uncounted.
 *
 * ## What "credited" means here
 *
 * There is no mutable balance anywhere, and that is deliberate. A balance has
 * to be incremented, `$inc` only works on numbers, and a `number` cannot hold
 * an 18-decimal token amount exactly — so a balance maintained with `$inc`
 * would silently lose precision on exactly the assets this system is built to
 * settle, which the brief forbids.
 *
 * The settlement log *is* the ledger. `merchantAmount` is the credit, written
 * once, immutably, on the record; a merchant's balance is the sum of
 * `merchantAmount` over their `settled` records and nothing else. "Finalising
 * accounting" is therefore the `pending → settled` transition itself, which is
 * a compare-and-swap and happens exactly once.
 */

/** A settlement as the API returns it. Amounts stay strings of atomic units. */
export interface SettlementView {
  readonly settlementId: string;
  readonly status: ISettlement['status'];
  readonly network: string;
  readonly chainId: number;
  readonly asset: string;
  readonly payer?: string;
  readonly payTo: string;
  readonly grossAmount: string;
  readonly merchantAmount: string;
  readonly x402GoFee: string;
  readonly facilitatorFee: string;
  readonly totalFee: string;
  readonly x402Version: number;
  readonly scheme: string;
  readonly nonce: string;
  readonly transactionHash?: string;
  readonly blockNumber?: number;
  readonly failureReason?: string;
  readonly createdAt: string;
  readonly settledAt?: string;
}

/**
 * The result of a settle request.
 *
 * `duplicate` says whether this request did the work or recognised earlier
 * work. It is on the outcome rather than inferred from the status because a
 * caller retrying a payment needs to tell "I settled this" from "this was
 * already settled", and the two are otherwise identical.
 */
export type SettleOutcome =
  | {
      readonly status: 'settled';
      readonly duplicate: boolean;
      readonly settlement: SettlementView;
      readonly facilitator: FacilitatorSettlement;
    }
  | {
      readonly status: 'failed';
      readonly duplicate: boolean;
      readonly settlement: SettlementView;
    }
  | {
      readonly status: 'pending_reconciliation';
      readonly duplicate: boolean;
      readonly settlement: SettlementView;
    };

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

/** Projects a stored record into the shape the API returns. */
function toView(settlement: ISettlement): SettlementView {
  return {
    settlementId: settlement.settlementId,
    status: settlement.status,
    network: settlement.network,
    chainId: settlement.chainId,
    asset: settlement.asset,
    payer: settlement.payer,
    payTo: settlement.payTo,
    grossAmount: settlement.grossAmount,
    merchantAmount: settlement.merchantAmount,
    x402GoFee: settlement.x402GoFee,
    facilitatorFee: settlement.facilitatorFee,
    totalFee: settlement.totalFee,
    x402Version: settlement.x402Version,
    scheme: settlement.scheme,
    nonce: settlement.nonce,
    transactionHash: settlement.transactionHash,
    blockNumber: settlement.blockNumber,
    failureReason: settlement.failureReason,
    createdAt: new Date(settlement.createdAt).toISOString(),
    settledAt: settlement.settledAt
      ? new Date(settlement.settledAt).toISOString()
      : undefined,
  };
}

export class SettlementService {
  private readonly settlements = settlementModel;
  private readonly facilitator: FacilitatorService;

  /**
   * The facilitator is injectable so the settle path can be tested end to end
   * — including its ambiguous and failing cases — without a network, and so the
   * tests can assert exactly what was sent.
   */
  constructor(facilitator: FacilitatorService = new FacilitatorService()) {
    this.facilitator = facilitator;
  }

  /**
   * Settles a payment that `X402Service.authorize` has already validated.
   *
   * The ordering is the contract: write the record, claim the right to submit,
   * *then* call the facilitator, *then* finalise. Nothing before the claim can
   * move money, and nothing after it can happen twice.
   */
  public async settle(payment: AuthorizedPayment): Promise<SettleOutcome> {
    const record = await this.openRecord(payment);

    if (record.duplicate) {
      return this.replay(record.settlement);
    }

    const claimed = await this.claimSubmission(payment.settlementId);

    // Someone else claimed this settlement between the insert and here — a
    // concurrent request carrying the same payment. Their call is the one that
    // counts, so this one reports the record rather than starting a second.
    if (!claimed) {
      return this.replay(await this.load(payment.settlementId));
    }

    return this.submit(payment, claimed);
  }

  /**
   * The merchant's settled totals, in atomic units, per asset.
   *
   * The ledger projection: a balance is what this returns and nothing else. It
   * sums only `settled` records, so an in-flight, failed or unreconciled
   * payment contributes nothing — which is the accounting rule stated as a
   * query rather than as a mutable number somebody has to remember to update.
   *
   * `$toLong` rather than `$sum` over strings because the amounts are stored as
   * exact integer strings; a `$sum` would need them to be doubles, and doubling
   * an 18-decimal token amount is the precision loss this whole design avoids.
   */
  public async settledTotals(
    merchantId: string,
  ): Promise<{ asset: string; network: string; amount: string }[]> {
    const rows = await this.settlements.aggregate<{
      _id: { asset: string; network: string };
      amount: unknown;
    }>([
      { $match: { merchantId, status: 'settled' } },
      {
        $group: {
          _id: { asset: '$asset', network: '$network' },
          amount: { $sum: { $toLong: '$merchantAmount' } },
        },
      },
      { $sort: { '_id.network': 1, '_id.asset': 1 } },
    ]);

    return rows.map((row) => ({
      asset: row._id.asset,
      network: row._id.network,
      amount: String(row.amount),
    }));
  }

  /**
   * Writes the `pending` record, or reports that one already exists.
   *
   * The insert is the idempotency check. It is not a read followed by a write:
   * two concurrent requests carrying the same payment would both pass a read
   * and both insert, so the uniqueness is enforced where it cannot be raced —
   * by the database, on the unique `settlementId` index, with the duplicate
   * reported as `E11000` rather than checked for beforehand.
   */
  private async openRecord(
    payment: AuthorizedPayment,
  ): Promise<{ duplicate: false; settlement: ISettlement } | { duplicate: true; settlement: ISettlement }> {
    const document = {
      settlementId: payment.settlementId,
      merchantId: payment.merchantId,
      merchantAddress: payment.merchantAddress,
      vaultAddress: payment.vaultAddress,
      network: payment.chain,
      chainId: payment.chainId,
      payer: payment.payer,
      payTo: payment.payTo,
      asset: payment.asset,

      // Integer strings, never numbers. See the model for why.
      grossAmount: payment.grossAmount.toString(),
      merchantAmount: payment.merchantAmount.toString(),
      x402GoFee: payment.x402GoFee.toString(),
      facilitatorFee: payment.facilitatorFee.toString(),
      totalFee: payment.totalFee.toString(),

      x402Version: payment.x402Version,
      scheme: payment.scheme,
      nonce: payment.nonce,

      status: 'pending' as const,
      createdAt: new Date(),
    };

    try {
      const created = await this.settlements.create(document);

      return { duplicate: false, settlement: created.toObject() as ISettlement };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;

      // Already recorded: this exact signed payment has been seen before.
      return { duplicate: true, settlement: await this.load(payment.settlementId) };
    }
  }

  /**
   * Claims the exclusive right to submit this settlement to the facilitator.
   *
   * The compare-and-swap: the update only matches while `submittedAt` is unset,
   * so of any number of concurrent callers exactly one gets a document back and
   * the rest get `null`. This is what makes "do not submit another settlement
   * unnecessarily" a property of the storage rather than of the timing.
   *
   * It is also the reason a `pending` record is safe to distinguish at all: no
   * `submittedAt` means Celo was provably never asked, and a record that has one
   * is never submitted again by anyone.
   */
  private async claimSubmission(settlementId: string): Promise<ISettlement | null> {
    const claimed = await this.settlements.findOneAndUpdate(
      { settlementId, status: 'pending', submittedAt: { $exists: false } },
      { $set: { submittedAt: new Date() } },
      { returnDocument: 'after', includeResultMetadata: false },
    );

    return (claimed?.toObject() as ISettlement | undefined) ?? null;
  }

  /**
   * Calls the facilitator and finalises according to what it said.
   *
   * The three outcomes map one-to-one onto the three ways a call can end, and
   * the mapping is the part worth reading closely: only a response that
   * affirmatively said `success: true` settles anything, and every way of *not
   * knowing* becomes `pending_reconciliation` rather than a failure.
   *
   * That asymmetry is intentional and it is the conservative direction. An
   * unreachable facilitator, a timeout, and an unusable response all leave open
   * the possibility that Celo received the request and moved the money. Marking
   * any of them `failed` would invite a retry, and a retry of a payment that
   * already settled is the one mistake that costs real money twice.
   */
  private async submit(
    payment: AuthorizedPayment,
    record: ISettlement,
  ): Promise<SettleOutcome> {
    const body = {
      x402Version: payment.x402Version,
      paymentPayload: payment.rawPayload,
      paymentRequirements: payment.rawRequirements,
    };

    let response: FacilitatorSettlement;

    try {
      response = await this.facilitator.settle(payment.chain, body);
    } catch (error) {
      return this.finalizeFailure(payment.settlementId, record, error);
    }

    if (response.success) {
      const settled = await this.transition(payment.settlementId, {
        status: 'settled',
        transactionHash: response.transaction || undefined,
        blockNumber: this.readBlockNumber(response),
        facilitatorResponse: response,
        settledAt: new Date(),
      });

      return {
        status: 'settled',
        duplicate: false,
        settlement: toView(settled),
        facilitator: response,
      };
    }

    const failed = await this.transition(payment.settlementId, {
      status: 'failed',
      failureReason: response.errorReason ?? 'settlement_failed',
      facilitatorResponse: response,
    });

    return { status: 'failed', duplicate: false, settlement: toView(failed) };
  }

  /**
   * Decides what a thrown facilitator failure means for the record.
   *
   * The one case that is *known* rather than unknown is a missing credential:
   * `FacilitatorService` reads the key before it builds a request, so that
   * failure proves nothing was ever sent, and the payment can be marked failed
   * with confidence. Everything else — unreachable, timed out, answered
   * unusably — is recorded as unknown, for a human to reconcile against the
   * facilitator and the chain.
   */
  private async finalizeFailure(
    settlementId: string,
    record: ISettlement,
    error: unknown,
  ): Promise<SettleOutcome> {
    const code = isFacilitatorError(error) ? error.code : 'unexpected';
    const neverSent = code === 'facilitator-key-unusable';

    // The message of a FacilitatorError is written for a payer to read and
    // names no credential; an arbitrary error's is not, so it is not stored.
    const reason = isFacilitatorError(error) ? error.message : 'unexpected_failure';

    const updated = await this.transition(settlementId, {
      status: neverSent ? 'failed' : 'pending_reconciliation',
      failureReason: neverSent ? code : `${code}: unknown outcome`,
      facilitatorResponse: { error: code },
    });

    return {
      status: neverSent ? 'failed' : 'pending_reconciliation',
      duplicate: false,
      settlement: toView(updated),
    };
  }

  /**
   * Moves a record out of `pending`, exactly once.
   *
   * Every terminal transition goes through here, and every one of them is
   * filtered on `status: 'pending'`, so a record can only leave that state
   * once however many callers try. If the update matches nothing — because a
   * concurrent request already finalised it — the stored record is returned
   * as it stands rather than the caller's version being forced over it.
   */
  private async transition(
    settlementId: string,
    update: Record<string, unknown>,
  ): Promise<ISettlement> {
    const updated = await this.settlements.findOneAndUpdate(
      { settlementId, status: 'pending' },
      { $set: update },
      { returnDocument: 'after', includeResultMetadata: false },
    );

    if (updated) return updated.toObject() as ISettlement;

    return this.load(settlementId);
  }

  /** Reads a record that is known to exist. */
  private async load(settlementId: string): Promise<ISettlement> {
    const found = await this.settlements.findOne({ settlementId }).lean<ISettlement>();

    if (!found) {
      // Reached only if a record were deleted between the insert and the read.
      throw new FacilitatorError('settlement-conflict', {
        details: { settlementId },
      });
    }

    return found;
  }

  /**
   * Reports an already-recorded settlement without acting on it again.
   *
   * This is the whole of the duplicate path, and it does no work on purpose: it
   * does not resubmit, does not re-credit, and does not "repair" the record.
   * A `settled` payment returns its settlement; a `failed` one returns the
   * failure rather than being retried, because the facilitator already said no
   * to this exact signature; and a `pending_reconciliation` one stays unknown
   * until a human says otherwise.
   */
  private replay(record: ISettlement): SettleOutcome {
    if (record.status === 'settled') {
      return {
        status: 'settled',
        duplicate: true,
        settlement: toView(record),
        facilitator: (record.facilitatorResponse ?? {}) as FacilitatorSettlement,
      };
    }

    if (record.status === 'failed') {
      return { status: 'failed', duplicate: true, settlement: toView(record) };
    }

    // `pending_reconciliation`, and `pending` too: a record still marked
    // pending is one another request is submitting right now, or one whose
    // process died holding it. Either way this caller must not submit it, and
    // "we do not know yet" is the honest thing to report.
    return { status: 'pending_reconciliation', duplicate: true, settlement: toView(record) };
  }

  /**
   * A block number, if the facilitator volunteered one.
   *
   * The settle response schema has no block number, so this is usually
   * undefined and is left unset rather than fetched. Reading it from the chain
   * would add a second network dependency to a path that has already been
   * confirmed, and the transaction hash is enough to find the block.
   */
  private readBlockNumber(response: FacilitatorSettlement): number | undefined {
    const extra = response.extra;

    if (typeof extra !== 'object' || extra === null) return undefined;

    const blockNumber = (extra as { blockNumber?: unknown }).blockNumber;

    return typeof blockNumber === 'number' && Number.isInteger(blockNumber)
      ? blockNumber
      : undefined;
  }
}

export default SettlementService;
