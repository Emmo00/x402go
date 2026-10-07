/**
 * X402VaultFactory ABI.
 *
 * This is the single definition of the factory's interface for the backend; no
 * other file repeats it. It is a hand-written subset of the compiled ABI rather
 * than the whole artifact, so it carries only what x402Go calls and nothing a
 * caller could be tempted to call by accident.
 *
 * `as const` is what makes it useful: viem infers argument and return types
 * from the literal, so a mistyped function name or a wrong argument is a
 * compile error rather than a revert at runtime.
 *
 * Drift from the deployed contract is caught by `vaultAbi.test.ts`, which
 * checks every entry below against the forge artifact the deployed bytecode was
 * built from. Adding an entry here that the contract does not have fails that
 * test.
 */
export const X402_VAULT_FACTORY_ABI = [
  /* ---------------------------------------------------------------------- */
  /* Views                                                                  */
  /* ---------------------------------------------------------------------- */

  /** The X402Vault implementation every clone delegates to. Immutable. */
  {
    type: 'function',
    name: 'implementation',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },

  /**
   * The x402Go server wallet that may create vaults and withdraw from them.
   *
   * Read from the vault during `withdraw`, so rotating it here immediately
   * moves every vault's withdrawal rights.
   */
  {
    type: 'function',
    name: 'operator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },

  /** The recovery authority: may rotate the operator and withdraw fees. */
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },

  /**
   * The deterministic vault address for a merchant, deployed or not.
   *
   * This is the authoritative answer. The backend computes the same address
   * locally so it does not need an RPC round trip per request, and reconciles
   * the two — see `predictVaultAddress` and `VaultFactoryService.vaultOf`.
   */
  {
    type: 'function',
    name: 'vaultOf',
    stateMutability: 'view',
    inputs: [{ name: 'merchant', type: 'address' }],
    outputs: [{ name: '', type: 'address' }],
  },

  /* ---------------------------------------------------------------------- */
  /* Writes                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Deploys the merchant's vault and sets its initial payout in one call.
   *
   * Callable by the merchant or the operator. Named here for completeness and
   * for the deployment step that follows Step 0 — the sign-in flow in this
   * task deliberately does not call it.
   */
  {
    type: 'function',
    name: 'createVault',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'merchant', type: 'address' },
      { name: 'payout', type: 'address' },
    ],
    outputs: [{ name: 'vault', type: 'address' }],
  },

  /** Rotates the operator. Owner-only. */
  {
    type: 'function',
    name: 'setOperator',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newOperator', type: 'address' }],
    outputs: [],
  },

  /** Sweeps accumulated fees. Owner-only. */
  {
    type: 'function',
    name: 'withdrawFees',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokens', type: 'address[]' },
      { name: 'feeRecipient', type: 'address' },
    ],
    outputs: [],
  },

  /* ---------------------------------------------------------------------- */
  /* Events                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * The vault a merchant was given. `payout` is the value the factory passed
   * to `initPayout`, not a later `changePayout` — the vault's own
   * `PayoutChanged` covers those.
   */
  {
    type: 'event',
    name: 'VaultCreated',
    inputs: [
      { name: 'merchant', type: 'address', indexed: true },
      { name: 'vault', type: 'address', indexed: true },
      { name: 'payout', type: 'address', indexed: false },
    ],
  },

  /** Emitted before the operator slot changes, so the previous value is recoverable. */
  {
    type: 'event',
    name: 'OperatorChanged',
    inputs: [
      { name: 'previousOperator', type: 'address', indexed: true },
      { name: 'newOperator', type: 'address', indexed: true },
    ],
  },

  /* ---------------------------------------------------------------------- */
  /* Errors                                                                 */
  /* ---------------------------------------------------------------------- */

  /** A zero merchant or zero payout was supplied. */
  { type: 'error', name: 'InvalidAddress', inputs: [] },

  /**
   * The merchant already has a vault. The factory checks for an existing
   * address before cloning, because a CREATE2 collision burns all forwarded
   * gas rather than returning.
   */
  { type: 'error', name: 'VaultExists', inputs: [] },

  /** Caller is neither the merchant, the operator, nor (for owner paths) the owner. */
  { type: 'error', name: 'Unauthorized', inputs: [] },

  /** Solady `Ownable`: the owner slot was set to the zero address. */
  { type: 'error', name: 'NewOwnerIsZeroAddress', inputs: [] },

  /**
   * Solady `SafeTransferLib`: a transfer returned false, reverted, or had no
   * code.
   *
   * Declared by the library, not by this contract, so it is absent from the
   * compiled ABI — `withdrawFees` moves tokens with `safeTransfer` and can
   * genuinely revert with it. viem matches a revert by selector against the ABI
   * it is handed, so leaving it out would present the most likely failure of a
   * fee withdrawal as a bare four-byte selector.
   */
  { type: 'error', name: 'TransferFailed', inputs: [] },
] as const;
