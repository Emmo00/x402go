import {
  concat,
  encodePacked,
  getAddress,
  keccak256,
  pad,
  size,
  toHex,
  type Address,
  type Hex,
} from 'viem';

/**
 * Deterministic vault addresses.
 *
 * A merchant's vault address is fixed before the vault exists: the factory
 * clones a fixed implementation with a salt derived from the merchant, so the
 * address is a pure function of (factory, implementation, merchant). This
 * module reproduces that function off chain, which is what lets the backend put
 * a real `payTo` address on a merchant's dashboard the moment they sign in,
 * without deploying anything and without waiting on an RPC call.
 *
 * What this module is *not*: the authority. `X402VaultFactory.vaultOf` is, and
 * `VaultFactoryService` reconciles against it. This is a cache of that answer
 * that happens to be computable without a network. The two agree because the
 * constants below are a transcription of Solady's `LibClone`, checked against
 * the deployed factory in `vaultAddress.test.ts`.
 *
 * ## How the address is constructed
 *
 * Solady's clone-with-immutable-args is a minimal proxy whose constructor
 * returns a runtime that has the immutable arguments appended to it. The
 * initcode is therefore:
 *
 * ```
 * 61 <len>             PUSH2 len          — the runtime length, 45 + args
 * 3d 81 60 0a 3d 39 f3 RETURNDATASIZE DUP2 PUSH1 10 RETURNDATASIZE CODECOPY RETURN
 * 36 3d 3d 37 3d 3d 3d 36 3d 73          — runtime: CALLDATASIZE ... PUSH20 <impl>
 * <implementation>                        — 20 bytes
 * 5a f4 3d 82 80 3e 90 3d 91 60 2b 57 fd 5b f3
 * <args>                                  — the merchant address, 20 bytes
 * ```
 *
 * The read of `len` is `45 + args.length` rather than a fixed 45, which is the
 * detail that makes this easy to get wrong by hand: the constant `0x2d` only
 * appears when there are no arguments, and ours always has one.
 *
 * This whole blob is hashed into the CREATE2 preimage, so the arguments are
 * part of the address. A clone deployed with a different merchant's args lands
 * somewhere else entirely, and nobody can front-run a merchant to the address
 * by deploying first — see `VaultFactoryService.predict` for what that buys.
 */

/**
 * Length of the clone's runtime code, without arguments.
 *
 * 10 bytes of dispatcher + 20 bytes of implementation + 15 bytes of tail. This
 * is also the offset `LibClone.argsOnClone` reads arguments from, so it is
 * load-bearing in two places.
 */
const CLONE_RUNTIME_LENGTH = 45;

/** Opcodes that return the runtime from the initcode, minus the leading PUSH2. */
const CLONE_INIT_PROLOGUE = '0x3d81600a3d39f3' as const;

/** Runtime dispatcher, up to and including the `PUSH20` that the address follows. */
const CLONE_RUNTIME_HEAD = '0x363d3d373d3d3d363d73' as const;

/** Runtime tail: delegate to the implementation and copy its return value back. */
const CLONE_RUNTIME_TAIL = '0x5af43d82803e903d91602b57fd5bf3' as const;

/** `create2` preimage prefix. */
const CREATE2_PREFIX = '0xff' as const;

/**
 * A `Hex` in one canonical form.
 *
 * viem's `pad`, `concat` and `encodePacked` copy the casing of their input, so
 * a checksummed merchant address produces an upper-case salt and initcode. The
 * bytes are identical either way and the derived address does not change —
 * `keccak256` reads hex case-insensitively — but a value that is sometimes
 * upper-case and sometimes not is a trap for the next thing that compares or
 * logs one, and every fixture in the tests is written lower-case.
 */
function lower(hex: Hex): Hex {
  return hex.toLowerCase() as Hex;
}

/**
 * The CREATE2 salt for a merchant: the address as a left-padded `bytes32`.
 *
 * Solady's `bytes32(uint256(uint160(merchant)))`. The address occupies the low
 * 20 bytes, so the top 12 are zero — worth stating because the obvious mistake
 * is to right-pad or to hash the address rather than widen it, and either
 * produces a plausible-looking address that no vault will ever occupy.
 */
export function vaultSalt(merchant: Address): Hex {
  return lower(pad(merchant, { size: 32, dir: 'left' }));
}

/**
 * The initcode the factory passes to CREATE2 for a merchant's vault.
 *
 * Exported because it is the thing worth asserting in a test: the address is
 * only a hash away from this, and a test that checks the address alone cannot
 * tell you *which* byte was wrong.
 */
export function vaultInitCode(implementation: Address, merchant: Address): Hex {
  const args = encodePacked(['address'], [merchant]);
  // `size` returns the byte length. `args.length` would return the length of
  // the *hex string*, which is 42 rather than 20 and would encode a runtime
  // length 22 bytes too long — producing a well-formed initcode, a
  // plausible-looking address, and a vault that never exists there.
  const runtimeLength = CLONE_RUNTIME_LENGTH + size(args);

  return lower(
    concat([
      // PUSH2 <runtime length> — the length the constructor returns and copies.
      '0x61',
      toHex(runtimeLength, { size: 2 }),
      CLONE_INIT_PROLOGUE,
      CLONE_RUNTIME_HEAD,
      implementation,
      CLONE_RUNTIME_TAIL,
      args,
    ]),
  );
}

/** `keccak256(initcode)` — the value CREATE2 hashes against the salt. */
export function vaultInitCodeHash(implementation: Address, merchant: Address): Hex {
  return keccak256(vaultInitCode(implementation, merchant));
}

/**
 * The address a merchant's vault will occupy, deployed or not.
 *
 * Equivalent to `X402VaultFactory.vaultOf(merchant)`, computed locally. Returns
 * a checksummed address: the vault address is shown to a human who may compare
 * it against a block explorer, and an all-lowercase string is harder to verify
 * by eye than one that carries its own checksum.
 */
export function predictVaultAddress(
  factory: Address,
  implementation: Address,
  merchant: Address,
): Address {
  const digest = keccak256(
    concat([
      CREATE2_PREFIX,
      factory,
      vaultSalt(merchant),
      vaultInitCodeHash(implementation, merchant),
    ]),
  );

  // The address is the low 20 bytes of the digest.
  return getAddress(`0x${digest.slice(-40)}`);
}

/**
 * Two addresses are the same account.
 *
 * Used to compare a stored vault address against the factory's answer. The
 * stored copy may be in either case — an address is a 20-byte value and EIP-55
 * casing is a checksum over it, not part of it — so the comparison is done on
 * the bytes. Returns false for anything that is not a well-formed address
 * rather than throwing, because the caller is usually reacting to data that
 * came from a database.
 */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;

  return a.toLowerCase() === b.toLowerCase();
}
