import userModel from '../models/users.model';

/**
 * Outcome of a payout-address read or write.
 *
 * Shaped like `IIssueOutcome`: the controller picks a status from this rather
 * than asking the database a second time whether the account exists.
 */
export type IPayoutOutcome =
  | { status: 'ok'; payTo: string | null }
  | { status: 'no-account' };

/**
 * The payout address an account settles to.
 *
 * Stored on the user document rather than in its own collection — an account
 * has at most one, and `requireAuth` has already loaded that document, so a
 * read costs nothing extra.
 *
 * NOTE: this records an address and nothing else. On chain, moving a payout
 * goes through `X402Vault.changePayout`, which verifies an EIP-712
 * `ChangePayout(address newPayout,uint256 nonce,uint256 deadline)` signature
 * from the vault's merchant before any funds follow it. That check does not
 * exist yet, so what is stored here is a preference, not an authority, and
 * nothing that moves value may treat it as one until the vault is wired up.
 */
class PayoutService {
  private users = userModel;

  public async getPayTo(userId: string): Promise<IPayoutOutcome> {
    const user = await this.users.findById(userId).select('payTo');

    if (!user) {
      return { status: 'no-account' };
    }

    // `null` means the account has not set a payout address yet. That is a
    // normal onboarding state, not an error, and it is what the dashboard keys
    // the first step of the flow off.
    return { status: 'ok', payTo: user.payTo ?? null };
  }

  public async setPayTo(userId: string, payTo: string): Promise<IPayoutOutcome> {
    const user = await this.users.findByIdAndUpdate(
      userId,
      { $set: { payTo } },
      // Mongoose skips schema validators on an update unless asked, and the
      // schema is where the lowercasing lives — without this an address could
      // be stored in whatever case it arrived in.
      { new: true, runValidators: true },
    );

    if (!user) {
      return { status: 'no-account' };
    }

    return { status: 'ok', payTo: user.payTo ?? null };
  }
}

export default PayoutService;
