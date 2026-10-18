import userModel from '../models/users.model';

/**
 * Outcome of a payout-address read or write.
 *
 * Shaped like `IIssueOutcome`: the controller picks a status from this rather
 * than asking the database a second time whether the account exists.
 */
export type ITransactionTagOutcome =
  | { status: 'ok'; transactionTag: string | null }
  | { status: 'no-account' };

/**
 * The payout address an account settles to.
 *
 * Stored on the user document rather than in its own collection — an account
 * has at most one, and `requireAuth` has already loaded that document, so a
 * read costs nothing extra.
 *
 * NOTE: this records an address and nothing else. On chain, moving a payout
 * goes through `X402PaymentRelayer.changePayout`, which verifies an EIP-712
 * `ChangePayout(address newPayout,uint256 nonce,uint256 deadline)` signature
 * from the vault's merchant before any funds follow it. That check does not
 * exist yet, so what is stored here is a preference, not an authority, and
 * nothing that moves value may treat it as one until the vault is wired up.
 */
class TransactionTagService {
  private users = userModel;

  public async getTransactionTag(userId: string): Promise<ITransactionTagOutcome> {
    const user = await this.users.findById(userId).select('transactionTag');

    if (!user) {
      return { status: 'no-account' };
    }

    return { status: 'ok', transactionTag: user.transactionTag ?? null };
  }

  public async setTransactionTag(userId: string, transactionTag: string): Promise<ITransactionTagOutcome> {
    const user = await this.users.findByIdAndUpdate(
      userId,
      { $set: { transactionTag } },
      { new: true, runValidators: true },
    );

    if (!user) {
      return { status: 'no-account' };
    }

    return { status: 'ok', transactionTag: user.transactionTag ?? null };
  }
}

export default TransactionTagService;
