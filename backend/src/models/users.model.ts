import * as mongoose from 'mongoose';

/**
 * The stored form of an account's API key.
 *
 * `hash` is `select: false` so it is never loaded by an ordinary query and can
 * therefore never reach a response by accident — the API-key verification path
 * has to ask for it explicitly with `.select('+apiKey.hash')`.
 *
 * `_id: false` keeps the subdocument from growing an ObjectId it has no use
 * for; the key is identified by its owning user.
 */
const apiKeySchema = new mongoose.Schema<IApiKey>(
  {
    hash: {
      type: String,
      required: true,
      select: false,
    },
    suffix: {
      type: String,
      required: true,
    },
    createdAt: {
      type: Date,
      required: true,
    },
    rotatedAt: {
      type: Date,
      required: false,
    },
  },
  {
    _id: false,
  },
);

/**
 * One merchant vault address.
 *
 * `_id: false` for the same reason as `apiKeySchema`: the entry is identified
 * by the map key that holds it, and an ObjectId would only be a second,
 * redundant identifier.
 *
 * There is deliberately no `deployed` field. Whether a vault is deployed is a
 * fact about the chain that changes without this document being written, so
 * storing it would create a value that is wrong the moment someone else
 * deploys. It is read from the chain on the requests that need it.
 *
 * The three deployment fields that follow are different in kind, which is why
 * they are allowed: each is a record of an event that already happened, written
 * once when the operator's transaction deployed the vault, and never a claim
 * about the present. Nothing reads them to decide anything.
 */
const vaultSchema = new mongoose.Schema<IVault>(
  {
    address: {
      type: String,
      required: true,
      lowercase: true,
    },
    chainId: {
      type: Number,
      required: true,
    },
    createdAt: {
      type: Date,
      required: true,
    },

    // Set only by the deployment path, and only for a vault this backend
    // deployed itself — a vault deployed by the merchant directly, or found
    // already deployed, has no transaction of ours to record.
    transactionHash: {
      type: String,
      required: false,
    },
    blockNumber: {
      type: Number,
      required: false,
    },
    deployedAt: {
      type: Date,
      required: false,
    },
  },
  {
    _id: false,
  },
);

const userSchema = new mongoose.Schema<IUser>(
  {
    address: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      index: true,
    },

    authChallenge: {
      nonce: {
        type: String,
        required: true,
      },
      expiredAt: {
        type: Date,
        required: true,
      },
      used: {
        type: Boolean,
        required: true,
        default: false,
      },
    },

    // Optional: an account has no key until it creates one, and the whole
    // object is replaced in a single write when the key is rotated.
    apiKey: {
      type: apiKeySchema,
      required: false,
    },

    // The address settlements are paid out to. Optional, and left unset until
    // the account finishes onboarding. Lowercased on write for the same reason
    // `address` is: an EVM address is a byte string, and its mixed-case EIP-55
    // form is a checksum, not part of the value.
    payTo: {
      type: String,
      required: false,
      lowercase: true,
    },

    // The merchant's vault address per chain, keyed by chain name. A map keeps
    // "one vault per merchant per chain" true by construction: a second write
    // for the same chain replaces the entry rather than adding a rival.
    //
    // `default: undefined` rather than `{}` so an account that has never signed
    // in carries no `vaults` key at all, and "has none" is distinguishable from
    // "has an empty one" in the raw document.
    vaults: {
      type: Map,
      of: vaultSchema,
      required: false,
      default: undefined,
    },
  },
  {
    timestamps: true,
  },
);

// Verification looks a presented key up by its suffix rather than by the key
// itself. The suffix is short and deliberately not unique, so this only narrows
// the candidate set; the hash check below it is what actually authenticates.
userSchema.index({ 'apiKey.suffix': 1 });

const userModel = mongoose.model<IUser>('User', userSchema);

export default userModel;
