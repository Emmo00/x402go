import * as mongoose from 'mongoose';

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

const vaultSchema = new mongoose.Schema<IVault>(
  {
    address: {
      type: String,
      required: true,
      lowercase: true,
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
    vaults: {
      type: vaultSchema,
      required: false,
      default: undefined,
    },
    transactionTag: {
      type: String,
      required: false,
      default: undefined,
    }
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
