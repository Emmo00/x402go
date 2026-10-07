import * as mongoose from 'mongoose';

/**
 * One x402 payment x402Go has attempted to settle.
 *
 * This is the accounting record, and it is written before the facilitator is
 * called rather than after it answers. That ordering is the whole design: a
 * settlement that exists only once it has succeeded cannot describe a payment
 * that is in flight, a payment that failed, or — the case that actually costs
 * money — a payment whose outcome nobody knows. All three are states x402Go has
 * to be able to report, so the record has to exist first.
 *
 * # Amounts are strings
 *
 * Every amount here is a `string` holding an integer in the asset's atomic
 * units. Not a `number`, and not a `Decimal128`: a `number` cannot hold an
 * 18-decimal token amount without losing precision, and these values are
 * compared and summed. Storing the exact digits the chain uses means the record
 * says what the payment said, and a reader that wants a human-readable figure
 * divides by the token's decimals at the point of display — never here.
 *
 * # Why the fee split is stored and not recomputed
 *
 * The three fee fields are a record of what x402Go charged for *this* payment,
 * at the moment it charged it. Recomputing them at read time would silently
 * restate history if the fee schedule ever changed, and the whole point of an
 * accounting record is that it does not move.
 *
 * # The status is the honest one
 *
 * `pending_reconciliation` is a first-class outcome, not a failure. It means a
 * settlement was submitted and x402Go never learned whether it landed. The one
 * thing that must not happen is treating it as `failed` and retrying, which
 * could settle the same payment twice.
 */
const settlementSchema = new mongoose.Schema<ISettlement>(
  {
    /**
     * Derived from the signed payment itself, and unique.
     *
     * This is what makes settlement idempotent: the same signed authorization
     * presented twice derives the same id, the second insert collides on the
     * unique index below, and the existing record is returned instead of a
     * second settlement being attempted. It is deterministic rather than
     * random precisely so that the *second* request can recognise the first.
     */
    settlementId: {
      type: String,
      required: true,
      unique: true,
    },

    /**
     * The merchant this belongs to. Resolved from the API key, never from the body.
     *
     * Indexed by the compound `{ merchantId, createdAt }` index at the foot of
     * this file rather than by a single-field index here: that one serves any
     * query on `merchantId` alone, so declaring both would put a second,
     * redundant index on a collection that every settlement writes to.
     */
    merchantId: {
      type: String,
      required: true,
    },
    /** The merchant's wallet address, denormalised so a record is readable alone. */
    merchantAddress: {
      type: String,
      required: true,
      lowercase: true,
    },
    /** The vault address the payment is addressed to, lowercased. */
    vaultAddress: {
      type: String,
      required: true,
      lowercase: true,
    },
    /** The chain key (`celo`, `celoSepolia`), which is what every other lookup is keyed by. */
    network: {
      type: String,
      required: true,
    },
    /** The EIP-155 chain id, as it appears in the signed authorization. */
    chainId: {
      type: Number,
      required: true,
    },

    /** The account that signed the payment, lowercased. From the authorization. */
    payer: {
      type: String,
      required: false,
      lowercase: true,
    },
    /** Where the payment is addressed. Equal to `vaultAddress` by the time it is stored. */
    payTo: {
      type: String,
      required: true,
      lowercase: true,
    },
    /** The token contract the payment is denominated in. */
    asset: {
      type: String,
      required: true,
    },

    // The money. All five are integer strings in the asset's atomic units, and
    // `grossAmount` is the sum of the other three by construction.
    grossAmount: { type: String, required: true },
    merchantAmount: { type: String, required: true },
    x402GoFee: { type: String, required: true },
    facilitatorFee: { type: String, required: true },
    totalFee: { type: String, required: true },

    // Enough of the x402 envelope to reconstruct what was asked for, so a
    // reconciliation does not need the original request.
    x402Version: { type: Number, required: true },
    scheme: { type: String, required: true },
    /**
     * The authorization's replay-prevention nonce.
     *
     * Part of how `settlementId` is derived, and kept in the clear because it is
     * the field an operator reconciles against a block explorer and against the
     * facilitator's own logs.
     */
    nonce: { type: String, required: true },

    status: {
      type: String,
      required: true,
      enum: ['pending', 'settled', 'failed', 'pending_reconciliation'],
      index: true,
    },

    /** The facilitator's own response body, stored verbatim for reconciliation. */
    facilitatorResponse: {
      type: mongoose.Schema.Types.Mixed,
      required: false,
    },
    /** Why it failed, when it did. A string code, never a stack. */
    failureReason: {
      type: String,
      required: false,
    },

    transactionHash: { type: String, required: false },
    blockNumber: { type: Number, required: false },

    createdAt: { type: Date, required: true },
    /**
     * Set, exactly once, at the moment this settlement is handed to the
     * facilitator — and the field that makes a resubmission impossible.
     *
     * It answers the one question a `pending` record otherwise cannot: *has
     * x402Go already asked Celo to move this money?* A `pending` record with no
     * `submittedAt` provably has not, so it is safe to claim and submit; one
     * that has it never is again, whatever happens next. Claiming it is a
     * compare-and-swap (`submittedAt` must not exist), so two concurrent
     * requests carrying the same payment cannot both decide to submit it.
     */
    submittedAt: { type: Date, required: false },
    /** When the facilitator confirmed it. Set once, never recomputed. */
    settledAt: { type: Date, required: false },
  },
  {
    timestamps: true,
  },
);

// The unique index on `settlementId` is declared on the field above, next to the
// doc comment that explains why idempotency rests on it. It is deliberately not
// repeated as a `schema.index()` call: declaring the same index twice makes
// Mongoose warn that the duplicate's options — `unique` among them — may not be
// applied, which is not a risk worth taking for a constraint this load-bearing.

// The dashboard's query: a merchant's settlements, newest first. Also serves any
// lookup by `merchantId` alone, since that is this index's prefix.
settlementSchema.index({ merchantId: 1, createdAt: -1 });

const settlementModel = mongoose.model<ISettlement>('Settlement', settlementSchema);

export default settlementModel;
