/**
 * X402Vault ABI.
 *
 * The single definition of a vault's interface for the backend. A vault is a
 * minimal proxy (a clone-with-immutable-args), so every vault shares the
 * implementation's ABI; only `merchant()` differs per instance, and it is read
 * from the clone's own bytecode rather than from storage.
 *
 * Note what is *not* here: there is no operator function on a vault. The
 * operator lives on the factory, and `withdraw` reads it from there on every
 * call — which is what lets the owner rotate the operator once and have it take
 * effect across every vault at the same moment.
 */
export const X402_VAULT_ABI = [
  /* ---------------------------------------------------------------------- */
  /* Views                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * The merchant this vault belongs to, read from the clone's immutable args.
   *
   * This is also the key the signature in `changePayout` is verified against:
   * the merchant wallet signs, not the payout wallet.
   */
  {
    type: 'function',
    name: 'merchant',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },

  /**
   * Where the merchant's share of a withdrawal is sent.
   *
   * Falls back to `merchant()` until a payout is set, so this is never zero on
   * a deployed vault.
   */
  {
    type: 'function',
    name: 'payout',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'p', type: 'address' }],
  },

  /**
   * The replay counter for `changePayout`, incremented on every accepted
   * signature. Part of what a payout-change signature commits to.
   */
  {
    type: 'function',
    name: 'nonce',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint96' }],
  },

  /** The vault's balance of one token — the figure a withdrawal is sized against. */
  {
    type: 'function',
    name: 'tokenBalance',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },

  /* ---------------------------------------------------------------------- */
  /* Writes                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * One-shot initial payout, callable only by the factory and only at
   * creation. A deployed vault therefore has exactly one of two states: payout
   * set by the factory, or payout defaulting to the merchant.
   */
  {
    type: 'function',
    name: 'initPayout',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'p', type: 'address' }],
    outputs: [],
  },

  /**
   * Moves the payout address, authorised by an EIP-712 signature from the
   * merchant over `ChangePayout(address newPayout,uint256 nonce,uint256 deadline)`.
   *
   * The operator cannot call this and cannot forge it: the domain binds this
   * vault's address and the chain id, and the nonce makes each signature
   * single-use. This is the only path that changes where a merchant's money
   * lands, and it belongs to the merchant alone.
   */
  {
    type: 'function',
    name: 'changePayout',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'newPayout', type: 'address' },
      { name: '_deadline', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },

  /**
   * Sends the merchant leg to `payout()` and the fee leg to the factory, in one
   * transaction. Operator-only.
   *
   * The two legs are atomic: a failure in either reverts the whole call, so a
   * withdrawal can never half-apply. Callers pass a token address per entry,
   * which is why an unlisted or hostile token has to be treated as a possible
   * cause of the entire batch reverting.
   */
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokens', type: 'address[]' },
      { name: 'merchantAmounts', type: 'uint256[]' },
      { name: 'feeAmounts', type: 'uint256[]' },
    ],
    outputs: [],
  },

  /* ---------------------------------------------------------------------- */
  /* Events                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * `merchant` is the vault's identity, not the destination — the destination
   * is `payout()` as of this block, resolvable by the reader.
   */
  {
    type: 'event',
    name: 'PayoutChanged',
    inputs: [
      { name: 'merchant', type: 'address', indexed: true },
      { name: 'newPayout', type: 'address', indexed: true },
    ],
  },

  /** One per token per withdrawal, with the two legs the split produced. */
  {
    type: 'event',
    name: 'Withdrawn',
    inputs: [
      { name: 'merchant', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'merchantAmount', type: 'uint256', indexed: false },
      { name: 'feeAmount', type: 'uint256', indexed: false },
    ],
  },

  /* ---------------------------------------------------------------------- */
  /* Errors                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Not the factory (for `initPayout`) and not the operator (for `withdraw`). */
  { type: 'error', name: 'Unauthorized', inputs: [] },

  /** A zero address was supplied as a payout. */
  { type: 'error', name: 'InvalidAddress', inputs: [] },

  /** The three arrays passed to `withdraw` were not the same length. */
  { type: 'error', name: 'LengthMismatch', inputs: [] },

  /** The signature was malformed, from the wrong signer, or past its deadline. */
  { type: 'error', name: 'InvalidSignature', inputs: [] },

  /** `initPayout` was called on a vault that already has a payout. */
  { type: 'error', name: 'AlreadyInitialized', inputs: [] },

  /** Solady `SafeTransferLib`: a transfer returned false, reverted, or had no code. */
  { type: 'error', name: 'TransferFailed', inputs: [] },
] as const;
