# x402Go Smart Contract Security Audit

> **STATUS — HISTORICAL SNAPSHOT.** This report describes the contracts *as they were at the time of the
> audit* (`withdrawAll`, operator-supplied `feeRecipient`, no operator-change event, 138 tests). **It has
> not been rewritten.** The findings below are the record of what was wrong then, and several have since
> been fixed; the code, the tests and `.gas-snapshot` now describe a different contract. Read this document
> for the *reasoning*, not for the current interface. Name mapping for anything you find here:
>
> | Name in this report | Current name |
> | --- | --- |
> | `X402Vault.withdrawAll(tokens, merchantAmounts, feeAmounts, feeRecipient)` | `X402Vault.withdraw(tokens, merchantAmounts, feeAmounts)` — the `feeRecipient` parameter is gone; the fee leg always goes to the immutable factory |
> | `X402VaultFactory(owner)` + `setOperator` | `X402VaultFactory(owner, operator)` — operator is a constructor argument, and `setOperator` rejects `address(0)` |
> | `changePayout(newPayout, signature)` | `changePayout(newPayout, deadline, signature)` |
> | *(no operator event existed)* | `X402VaultFactory.OperatorChanged(previousOperator, newOperator)` |
> | *(no fee-withdrawal path existed)* | `X402VaultFactory.withdrawFees(tokens, feeRecipient)`, owner-only |
>
> Fix status, for the record: C-01 (operator-chosen fee sink) — **fixed**, the recipient is now immutable
> and structural. H-03 (zero operator bricks withdrawals) — **fixed at the rotation entry point**; the
> constructor still accepts zero, which the tests now document rather than assert as correct. M-06
> (payout-redirection blindness) — **partly fixed**, `PayoutChanged` and `OperatorChanged` are now emitted.
> C-02, M-04, and the settlement-accounting findings remain **open by design** — the blueprint places
> accounting off-chain.

**Scope:** `contracts/src/X402Vault.sol`, `contracts/src/X402VaultFactory.sol`, `contracts/src/interfaces/IX402VaultFactory.sol`, `contracts/script/DeployX402VaultFactory.s.sol`, `contracts/test/**`, and their integration with the x402Go backend.

**Commit:** `3c999c7` plus uncommitted NatSpec-only edits to the two `src/` files (verified: `git diff` shows 19 inserted comment lines, no logic change).

**Dependency note:** the brief refers to "OpenZeppelin dependencies" and "OpenZeppelin ECDSA utilities". **This project does not use OpenZeppelin.** All primitives come from **Solady** (`lib/solady/`, remapped as `solady/`). Findings below were verified against the vendored Solady source, not against OpenZeppelin's behaviour; where the two differ in a way that matters, that is called out explicitly (see L-05 and the answers to Q3/Q7).

**Method:** full source review, review of all 138 existing tests, review of the vendored Solady primitives actually reached by the code, a survey of the backend for the documented settlement flow, and six executable proofs-of-concept. Every finding marked *Confirmed* was reproduced against a live EVM; the PoC file was deleted after the run and the repository is byte-identical to its prior state.

---

## 1. Executive summary

The contracts are small, cleanly written, and unusually well tested at the unit level — 138 tests, 10,000 fuzz runs each, gas-snapshotted, with genuinely thoughtful coverage of signature edge cases, token quirks, and reentrancy. The clone architecture is correct and the EIP-712 implementation is textbook-quality: per-vault domain, chain-ID binding, and replay nonces all verified working.

**The problem is not the code quality. It is that there is no security model for the money.**

`withdrawAll` is a stateless, operator-only function that transfers caller-supplied amounts to a caller-supplied `feeRecipient`. The contract keeps **no record of what belongs to the merchant and what belongs to x402Go**. The split is asserted entirely in calldata. A single compromised — or merely malicious — operator key can therefore move **100% of any vault's balance to any address, at any time, with no signature from the merchant and nothing on chain to contradict it**. This is not a subtle bug; it is the declared design, and it is confirmed by a passing proof-of-concept.

Three further structural problems compound it:

- The backend that is supposed to compute the split **does not exist**. `grossAmount`, `merchantAmount`, `x402GoFee`, `facilitatorFee` and `recordSettlement` appear **nowhere in the repository** — not in code, not in types, not in schemas, not even in prose. There is no chain client, no RPC URL, no contract address, and no EIP-712 signing anywhere in the backend. The `OPERATOR_KEY` the backend requires to boot is validated and then never read by a single line of code. The vault is entirely unwired.
- The payout-change rule in the brief ("a valid signature from the previous payout address") is **not what the contract does**. It verifies the *merchant*, permanently. The author's own NatSpec agrees with the code, so this is a requirements divergence rather than a coding slip — but it means a browser-hot merchant key keeps forever the power to redirect every future payout.
- The operator can **create a vault for any merchant with an attacker-chosen payout**, and the deterministic address means the merchant's own creation then reverts with `VaultExists`.

Also worth stating plainly, because it is easy to miss: **there is no `withdrawAll` path that a merchant can invoke.** A merchant cannot recover their own funds. If the operator key is lost, the owner key is lost, or `setOperator(address(0))` is ever called, every vault's balance is frozen forever with no recovery function.

**Verdict: not safe to hold real funds in its current form.** The fix is architectural, not a patch — see §5. Everything else in this report is secondary to that.

### What is genuinely good

Recording these so the fixes do not regress them:

- `LibClone.cloneDeterministic` with immutable args, `FACTORY` as a true immutable, deterministic CREATE2 addresses, and a pre-check that avoids burning all gas on a collision (`X402VaultFactory.sol:37-40`).
- EIP-712 domain correctly binds `address(this)` (the clone) and `block.chainid`; Solady caches the separator and invalidates on chain-ID or address change. Cross-vault, cross-factory and cross-chain replay are all genuinely blocked, and the test suite proves each.
- Solady's `SignatureCheckerLib` returns `false` for `signer == address(0)` (`SignatureCheckerLib.sol:85`), so the classic `ecrecover`-returns-zero forgery is **not** reachable despite `merchant()` being able to yield a non-zero garbage value on the implementation contract.
- `SafeTransferLib.safeTransfer` rejects false-returning, reverting, *and* codeless "tokens" (`SafeTransferLib.sol:346-350`), so a bogus token address cannot silently no-op a withdrawal.
- Payout and nonce packed into one slot; `payout()` read once before the loop; calldata arrays; custom errors; the zero-amount legs skipped so that zero-transfer-reverting tokens cannot brick a batch.

---

## 2. Overall security assessment

| Dimension | Rating | Note |
|---|---|---|
| Access control on withdrawals | **Critical** | Operator-gated, but the operator is unconstrained in *destination* and *amount* |
| Separation of merchant funds from fees | **Absent** | No balances, no ledger; the distinction exists only in calldata |
| Payout-change authorization | **High risk** | Works, but authorizes the wrong key relative to spec; no expiry |
| Replay protection | **Good** | Nonce + chainId + verifyingContract all correct and tested |
| Signature verification | **Good** | EOA + ERC-1271 + EIP-2098; zero-signer guarded. Malleable (by design, harmless here) |
| ERC-20 handling | **Good** | SafeTransferLib; atomic batches; the vault cannot be tricked into a bad transfer |
| Clone / minimal-proxy architecture | **Good, two gaps** | Correct pattern; no one-shot init guard, no implementation protection |
| Operator-compromise blast radius | **Total loss** | The stated requirement (#9) is not met in any measure |
| Observability | **Poor** | No events on payout change, withdrawal, or operator rotation |
| Backend integration | **Non-existent** | Nothing computes or submits anything |
| Test quality | **High** | Excellent unit coverage; misses every issue in this report |

**The single sentence that matters:** the contract's security boundary is "trust the operator completely", and the brief's requirements (#9, #10) ask for "trust the operator as little as possible". The gap between those two positions is the whole audit.

---

## 3. Findings

Severity counts: **2 Critical, 4 High, 6 Medium, 6 Low, 6 Informational.**

---

### C-01 — Operator can drain any vault to an arbitrary address, with no merchant signature

**Severity:** Critical — *Confirmed with a live PoC*
**Affected:** `X402Vault.withdrawAll` (`X402Vault.sol:68-89`), specifically the `feeRecipient` parameter at `:72` and the fee leg at `:87`

**Description.** `feeRecipient` is a free per-call parameter supplied by the operator, and `feeAmounts[i]` is unconstrained calldata. There is no recorded fee balance to draw against. The operator can therefore construct a call in which the merchant's leg is zero and the entire vault balance is labelled "fees" and sent to the operator's own address.

**Attack scenario.**

```solidity
// Attacker holds the operator key. The vault holds 1,000,000 USDC of merchant funds.
vm.prank(operator_attacker);
vault.withdrawAll(
    [USDC],        // token
    [0],           // merchantAmounts  -> merchant gets nothing
    [1_000_000e6], // feeAmounts       -> "fees"
    attacker       // feeRecipient     -> attacker's own address
);
// 1,000,000 USDC now sits at `attacker`. The merchant received 0.
```

This PoC was compiled and executed against `X402Vault` as written. Result:

```
[PASS] test_A01_operatorDrainsEverythingToArbitraryAddress()
  attacker balance : 1000000000000000000000
  merchant balance : 0
  vault balance    : 0
```

**Impact.** Total, irreversible loss of all merchant funds across every vault the operator can reach — i.e. the entire platform's float, in a single transaction. There is no on-chain signal that anything is wrong, because (see M-02) the vault emits no events.

**Why this implementation is vulnerable.** Not a coding error — a missing invariant. The contract has no concept of "the merchant's balance", so it cannot check that `merchantAmounts[i]` is the merchant's money and `feeAmounts[i]` is x402Go's. `SafeTransferLib.safeTransfer` correctly prevents the transfer *failing*; nothing prevents it being *wrong*. The `feeRecipient == address(0)` check at `:75` is the only validation the destination ever receives.

**Recommended fix.** The destination must stop being a parameter. Two changes, both required:

1. Make the fee recipient **immutable** (set at factory construction, or an owner-controlled state variable on the factory that vaults read), so the operator cannot choose where fees go.
2. Introduce a recorded balance per token — `merchantBalance[token]` and `feeBalance[token]` — credited by an operator-attested settlement function, and **cap both legs by the recorded balances**:
   ```solidity
   uint256 m = merchantAmounts[i];
   uint256 f = feeAmounts[i];
   if (m > merchantBalance[token]) revert InsufficientBalance();
   if (f > feeBalance[token])     revert InsufficientBalance();
   merchantBalance[token] -= m;
   feeBalance[token]     -= f;
   if (m != 0) SafeTransferLib.safeTransfer(token, to, m);            // to = payout()
   if (f != 0) SafeTransferLib.safeTransfer(token, FEE_RECIPIENT, f); // not a parameter
   ```
   This does not stop a compromised operator from *over-reporting* settlements (see C-02), but it stops it redirecting funds that are already recorded as the merchant's — which is the blast-radius reduction requirement #9 demands. Combined with the fee-rate enforcement in §5, the operator's maximum theft becomes a bounded fraction rather than 100%.

**Test to add:** yes — a regression test asserting that `withdrawAll` with `feeAmounts` exceeding `feeBalance` reverts, and that the fee leg can only ever reach the configured fee address. The A01 PoC above inverts directly into the regression.

---

### C-02 — No settlement accounting exists anywhere; the documented split is unenforceable

**Severity:** Critical
**Affected:** `X402Vault` (whole accounting model); the backend (absent)

**Description.** The specified invariant is `grossAmount = merchantAmount + x402GoFee + facilitatorFee`. Nothing in this repository implements, records, or enforces it. An exhaustive repository survey establishes (occurrences outside this report):

| Symbol | Occurrences in the codebase |
|---|---|
| `grossAmount` | **0** |
| `x402GoFee` | **0** |
| `facilitatorFee` | **0** |
| `recordSettlement` | **0** |
| `merchantAmount` (singular) | **0** |

The plural `merchantAmounts`/`feeAmounts` exist only as `withdrawAll` parameters, and they are caller-supplied. **The contract does not compute the split, and neither does the backend.**

**Attack scenario.** Not an exploit — a category error. There is nothing to attack because there is nothing to verify. An operator that simply passes wrong numbers is indistinguishable from one that passes right ones.

**Impact.** (a) Merchants have no on-chain evidence of what they are owed. (b) A dispute is unresolvable — the chain records only the transfers, not the entitlement. (c) The blast radius of an operator compromise is unbounded (C-01). (d) `feeAmounts` may be silently less than what x402Go is owed, and no reconciliation is possible.

**Why this implementation is vulnerable.** The architecture places the entire ledger off-chain and gives the on-chain component no role beyond executing transfers. That is a defensible choice *only* if the off-chain component is trusted and the on-chain component enforces the parts that need enforcing — the destination, the cap, and the fee rate. None of those are enforced.

**Recommended fix.** Add the minimal on-chain ledger described in §5: an operator-attested `recordSettlement` that credits per-token merchant/fee balances, and withdrawals capped by those balances. Two design warnings:

- Because the operator authors the settlement amounts, `recordSettlement` **must not increase any balance beyond tokens actually held by the vault**. Otherwise the operator can mint claims out of nothing and then drain real funds belonging to other merchants. Cap credits by observed balance, or better, credit from *observed inflow*: have the vault reconcile `tokenBalance(token)` against `merchantBalance + feeBalance` and treat any surplus according to a fixed rule. A settlement report that could exceed holdings must revert.
- Do not let `recordSettlement` be the *only* check. If the operator can write any numbers, then the ledger is only as trustworthy as the operator — which is why the fee *rate* must be enforced in code (§5) rather than asserted.

**Test to add:** yes — the split invariant (`gross == merchant + x402GoFee + facilitatorFee`), plus a test that a settlement report exceeding the vault's actual holdings reverts.

---

### H-01 — `changePayout` authorizes the merchant forever, not the current payout address

**Severity:** High — *Confirmed with a live PoC*
**Affected:** `X402Vault.changePayout` (`X402Vault.sol:49-61`), specifically `merchant()` at `:55`

**Description.** The brief requires the payout to be changeable "only with a valid signature from the previous payout address". Line 55 verifies against `merchant()` instead. Once the payout has been moved to a new address, that new address **has no authority at all**, while the original merchant retains it permanently.

**Attack scenario (confirmed).**

```
merchant sends ChangePayout -> payout moves to P
P signs ChangePayout(third, nonce=1)   -> REVERTS InvalidSignature
merchant signs ChangePayout(third, nonce=1) -> SUCCEEDS
```

The consequence with a compromised merchant key: the merchant identity in this system is the **SIWE sign-in wallet** (`backend/src/controllers/auth.controller.ts`), i.e. a browser hot wallet used routinely. An attacker who obtains it can, at any point in the vault's life, sign a `ChangePayout` to their own address; the next operator withdrawal pays every merchant-leg transfer to the attacker. The merchant's ceremony of "moving payout to a treasury/custody address" provides no protection, because it never removed the hot key's authority.

**Impact.** Silent redirection of all future merchant payouts following a hot-key compromise. Not a fund-loss bug in the absence of compromise — but it fails the stated requirement and destroys a defense-in-depth property the spec was clearly designed to provide.

**Why this implementation is vulnerable.** The NatSpec at `X402Vault.sol:46-48` ("Can only be called by the merchant", "@param signature The signature of the merchant") and the backend comment at `backend/src/services/payout.service.ts:21-22` ("an EIP-712 ... signature from the vault's merchant") both agree with the code. **The divergence is between the brief and the implementation, and it must be resolved by a decision, not a patch.**

**Recommended fix.** Pick one, deliberately:

- *(a) Follow the brief:* verify against `payout()` instead of `merchant()`. Consequence: authority transfers with the address; the merchant permanently loses control after the first change; and if the payout address is a hot wallet, its compromise is immediately fatal with no recovery. Also note this makes the **first** change impossible to authorize from the merchant's perspective unless `payout() == merchant()` is the initial state — which it is, so it works, but the semantics must be documented carefully.
- *(b) Keep merchant authority (recommended)* and correct the brief. Add a mitigant for the hot-key concern: a `deadline` (M-01), and optionally a two-step handoff where the *new* payout address must also accept, so a silent redirection requires compromising two keys.

If (b) is chosen, say so explicitly in the spec, because the frontend onboarding currently implies the merchant's wallet controls the payout and users will infer (a).

**Test to add:** yes — whichever semantics are chosen, a test asserting that the *other* key is rejected, in both directions. The A02 PoC is the (b)-shaped version.

---

### H-02 — Operator can pre-empt a merchant's vault with an attacker-chosen payout

**Severity:** High — *Confirmed with a live PoC*
**Affected:** `X402VaultFactory.createVault` (`X402VaultFactory.sol:30-47`), authorization at `:32`, `initPayout` call at `:44`

**Description.** `createVault` is authorized by `msg.sender == merchant || msg.sender == operator`. When called by the operator, **the `merchant` and `payout` arguments are both free**. Because vault addresses are deterministic and single-shot (`VaultExists` at `:38-40`), an operator that creates a vault for a victim first claims that victim's only possible vault address — permanently bound to a payout of the operator's choosing.

**Attack scenario (confirmed).**

```solidity
// Attacker holds the operator key. Victim has not onboarded yet.
vm.prank(operator_attacker);
address v = factory.createVault(victim, attackerControlledPayout);
// v == factory.vaultOf(victim)  -- the victim's one and only vault address
// X402Vault(v).payout() == attackerControlledPayout

// The victim now tries to create their own vault:
vm.prank(victim);
factory.createVault(victim, victim);  // REVERTS VaultExists
```

Because `payout != merchant`, line 44 calls `initPayout` and writes the hostile payout directly into storage — **bypassing the signature and nonce model entirely**. The victim's funds then settle into a vault whose withdrawals pay the attacker.

**Impact.** (a) All merchant-leg withdrawals for that merchant go to an attacker-chosen address. (b) The victim cannot create a correct vault — they are reduced to signing a `ChangePayout` after noticing. (c) It is a clean griefing primitive against any address, at the operator's discretion, before or during onboarding.

**Why this implementation is vulnerable.** Two independent choices combine badly: (i) the operator may name an arbitrary `merchant` *and* an arbitrary `payout` on someone else's behalf; and (ii) vault creation is single-shot per merchant, so being first is decisive. Either alone is survivable; together they hand the operator a first-mover advantage over every merchant.

**Recommended fix.** Remove the operator's freedom over `payout`. Concretely, either:

- **Always** create with `payout = merchant` and delete the `payout` parameter — the only way to a different payout is then a signed `changePayout` (which H-01 decides who may sign). This is the simplest correct fix and makes `initPayout`'s payout-bypass unreachable.
- Or keep the parameter but require `msg.sender == merchant` whenever `payout != merchant`, so the operator can only ever create the default-payout vault.

**Test to add:** yes — that `createVault` by the operator for a third-party merchant either reverts or always yields `payout() == merchant`.

---

### H-03 — `initPayout` is an unguarded, un-evented privileged setter that bypasses the signature model

**Severity:** High
**Affected:** `X402Vault.initPayout` (`X402Vault.sol:41-44`), called from `X402VaultFactory.sol:44`

**Description.** `initPayout` writes `_payout` for any address, at any time, with no restriction beyond `msg.sender == FACTORY`. It:

- does **not** check whether the vault is already initialized (no one-shot guard);
- does **not** bump or consult `nonce`;
- emits **no event**;
- requires **no signature from anyone**;
- overwrites an existing payout unconditionally.

Today the factory calls it from exactly one place (`createVault`, on a freshly deployed clone), so **it is not currently exploitable**. But it is a live, external, admin-only write path to the most security-sensitive variable in the contract, reachable by the factory forever.

**Attack scenario.** There is no exploit today. The risk is prospective and severe: any future factory function that forwards to `initPayout` — a migration helper, a "fix payout" admin function, a batch operation, an upgrade — becomes an **instant, signature-free takeover of every vault**, with no event to notice it by and no nonce to invalidate it. This is exactly the class of latent privilege that audits exist to remove.

**Impact.** Latent. Enables total, silent redirection of all payouts if the factory ever exposes a forwarding path. Also note the test suite *asserts* the factory can call it on the implementation contract (`X402VaultFactory.t.sol:38-46`, `test_constructor_implementationIsBoundToFactory`), cementing the behaviour as intended.

**Why this implementation is vulnerable.** The initialization pattern is incomplete. A clone's one-time initializer should be idempotent-guarded and should be impossible to invoke after setup.

**Recommended fix.** In order of preference:

1. **Remove `initPayout` entirely** and pass the initial payout through the clone's immutable args (`abi.encodePacked(merchant, payout)`), letting `payout()` fall back to the arg rather than storage. This deletes the privileged path and the storage write. Note this requires `payout()` to read a second clone arg, and H-02's fix must be applied so the operator cannot choose it.
2. If it must stay, make it strictly one-shot and observable:
   ```solidity
   function initPayout(address p) external {
       if (msg.sender != FACTORY) revert Unauthorized();
       if (_payout != address(0)) revert AlreadyInitialized();  // one-shot
       _payout = p;
       emit PayoutChanged(address(0), p, 0);                     // observable
   }
   ```
   Note the one-shot guard interacts with the current "skip when `payout == merchant`" optimisation at `X402VaultFactory.sol:44`: if `_payout` stays `address(0)`, a later `initPayout` would still be permitted, so the guard alone is not sufficient unless the sentinel is changed (e.g. initialize to `merchant()` explicitly, or use a separate `initialized` flag).

**Test to add:** yes — that a second `initPayout` on an already-initialized clone reverts, and that no caller other than the factory can ever set the payout.

---

### H-04 — Clearing the operator permanently freezes every vault; there is no merchant withdrawal path

**Severity:** High — *Confirmed with a live PoC*
**Affected:** `X402VaultFactory.setOperator` (`X402VaultFactory.sol:56-58`), `X402Vault.withdrawAll` (`X402Vault.sol:74`)

**Description.** `withdrawAll` is gated solely on `IX402VaultFactory(FACTORY).operator()`. `setOperator` has **no zero-address check** (unlike `createVault`, which validates both its addresses). Setting the operator to `address(0)` — through a mistake, a rotation gone wrong, a compromised owner, or a lost owner key — makes `msg.sender != address(0)` true for every caller, so `withdrawAll` reverts for everyone, permanently. `renounceOwnership()` produces the same terminal state, as the project's own test documents (`X402VaultFactory.t.sol:321`, `test_ownership_renounceBricksSetOperatorButKeepsOperator`).

Crucially, **there is no alternative path**: a merchant cannot withdraw their own funds under any circumstance, even with a perfectly functioning operator and owner. The merchant — the party whose money it is — has no function they can call.

**Attack scenario (confirmed).**

```
owner calls setOperator(address(0))
operator  -> withdrawAll : REVERTS Unauthorized
merchant  -> withdrawAll : REVERTS Unauthorized
owner     -> withdrawAll : REVERTS Unauthorized
=> 500e18 tokens remain in the vault with no code path that can ever move them
```

**Impact.** Permanent, total loss of access to all funds in all vaults. Not theft — destruction. Also a live operational hazard: `setOperator` is the routine rotation operation, and a single zero-value mistake is unrecoverable.

**Why this implementation is vulnerable.** Withdrawal authority is a single point of failure with no fallback, and the setter that controls it permits an unusable value.

**Recommended fix.**

1. Add a zero-address check to `setOperator` (`if (newOperator == address(0)) revert InvalidAddress();`) — the factory already has the error defined and uses it in `createVault`. Add an `OperatorChanged` event while here (M-02).
2. **Add a merchant escape hatch.** The merchant is the vault's owner; they should always be able to recover their own funds. Even a simple `withdrawToMerchant(tokens)` gated on `msg.sender == merchant()` — sending to `payout()` — bounds the damage of a lost operator key from "total loss" to "operational inconvenience". This is the single highest-value change after C-01.
3. Consider whether `renounceOwnership` should be disabled on the factory; with an immutable `implementation` and the operator in storage, renouncing permanently removes the ability to rotate the operator, which is itself a security control.

**Test to add:** yes — that `setOperator(address(0))` reverts, and that the merchant can always recover funds with the operator unset.

---

### M-01 — `ChangePayout` signatures never expire and are permissionlessly relayable

**Severity:** Medium
**Affected:** `X402Vault.changePayout` (`X402Vault.sol:49-61`); typehash at `:14`

**Description.** The signed struct is `ChangePayout(address newPayout, uint256 nonce)` — no `deadline`, no `chainId` in the struct (the domain covers chain ID, correctly), no vault-specific field (the domain covers the vault, correctly). The nonce prevents replay, but **nothing bounds a signature's lifetime**. A signed payout change remains executable until its nonce is consumed, which may be never. `test_changePayout_anyoneCanRelayMerchantSignature` confirms any third party may submit it, by design.

**Attack scenario.** A merchant signs a `ChangePayout` to a new address, then changes their mind (or the destination turns out to be wrong, or the signature is phished from a signature-request UI). The signature sits in a wallet history, an email, a support ticket, or the mempool. Weeks later, anyone who holds it can execute it — still valid, because the nonce is untouched. It can also be front-run: if the merchant wants to move to Y but an attacker holds a stale signature for X, the attacker submits X first, consuming nonce *n*; the merchant's Y-signature (signed at nonce *n*) is now permanently invalid and they must re-sign at *n+1*.

**Impact.** Enables delayed, unexpected payout redirection from a leaked or stale signature; a griefing vector on pending changes. Requires a signature to leak, so it is a defense-in-depth gap rather than a direct vulnerability.

**Why this implementation is vulnerable.** Nonce-based replay protection is necessary but not sufficient; standard practice (EIP-2612, Permit2, and every mature EIP-712 authorization) pairs a nonce with an expiry.

**Recommended fix.** Extend the struct:
```solidity
bytes32 private constant CHANGE_PAYOUT_TYPEHASH =
    keccak256("ChangePayout(address newPayout,uint256 nonce,uint256 deadline)");
// ...
if (block.timestamp > deadline) revert SignatureExpired();
```
The domain already supplies the vault address and chain ID, so no extra fields are needed for those. This *does* change the digest, so the backend (whenever it is written) and the frontend must sign the new struct — coordinate the rollout. See also L-05 on canonicality.

**Test to add:** yes — a signature with `deadline < block.timestamp` must revert; a signature must remain valid exactly at the boundary.

---

### M-02 — No events on payout change, withdrawal, or operator rotation

**Severity:** Medium — *Confirmed with a live PoC*
**Affected:** `X402Vault.changePayout`, `X402Vault.withdrawAll`, `X402Vault.initPayout`; `X402VaultFactory.setOperator`

**Description.** The only event in the entire contract set is `VaultCreated` (`X402VaultFactory.sol:18`). A `recordLogs()` capture across a payout change and a full withdrawal shows **zero** logs emitted by the vault:

```
[PASS] test_A05_noEventsOnPayoutChangeOrWithdrawal()
  vault emitted a log -> false  (only the token's own Transfer events appeared)
```

**Attack scenario.** The C-01 drain is silent. A payout redirection is silent. An operator rotation is silent. There is no on-chain record a merchant, an indexer, a monitoring service, or an incident responder can watch. Detection depends entirely on a merchant manually comparing balances — which, given there is no `withdrawAll` they can call and no balance view exposing entitlements, they cannot do.

**Impact.** (a) Drains and redirections cannot be detected on chain. (b) The backend cannot reconstruct history for a merchant-facing ledger, which the frontend's `Overview.jsx` placeholder expects. (c) Incident response is impossible without replaying every transfer. This is a security finding, not a cosmetic one: unobservable privileged actions are how long-lived compromises persist.

**Why this implementation is vulnerable.** Events were simply not written. Note the contract is otherwise disciplined about gas, so the cost objection is weak.

**Recommended fix.** Add, at minimum:
```solidity
event PayoutChanged(address indexed previousPayout, address indexed newPayout, uint256 nonce);
event Withdrawn(address indexed token, address indexed to, uint256 merchantAmount, uint256 feeAmount, address indexed feeRecipient);
event OperatorChanged(address indexed previousOperator, address indexed newOperator);
event SettlementRecorded(address indexed token, uint256 merchantAmount, uint256 feeAmount);
```
Index the fields an indexer must filter on (merchant, token, recipient). Emit `PayoutChanged` from `initPayout` too, so H-03's bypass would at least be visible.

**Test to add:** yes — `vm.expectEmit` on each new event, including the `initPayout` path.

---

### M-03 — `facilitatorFee` cannot be paid to a separate recipient

**Severity:** Medium
**Affected:** `X402Vault.withdrawAll` (`X402Vault.sol:68-89`)

**Description.** The specified model has **two** fee components — `x402GoFee` and `facilitatorFee` — which are distinct parties' revenue. The contract accepts one `feeAmounts` array and one `feeRecipient`, so a single withdrawal cannot pay both. Whatever the backend does, one of the two parties must be settled by a separate transaction, or the two fees must be conflated into one recipient (in which case someone is trusted to forward the other's share).

**Attack scenario.** If the fees are conflated and forwarded, the operator can simply never forward the facilitator's share — the same C-01 freedom, applied to a third party. If they are settled separately, the two withdrawals race for the same balance with no accounting to arbitrate (M-04).

**Impact.** The documented fee model is unimplementable as written; a revenue-sharing partner's funds are exposed to the operator in exactly the way C-01 describes.

**Why this implementation is vulnerable.** The parameter list was designed for a two-way split; the spec grew to three-way without the contract following.

**Recommended fix.** Generalise to N recipients, or add an explicit second recipient:
```solidity
address[] calldata feeRecipients,   // [x402Go, facilitator]
uint256[][] calldata feeAmounts     // or a flat array with an offset
```
Simpler and probably better: since both are x402Go-side revenues, set **both** as immutables on the factory, so neither is operator-chosen, and let the backend settle them separately against recorded balances (C-02). Confirm with the team which is intended.

**Test to add:** yes — once the shape is decided, assert each recipient receives exactly its share and that no caller-supplied address can divert either.

---

### M-04 — Withdrawal amounts are computed against a live balance with no snapshot

**Severity:** Medium
**Affected:** `X402Vault.withdrawAll` (`X402Vault.sol:68-89`), `tokenBalance` (`:91-93`)

**Description.** With no ledger (C-02), the operator must derive `merchantAmounts`/`feeAmounts` by reading `tokenBalance(token)` off-chain and splitting it. Between that read and the transaction landing, anything can change the real balance: a new x402 settlement arrives, an earlier withdrawal from another operator process confirms, or a rebasing token adjusts balances.

**Attack scenario.** Two operator processes (or a retry after a timeout) both read `balance = 1000`, both compute `merchant = 900, fee = 100`, and both submit. The first succeeds; the second reverts with `TransferFailed` — funds are safe, but observe the inverse case: if a settlement lands *between* the read and the tx, the operator withdraws based on a stale, smaller balance, and the new settlement's fee portion sits unwithdrawn and unaccounted until someone notices. With fee-on-transfer or rebasing tokens, the vault's balance never equals the sum of the recorded entitlements, so the off-chain ledger drifts permanently and unreconcilably.

**Impact.** Persistent reconciliation drift between the (nonexistent on-chain, off-chain-only) ledger and reality; a fee leg that silently under-withdraws; retries that revert. No direct theft, but it makes the accounting untrustworthy — which is the whole point of C-02's fix.

**Why this implementation is vulnerable.** Balance-derived accounting is inherently racy; entitlements must be *recorded*, not *recomputed*.

**Recommended fix.** This resolves itself once C-02 is fixed: with `merchantBalance`/`feeBalance` recorded per token, withdrawals decrement recorded entitlements instead of re-deriving them from a balance, and the operation becomes idempotent and order-independent. Additionally: (a) decide and document a policy for fee-on-transfer/rebasing tokens — the safest is to **not support them**, since `safeTransfer` cannot detect them; (b) treat any surplus balance over recorded entitlements as an explicit reconcilable state rather than silently sweeps.

**Test to add:** yes — a token that takes a transfer fee, asserting the behaviour is the documented one (revert or explicit surplus), and a test that two sequential partial withdrawals against recorded balances sum correctly.

---

### M-05 — Withdrawals cannot distinguish a token that lies about success

**Severity:** Medium
**Affected:** `X402Vault.withdrawAll` (`X402Vault.sol:86-87`)

**Description.** `SafeTransferLib.safeTransfer` verifies that the call succeeded and returned `true` (or returned nothing, with code present). It cannot verify that tokens actually moved. A token whose `transfer` returns `true` without changing any balance — malicious or merely broken — passes every check.

**Attack scenario.** The operator supplies a token address that reports success while moving nothing. The vault's books (once they exist) are decremented, the merchant is told they were paid, and no tokens moved. In a multi-token batch the other legs complete normally, so the batch looks successful.

**Impact.** Merchant under-payment that is undetectable on chain; corrupted accounting. Note the operator chooses the token list, so this is again within the operator-trust model rather than a separate escalation — but it means **the vault can never be the authority on whether a payment happened.**

**Why this implementation is vulnerable.** An inherent ERC-20 limitation, not a code defect. `SafeTransferLib` is doing the right thing; ERC-20 simply provides no success guarantee.

**Recommended fix.** Do not treat a successful `withdrawAll` as proof of settlement. Have the backend verify post-conditions: read `tokenBalance(vault)` and recipient balances before and after, and reconcile against the recorded entitlement delta. Combine with the allowlist recommendation in §5 — if only vetted tokens can be withdrawn, a lying token cannot enter the system. This is why the token allowlist is a correctness control, not just hygiene.

**Test to add:** yes — a `LyingToken` that returns `true` and moves nothing, asserting the vault accepts it (documenting the limitation) and that the recommended backend post-check catches it.

---

### M-06 — Missing chain-ID/factory binding in the signed struct is fine, but the domain has no versioning path

**Severity:** Medium
**Affected:** `X402Vault._domainNameAndVersion` (`X402Vault.sol:95-97`), typehash at `:14`

**Description.** The EIP-712 domain is `("X402Vault", "1")` with `address(this)` and `block.chainid` supplied by Solady. This is **correct** for replay protection — the test suite proves cross-vault, cross-factory, and cross-chain signatures are all rejected, and Solady invalidates its cached separator on chain-ID or address change (`EIP712.sol:292-297`). The gap is that nothing in the domain distinguishes **which version of the vault logic** a signature was intended for.

**Attack scenario.** If vault logic is ever replaced — a new implementation address behind the factory, or a migrated factory — a signature produced for the old contract at the same address and chain would remain valid against the new logic if the domain string and struct shape are unchanged. A signature collected for one semantic meaning could authorize a different one.

**Impact.** Latent. Only materialises if the implementation is ever upgraded or the struct is extended without changing the domain. The M-01 fix (adding `deadline`) changes the struct, which makes this concrete: **signatures produced before that change must not be valid after it.**

**Why this implementation is vulnerable.** Common and low-impact — the version string is a static "1" with no process behind it.

**Recommended fix.** Treat the domain version as a schema version and bump it whenever the signed struct or the verification logic changes. For M-01 specifically, either bump to `("X402Vault", "2")` or accept that the struct change already invalidates old signatures (it does — the digest differs). Document the rule so it is followed next time. Include the factory address if vaults may ever be migrated between factories.

**Test to add:** yes — a signature generated for version "1" must not be accepted by a contract reporting version "2" (extends the existing `test_domain_sameMerchantSignatureCannotCrossFactories` pattern).

---

### L-01 — One reverting or blocked token aborts the entire multi-token batch

**Severity:** Low
**Affected:** `X402Vault.withdrawAll` (`X402Vault.sol:82-88`)

**Description.** All legs execute in one loop in one transaction; the first failure reverts everything. The test suite confirms this deliberately (`test_withdrawAll_secondTokenFailureRollsBackFirst`) and treats atomicity as a feature. It is — for safety. But it also means a single unusable token blocks the batch.

**Attack scenario.** A settlement token with an address-level blocklist (USDC and USDT both have one) blocks the vault address. If the operator's off-chain logic uses a fixed token list, **every** withdrawal reverts — including for tokens that are perfectly fine. Funds are not lost, but the payout pipeline stalls entirely until the list is changed, and every gas cost is burned on reverting transactions.

**Impact.** Liveness degradation, not loss — the operator controls the array and can simply omit the blocked token. Worth a mitigation because the natural backend implementation (iterate all supported tokens) has exactly this failure mode.

**Why this implementation is vulnerable.** A single-transaction, all-or-nothing batch couples every token's fate to the worst-behaved one in the list.

**Recommended fix.** Keep atomicity (it is the safe default and prevents half-settled states), but: (a) have the backend build the batch from tokens with a **nonzero recorded entitlement** rather than a static list, which shrinks the blast radius naturally once C-02 is fixed; and (b) consider a `withdrawAll` variant that skips a per-token failure and reports it, if operational needs demand it — but only alongside the accounting, so a skipped leg is recoverable rather than lost. Do **not** add skip-and-continue without accounting: it would silently under-pay.

**Test to add:** yes — assert that a batch containing one blocked token reverts atomically **and** that omitting it succeeds, documenting the intended recovery.

---

### L-02 — No reentrancy guard and no checks-effects-interactions discipline

**Severity:** Low today, **Critical the moment accounting is added**
**Affected:** `X402Vault.withdrawAll` (`X402Vault.sol:82-88`)

**Description.** `withdrawAll` performs external calls in a loop with no `nonReentrant` modifier. This is **currently safe**, and the project's test `test_withdrawAll_reentrancyThroughTokenIsBlocked` proves why: a reentrant call from a token has `msg.sender == token`, which is not the operator, so it reverts `Unauthorized`. There is also no state to corrupt, so even a successful re-entry would accomplish nothing.

That safety is incidental, not designed. The function also violates CEI in the sense that there are no effects at all — the pattern to copy for safety simply is not established in the code.

**Attack scenario.** Today: none. After C-02 adds `merchantBalance[token] -= m`, a malicious token called in the merchant leg re-enters `withdrawAll` before the decrement lands, and drains again against the stale balance. The existing reentrancy test would not catch this, because it asserts the *old* failure mode (reverting via `Unauthorized`), and its mock does not attempt a re-entry as the operator.

**Impact.** None now; total loss of the accounting invariant once state is introduced. This is a sequencing hazard: the fix for C-01 and C-02 is what creates it.

**Why this implementation is vulnerable.** Statelessness is currently the only defense, and the fix removes statelessness.

**Recommended fix.** Add `ReentrancyGuard` (Solady ships one) **in the same change** that introduces accounting, and strictly follow CEI: decrement recorded balances *before* any `safeTransfer`. Do not add the guard alone and consider the matter closed — the CEI ordering is what actually protects the invariant.

**Test to add:** yes — a token that re-enters `withdrawAll` as the operator (via a mocked operator call path) and asserts the recorded balance cannot be double-spent.

---

### L-03 — Duplicate token addresses are accepted

**Severity:** Low
**Affected:** `X402Vault.withdrawAll` (`X402Vault.sol:82-88`)

**Description.** The same token may appear multiple times in `tokens`, each with its own amounts. The test suite asserts this works (`test_withdrawAll_sameTokenListedTwice`). It is not exploitable — the total must still fit the balance, and an over-draw reverts atomically — but it makes the batch harder to reason about and to reconcile, and it wastes gas on redundant external calls.

**Impact.** Confusion and gas, not loss. Combined with M-04's racy accounting it becomes one more way for the off-chain computation to diverge from what executed.

**Recommended fix.** Either reject duplicates (`if (i != 0 && token <= tokens[i-1]) revert UnsortedTokens();` requires a sorted input and is the cheapest correct check) or document explicitly that duplicates are permitted and how they combine. If the accounting fix lands, duplicates are naturally harmless because decrements are bounded by recorded balances.

**Test to add:** only if the behaviour changes; the current test already documents it.

---

### L-04 — `payout` may be set to any address, including a contract that cannot move tokens

**Severity:** Low
**Affected:** `X402Vault.changePayout` (`X402Vault.sol:49-61`); `createVault` (`X402VaultFactory.sol:31`)

**Description.** The only validation on the destination is `!= address(0)`. `test_createVault_payoutCanBeAContract` explicitly permits a token contract as the payout address — funds sent there would almost certainly be unrecoverable. The vault itself is also a permitted value, which merely self-transfers.

**Impact.** A merchant (or the operator, per H-02) can configure a payout that permanently loses funds on the next withdrawal. Self-inflicted or operator-inflicted; low severity because it requires setting a bad value.

**Recommended fix.** Irreducible in general — the contract cannot know whether an address can move tokens. Mitigate off-chain: the `PUT /payout` endpoint already rejects `address(0)` (`backend/src/utils/payTo.ts`); extend that validation to warn on contract addresses, and prefer EOA or known-good multisig destinations. Definitely fix H-02 so the operator cannot choose this for a merchant.

**Test to add:** no — the current behaviour is intentional and documented.

---

### L-05 — Signatures are malleable; the nonce neutralises it, but a signature is not a unique identifier

**Severity:** Low
**Affected:** `X402Vault.changePayout` (`X402Vault.sol:55`)

**Description.** Solady's `SignatureCheckerLib` **does not enforce low-s**, and says so at `SignatureCheckerLib.sol:23`: *"This implementation does NOT check if a signature is non-malleable."* The EOA path (`:98-105`) passes `(v, r, s)` straight to the `ecrecover` precompile with no half-order check, so for any valid signature `(r, s, v)` there is a second accepted signature `(r, n − s, v ^ 1)` recovering the same signer. The project's own test confirms this is real and accepted: `test_changePayout_malleableTwinCannotBeUsedToReplay` submits the twin and it **succeeds**.

This is *misleadingly named* — the twin does not "cannot be used", it is simply harmless because the nonce is consumed by whichever of the two lands first.

**Attack scenario.** No replay is possible: both forms share a digest, so the second submission fails on the nonce. The consequence is narrower — if anything ever treats a signature as a unique key (a dedup index, an idempotency key, a "has this been used" mapping keyed on signature bytes, an off-chain nonce cache), the two forms collide and defeat it. Note this differs from OpenZeppelin's `ECDSA`, which reverts on high-s; anyone porting OZ assumptions here will be wrong.

**Impact.** No fund loss. A trap for future code that assumes canonical signatures.

**Recommended fix.** Either accept the malleability and document it — accurate, since the nonce is what protects replay — or enforce low-s for canonicality:
```solidity
if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert InvalidSignature();
```
which requires decoding the signature rather than passing the blob through. Given M-01 already changes the digest, this is a reasonable moment to add it. **Do not** describe the current code as having malleability protection; it does not.

**Test to add:** yes, if low-s is enforced — the twin must revert. If not enforced, rename the existing test to state the actual property (the twin *is* accepted and is neutralised by the nonce), so it stops implying a guarantee that is not there.

---

### L-06 — Single-step factory ownership transfer

**Severity:** Low
**Affected:** `X402VaultFactory` (inherits Solady `Ownable`), exercised by `X402VaultFactory.t.sol:305-317`

**Description.** `transferOwnership` is single-step (exercised by `X402VaultFactory.t.sol:288`, `test_ownership_directTransfer`). A typo in the new owner address, or a transfer to an address that cannot transact, permanently removes the ability to call `setOperator` — which, combined with H-04, means the operator can never be rotated or restored, and every vault's funds are frozen.

**Impact.** Owner key management is the root of the entire operator system; a single fat-fingered transaction is unrecoverable. Note Solady *does* provide a two-step `requestOwnershipHandover`/`completeOwnershipHandover`, already tested at `X402VaultFactory.t.sol:302` (`test_ownership_twoStepHandover`) — so the safe pattern is available and simply not the documented path.

**Recommended fix.** Standardise on the two-step handover for ownership changes and document it in the deploy runbook; consider overriding `transferOwnership` to revert in favour of the handover flow. Because the owner controls the operator — and the operator controls all funds until C-01 is fixed — ownership changes deserve ceremony.

**Test to add:** no new test needed; prefer enforcing the handover path in code or documenting it.

---

### I-01 — The implementation contract reports a garbage `merchant()`, and funds sent to it are unrecoverable

**Severity:** Informational — *Confirmed with a live PoC*
**Affected:** `X402Vault.merchant()` (`X402Vault.sol:32-34`); `X402VaultFactory` constructor (`:20-23`)

**Description.** `merchant()` reads clone args from the contract's own bytecode via `LibClone.argsOnClone(address(this), 0, 20)`. On a clone that is correct. On the **implementation** contract — a normal, fully-formed `X402Vault` deployed at `X402VaultFactory.sol:22` — there are no appended args, so the call reads 20 bytes out of the implementation's own runtime code and returns them as an address. Captured live:

```
impl.merchant() : 0x7651146100Fe578063AffED0E014610106578063
impl.payout()   : 0x7651146100Fe578063AffED0E014610106578063
```

The value is visibly opcode bytes (`76 51` = `PUSH17`, `14 61` = `EQ PUSH2`), is non-zero, and is stable. It is **not** `address(0)`, so any reasoning of the form "the implementation falls back to the zero address and is therefore inert" is wrong.

Consequences: (a) `payout()` on the implementation returns that garbage address, so any tokens sent to the implementation address would be sent to a destination nobody controls — permanently lost; (b) `changePayout` on the implementation would require a signature from that garbage address, which is infeasible, so it cannot be taken over; (c) the classic `ecrecover`-returns-zero forgery is **not** reachable, because Solady returns `false` outright for a zero signer (`SignatureCheckerLib.sol:85`) — verified in the vendored source, not assumed.

The implementation is not protected by an initializer lock (the Solidity analogue of OpenZeppelin's `_disableInitializers()`), and the project's test suite asserts the factory *can* call `initPayout` on it (`X402VaultFactory.t.sol:42-50`).

**Impact.** No current exploit. The real risk is operational: the implementation address is publicly discoverable via `factory.implementation()`, and anyone who sends tokens to it — a copy-paste error, a misconfigured backend, an airdrop — loses them with no recovery path.

**Recommended fix.** (a) Document prominently that the implementation address must never receive funds, and add it to any monitoring/denylist. (b) Consider making the implementation safely inert: give it a `payout()` that reverts or explicitly returns zero, and revert `merchant()` when no clone args are present (e.g. check `extcodesize` against the expected clone length), so a mistake surfaces as a revert rather than a silent transfer to a garbage address. (c) When H-03 is addressed, ensure the implementation cannot be initialized at all.

**Test to add:** yes — assert that `merchant()` reverts (or returns `address(0)`) on the implementation, locking in whichever behaviour is chosen.

---

### I-02 — The vault is entirely unwired: the backend computes nothing and calls nothing

**Severity:** Informational (but critical context for deployment readiness)
**Affected:** the backend in its entirety

**Description.** A full survey of `backend/` establishes:

- **No fee computation.** `grossAmount`, `x402GoFee`, `facilitatorFee`, `recordSettlement` have **zero occurrences repo-wide**. No service, type, schema, or route produces a split.
- **No chain integration.** No `createVault`, `withdrawAll`, `initPayout`, `changePayout`, or `vaultOf` call. No RPC URL, no chain client, no factory/vault/USDC address configured in any env var or constant.
- **No EIP-712 signing.** No `signTypedData`, no `TypedDataEncoder`, no domain construction anywhere.
- **`OPERATOR_KEY` is dead.** `backend/src/utils/validateEnv.ts:8` requires it for the server to boot, and **no other line in the backend reads it**. The key is validated, then discarded. `CELO_FACILITATOR_API_KEY` is likewise set in `.env` and referenced nowhere.
- **No x402 payment code at all.** Despite the product name, there is no `/verify`, `/settle`, or facilitator client. `apiKeyAuth` exists but is mounted on no production route — its only consumer is a test probe (`backend/src/__tests__/apiKeys.test.ts:120-124`).

The only links between backend and contracts are **comments that say the link does not exist** — `backend/src/services/payout.service.ts:19-25` ("That check does not exist yet, so what is stored here is a preference, not an authority, and nothing that moves value may treat it as one until the vault is wired up") and `backend/src/docs/payout.yaml:64-70` ("This endpoint records an address and nothing else"). Those comments are accurate and commendably explicit.

**Impact.** The system cannot settle a payment, compute a fee, create a vault, or withdraw. Any vault deployed today holds funds that only a hand-run `cast` command could move. This also means C-01/C-02 are not yet *reachable in production* — which is the one piece of good news, and makes now the right moment to fix them, before the wiring exists to be exploited.

**Recommended fix.** Build the integration with the fixes in §5 already in place, not after. Specifically: a fee module that computes and *records* the split, an EIP-712 signer for `ChangePayout`, and an operator withdrawal service that reads recorded entitlements rather than live balances.

**Test to add:** yes — integration tests covering the full path from settlement report to withdrawal, asserting the recorded split matches the transferred amounts.

---

### I-03 — No architecture or flow documentation exists

**Severity:** Informational

**Description.** `contracts/README.md` is the unmodified Foundry boilerplate (it still references `script/Counter.s.sol`, which does not exist). `backend/README.md` is the unmodified Express template. The root `README.md` is two lines. There is **no document describing the settlement flow end to end** — the fee split, who funds the vault, when withdrawals happen, or what the operator is trusted to do. The closest statements are the two "not wired yet" comments cited in I-02, plus `frontend/README.md:108-111`.

**Impact.** The specification this audit was conducted against exists only in the audit brief. That is precisely how C-02 and H-01 arose: no written contract for what the code must guarantee, so nothing to check against. It is also why the H-01 divergence is genuinely ambiguous rather than a plain bug.

**Recommended fix.** Write a short `docs/settlement.md` stating: the fee formula and who sets the rate; the vault funding path; the operator's exact authorities and their bounds; the payout-change authorization model (resolving H-01); the withdrawal schedule and who triggers it; and the failure/recovery procedures for lost keys (H-04). This document should be the source the tests are written against.

---

### I-04 — Audit brief references OpenZeppelin; the project uses Solady

**Severity:** Informational

**Description.** The brief asks to inspect "OpenZeppelin dependencies" and refers to "OpenZeppelin ECDSA utilities". The project depends on **Solady** exclusively (`remappings.txt`: `solady/=lib/solady/src/`; only `forge-std/` and `solady/` exist in `lib/`). There is no OpenZeppelin in the dependency tree.

This is not merely a naming difference — the two libraries disagree on behaviour that matters:

| Behaviour | OpenZeppelin | Solady (this project) |
|---|---|---|
| High-s signatures | `ECDSA.recover` **reverts** | **Accepted** (`SignatureCheckerLib.sol:23`); harmless here only because of the nonce (L-05) |
| Zero signer | reverts | returns `false` (`SignatureCheckerLib.sol:85`) — closes the `ecrecover`-returns-zero forgery |
| `transfer` to codeless address | reverts | reverts (`SafeTransferLib.sol:346-350`) — same outcome |
| `transfer` returning `false` | reverts | reverts — same outcome |
| `transfer` returning nothing | succeeds if code present | succeeds if code present — same outcome |

**Impact.** None at runtime. The risk is reasoning: anyone applying OpenZeppelin assumptions to this code will conclude that signatures are non-malleable when they are not (L-05).

**Recommended fix.** Correct the brief/dependency documentation, and record the malleability difference explicitly so it is not re-litigated. The Solady choice itself is sound — it is well-audited, gas-efficient, and correct in the places that matter here.

---

### I-05 — The same operator private key sits in plaintext in two `.env` files

**Severity:** Informational

**Description.** `contracts/.env` sets `OPERATOR=0x402001B3fbf1462939657eb7f64EE3743eAdf35E` and `backend/.env` holds the corresponding `OPERATOR_KEY`. The same EOA is thus both the on-chain factory operator and the key the backend environment expects to hold. **Both files are correctly gitignored** (verified: `git check-ignore` matches `backend/.gitignore:72` and `contracts/.gitignore:18`; `git ls-files` shows only the `.env.example` files are tracked), so **no secret is committed**. This is an operational-hygiene note, not a leak.

**Impact.** The key is by definition the ability to drain every vault (C-01) and it lives on at least two developer machines. Compromise of either machine — or of the backend host, once the key is actually used — is total loss.

**Recommended fix.** Before mainnet: rotate the key (it has been on disk in development), hold the operator key only in the backend's secret manager (never in a developer's `contracts/.env` — the deploy script only needs `PRIVATE_KEY`, `OWNER` and `OPERATOR` *addresses*), and plan the split-key architecture in §5 so no single key can drain every vault.

---

### I-06 — No native-token (ETH) handling

**Severity:** Informational
**Affected:** `X402Vault` (no `receive`/`fallback`)

**Description.** The vault cannot receive or withdraw native ETH. Every path is ERC-20. On Celo (chain ID 42220, per `broadcast/.../42220/`), both native CELO and ERC-20 CELO/USDC exist, and the gas-currency abstraction means a user may well think in native terms.

**Impact.** None if settlement is ERC-20 only — which appears to be the intent. The risk is a settlement path that assumes the vault can receive native currency: those funds would be stuck, since there is no code path to move them.

**Recommended fix.** Document explicitly that the vault is ERC-20-only. If native settlement is ever required, add an explicit `receive()` plus a native withdrawal path — deliberately, with its own access control and events, not by accident.

---

## 4. Trust assumptions

The system's security rests on these assumptions. Each is stated with what breaks if it fails, because several are load-bearing today and should not be.

| # | Assumption | Holds today? | Consequence if violated |
|---|---|---|---|
| T1 | **The operator key is never compromised.** | Assumed, shared with the backend env, and stated by the brief as something to minimize | **Total loss of all merchant funds, silently, in one transaction** (C-01). The brief's requirement #9 is unmet. |
| T2 | The operator computes the settlement split honestly. | Unverifiable — nothing records or checks it | Merchants underpaid; x402Go over/under-collected. No on-chain evidence either way (C-02). |
| T3 | The operator sends fees to x402Go. | No — `feeRecipient` is a free parameter | Fees redirected to the operator, indistinguishable from correct operation (C-01). |
| T4 | The factory owner key is secure and available. | Single-step transfer, no ceremony (L-06) | Loss of the owner key means the operator can never be rotated (H-04). |
| T5 | The factory owner is honest and competent. | Single-step `setOperator`; `address(0)` accepted | A mistake or a malicious owner freezes all vaults permanently (H-04). |
| T6 | Merchant payout keys are secure. | Merchant is a SIWE browser hot wallet | Hot-key compromise redirects all future payouts — permanently, since the merchant keeps that authority forever (H-01). |
| T7 | Settled tokens are well-behaved ERC-20s. | `SafeTransferLib` handles the common quirks correctly | Fee-on-transfer/rebasing tokens break reconciliation (M-04); a lying token makes a "successful" withdrawal meaningless (M-05). |
| T8 | The rollout from `tokenBalance` to `withdrawAll` is not raced. | **No** — no snapshot, no ledger | Stale-split withdrawals and permanent reconciliation drift (M-04). |
| T9 | The backend behaves as its comments describe. | **No mechanism** — the code does not exist (I-02) | The "preference, not an authority" discipline in `payout.service.ts:19-25` is upheld only by developer memory. |
| T10 | Clone deployment via CREATE2 is safe. | **Yes** — verified | Nothing found. The pattern is correct; the gaps are H-03 and H-02, which are factory-level, not clone-level. |

**The assumption that most needs to change is T1.** Every other finding is downstream of "the operator can do anything to the money". Until C-01 and C-02 are fixed, this is not a vault system with an operator; it is a hot wallet with an operator.

---

## 5. Recommended architectural changes

The fixes below are ordered by dependency. Items 1–3 are prerequisites for holding real funds; the rest are hardening.

**1. Make the fee destination immutable and the split bounded (fixes C-01, M-03).**
Set the fee recipient(s) on the factory at deployment and expose them as immutables. Remove `feeRecipient` from `withdrawAll` entirely. The operator stops having any say in *where* money goes; it retains a say only in *how much*, bounded by item 2.

**2. Add a minimal on-chain ledger (fixes C-02, M-04, enables M-03).**
```solidity
mapping(address token => uint256) public merchantBalance;
mapping(address token => uint256) public feeBalance;

/// Operator-attested. Must not credit more than the vault actually holds.
function recordSettlement(address[] calldata tokens, uint256[] calldata merchantAmounts, uint256[] calldata feeAmounts) external onlyOperator {
    for (uint256 i; i < tokens.length; ++i) {
        merchantBalance[tokens[i]] += merchantAmounts[i];
        feeBalance[tokens[i]]     += feeAmounts[i];
        emit SettlementRecorded(tokens[i], merchantAmounts[i], feeAmounts[i]);
    }
    // Invariant: recorded entitlements may never exceed what the vault holds.
    // (Check per token, or reconcile against tokenBalance in a separate function.)
}
```
Withdrawals then decrement recorded balances instead of re-deriving from a live balance, which makes the operation idempotent and race-free. **Critical caveat:** because the operator authors these numbers, cap credits by observed holdings — otherwise the operator can mint entitlements and drain other merchants' real funds, which is worse than the current state, not better.

**3. Enforce the fee rate in code, not in calldata (fixes C-02's root cause).**
The only way to bound a compromised operator without a full redesign is to stop letting it choose the split. Have the operator report the **gross** amount, and let the contract compute the rest:
```solidity
uint256 fee = gross * feeBps / 10_000;   // feeBps immutable, set at deploy, capped (e.g. <= 1000)
merchantBalance[token] += gross - fee;
feeBalance[token]     += fee;
```
The operator can then inflate `gross` to steal the fee fraction — a bounded, detectable, and much smaller blast radius than 100%. This is the single most effective blast-radius reduction available without moving withdrawal authority to the merchant.

**4. Give the merchant a withdrawal path (fixes H-04's severity).**
`withdrawToMerchant(tokens)` gated on `msg.sender == merchant()`, paying to `payout()` and bounded by `merchantBalance`. The owner of the funds should always be able to recover them. This converts "lost operator key = permanent loss" into an operational inconvenience, and is the cheapest high-value change in this report.

**5. Bind vault creation's payout to the merchant (fixes H-02).**
Create every vault with `payout = merchant` and delete the parameter. The only route to a different payout becomes a signed `changePayout` — which also makes H-03's bypass unreachable in practice.

**6. Resolve the payout-authorization model (fixes H-01).**
Decide, document, and test: merchant authority (current code, recommended, plus M-01's deadline) or previous-payout authority (the brief). Whichever is chosen, the frontend's onboarding copy and the backend's comments must agree with it.

**7. Harden the signature scheme (fixes M-01, L-05, M-06).**
Add `deadline` to the struct, bump the domain version, and decide on low-s enforcement. Add an event on every payout change.

**8. Add events and a reentrancy guard (fixes M-02, L-02).**
Events on `PayoutChanged`, `Withdrawn`, `OperatorChanged`, `SettlementRecorded`. Introduce `ReentrancyGuard` **in the same change as item 2** and follow strict CEI ordering — the guard without the ordering is not sufficient.

**9. Allowlist settlement tokens (fixes M-05, mitigates M-04, L-01).**
An owner-managed token allowlist bounds the damage of a lying or hostile token, makes M-05's verification gap tractable (only vetted tokens can enter), and lets the backend drop blocked tokens from batches safely.

**10. Split the operator role (reduces T1's blast radius further).**
Once items 1–3 exist, consider separating the *settlement recorder* from the *withdrawer*, so a compromised key can only do one of the two. This is optional hardening; items 1–3 are the priority.

**Also:** add a zero-address check and an event to `setOperator` (H-04), make `initPayout` one-shot or delete it (H-03), and document the ERC-20-only and implementation-address constraints (I-01, I-06).

---

## 6. Recommended tests

The existing suite is strong on the mechanics that already work. These target what it does not cover — each maps to a finding above.

**Regression tests for the confirmed PoCs** (the four PoC tests invert directly):

1. `withdrawAll` with `feeAmounts` exceeding `feeBalance` reverts; the fee leg can only reach the immutable fee recipient (C-01).
2. A signature from the *current payout* address and from the *merchant* — exactly one must be accepted, per the decision in H-01. Assert both directions.
3. `createVault` by the operator for a third-party merchant yields `payout() == merchant`, or reverts (H-02).
4. `setOperator(address(0))` reverts; after the operator is unset by other means the merchant can still recover funds (H-04).

**Accounting invariants (new, once item 2 of §5 lands):**

5. `grossAmount == merchantAmount + x402GoFee + facilitatorFee` holds for every recorded settlement, fuzzed over amounts and token counts.
6. A settlement report that would credit more than the vault holds reverts (C-02).
7. Recorded entitlements never exceed actual holdings: `merchantBalance[t] + feeBalance[t] <= tokenBalance(t)`, as a fuzz invariant across arbitrary settlement/withdrawal interleavings.
8. Two sequential partial withdrawals against recorded balances sum correctly and cannot exceed the entitlement (M-04).

**Signature scheme:**

9. A `ChangePayout` with `deadline < block.timestamp` reverts; the boundary case at exactly `deadline` succeeds (M-01).
10. If low-s is enforced, the malleable twin reverts; if not, rename the existing test to state the real property instead of implying a guarantee (L-05).
11. A version-1 signature is rejected by a version-2 contract (M-06).

**Tokens and reentrancy:**

12. A `LyingToken` returning `true` while moving nothing — document the accepted behaviour and assert the recommended post-withdrawal balance check catches it (M-05).
13. A token that re-enters `withdrawAll` *as the operator* cannot double-spend a recorded balance (L-02). This is the test the current reentrancy mock does not attempt.
14. Fee-on-transfer and rebasing tokens behave as documented — revert or explicit surplus (M-04).

**Event and access control:**

15. `vm.expectEmit` on `PayoutChanged`, `Withdrawn`, `OperatorChanged`, including the `initPayout` path (M-02), closing the "silent privileged action" gap.
16. A second `initPayout` reverts; the implementation contract's `merchant()` reverts or is zero (H-03, I-01).

**Integration (once I-02 is addressed):**

17. End-to-end: settlement report → recorded split → withdrawal → recipient balances match the recorded amounts exactly.
18. A batch containing one blocked/reverting token reverts atomically, and omitting that token succeeds (L-01).

Additionally, the existing test at `X402Vault.t.sol:318` (`test_changePayout_malleableTwinCannotBeUsedToReplay`) should be renamed — the twin **is** accepted; the correct claim is that the nonce neutralises it.

---

## 7. Gas optimization recommendations

Blunt assessment first: **gas is not this project's problem.** The code already uses calldata arrays, immutable factory, packed storage, custom errors, cached locals, and `++i`. The measured profile is good — vault creation ~90–98k gas, the whole `X402Vault` runtime is 3,623 bytes against a 24,576-byte limit, and the withdrawal loop makes only the external calls it must. Optimizer runs are set to 1,000,000, which is appropriate for a hot-path contract.

The one thing worth saying loudly: **do not optimize at the expense of the fixes above.** Adding the ledger costs storage reads and writes; adding events costs ~375 gas each. Both are correct trades. Everything below is a micro-optimization worth less than a fraction of one event.

1. **`unchecked { ++i; }` in the withdrawal loop** (`X402Vault.sol:82`). Solidity 0.8 emits an overflow check per iteration even though `len` bounds it. Saves roughly 30–40 gas per token. Safe: `i < len` and `len` is a calldata length.
2. **`IX402VaultFactory(FACTORY).operator()` is a cold external call per withdrawal** (`X402Vault.sol:74`). At ~2,600 gas it dominates small withdrawals. It cannot be made immutable without breaking operator rotation (which `test_withdrawAll_operatorRotationTakesEffectOnExistingVaults` correctly requires). If it ever matters, the factory could push the operator into vaults on rotation — but that reintroduces the H-03 class of privileged write path, and gas is not worth that trade. **Recommend leaving it as is.**
3. **`merchant()` costs an `extcodecopy` on every `changePayout` and on every `payout()` fallback.** Cheap in absolute terms and correct given the clone design (it is what makes the merchant an immutable arg with no storage cost). No change recommended.
4. **`payout()` performs one SLOAD and falls back to `merchant()` only when storage is empty**, so the common `payout == merchant` case costs nothing extra. Already optimal — and `test_storage_defaultVaultSlotIsEmpty` locks it in.
5. **Deduplicating tokens** (L-03) would save redundant external calls in a batch, but only if the backend ever sends duplicates; the check costs more than it saves for the normal case.
6. **The clone deployment path is already efficient** (~90k) and the pre-check at `X402VaultFactory.sol:38-40` is a genuine gas *saving* on the collision path, correctly justified in its comment. Keep it.
7. **Batching fee recipients** (M-03's fix) will add a loop; if it lands, keep the arrays flat and calldata to avoid the nested-array decoding cost.

---

## 8. Direct answers to the audit questions

**Can a compromised operator wallet steal merchant funds?**
**Yes — all of them, in one transaction, with no signature and no on-chain trace.** `feeRecipient` is an operator-supplied parameter and `feeAmounts` is unconstrained calldata, so the operator labels the entire vault balance "fees" and sends it to itself. Confirmed by a passing PoC (C-01). This directly fails requirement #9. It is the most severe finding in this report, and unlike most of the others it requires no cleverness at all — just a malicious parameter.

**Can the operator redirect funds to an arbitrary wallet?**
**Yes, two ways.** (a) The `feeRecipient` parameter on every withdrawal (C-01). (b) By creating a vault for a merchant with an attacker-chosen `payout`, which `createVault` writes directly via `initPayout` with no signature, and which the deterministic address makes permanent for that merchant (H-02). Both confirmed by PoC.

**Can a malicious user initialize or take control of a clone?**
**No.** `initPayout` requires `msg.sender == FACTORY`, and the factory exposes no external path to it — its only call site is inside `createVault`, on a clone it just deployed. `changePayout` requires a valid EIP-712 signature from `merchant()`. A stranger cannot deploy at the deterministic address (only the factory's CREATE2 can), and `VaultExists` prevents re-creation. The implementation contract cannot be taken over either: its `merchant()` resolves to a garbage bytecode-derived address (verified: `0x7651146100Fe578063AffED0E014610106578063`) that nobody holds a key for, and Solady returns `false` for a zero signer so `ecrecover`-returns-zero is not reachable.

The caveats are **H-03** (the `initPayout` primitive is an unguarded, un-evented, non-one-shot privileged setter that bypasses the signature model — inert today, catastrophic if the factory ever forwards to it) and **H-02** (the *operator* can control a vault's payout at creation — which is a privileged user, but it is control without a signature). `initPayout` should be made one-shot or removed.

**Can payout-change signatures be replayed?**
**No, not to change state.** The nonce is read, used in the digest, and incremented atomically in the same transaction, so a replayed signature fails. The EIP-712 domain binds `address(this)` (the specific clone) and `block.chainid`, and Solady invalidates its cached separator when either changes — so cross-vault, cross-factory, and cross-chain replay are all blocked. The suite proves each case (`test_changePayout_replayReverts` `:224`, `test_changePayout_oldSignatureCannotRevertLaterChange` `:231`, `test_domain_signatureNotValidOnOtherVault` `:133`, `testFuzz_changePayout_chainIdBinding` `:782`, `testFuzz_changePayout_isolatedPerVault` `:794`), and I confirmed the underlying Solady behaviour in source rather than taking the tests' word for it.

Two qualifications. First, **signatures are malleable** — Solady does not enforce low-s (`SignatureCheckLib.sol:23`), and the project's own test confirms the high-s twin is *accepted*, not rejected; it is harmless only because the nonce is consumed by whichever variant lands first. Do not rely on signature bytes as a unique identifier. Second, **there is no expiry** (M-01): a signature stays executable indefinitely until its nonce is consumed, and anyone may relay it, so a leaked stale signature is a live liability.

**Can settlement accounting be fabricated?**
**There is no settlement accounting to fabricate — and that is the finding.** `grossAmount`, `merchantAmount`, `x402GoFee`, `facilitatorFee` and `recordSettlement` occur **zero times** in the entire repository, and no backend code computes a split. The amounts in `withdrawAll` are unvalidated calldata with nothing to check them against. So yes, trivially and by construction: the operator asserts the split, and the contract believes it. Note the question implies a `recordSettlement()` exists with a mint-accounting risk — **it does not exist**; if one is added per §5, the specific hazard to guard is that it must not credit balances exceeding actual holdings, or it becomes strictly worse than today.

**Can merchant and fee balances ever become inconsistent?**
**They do not exist as balances, so there is nothing to keep consistent — which is the same defect.** On chain, only transfers are recorded, not entitlements, so there is no invariant that *could* be violated and none that can be checked. Off chain, the derived ledger drifts in three documented ways: withdrawal amounts computed from a live balance with no snapshot (M-04); fee-on-transfer and rebasing tokens, which make holdings permanently unequal to recorded sums; and a multi-token batch that reverts wholesale, leaving earlier legs unexecuted. There is also no reconciliation view — `tokenBalance` reports holdings, never entitlements, so a merchant cannot even ask what they are owed.

**Can a malicious ERC-20 token break withdrawals?**
**It cannot break the vault, steal other tokens, or make it pay when it should not.** Solady's `safeTransfer` rejects reverting tokens, false-returning tokens, *and* codeless addresses (`SafeTransferLib.sol:346-350`) — I verified this in source, and the suite covers all three. Batches are atomic, so a failed leg rolls back cleanly; reentrancy is inert because a token's re-entry arrives as a non-operator `msg.sender` and reverts.

Residual, and genuinely narrower than the question implies: **(a)** a token that returns `true` while moving nothing is indistinguishable from a working one — an inherent ERC-20 limitation, not a bug (M-05); **(b)** one reverting or blocklisted token aborts the whole batch, which is a liveness annoyance the operator can route around by splitting the batch (L-01); **(c)** fee-on-transfer and rebasing tokens silently break the off-chain reconciliation (M-04). An owner-managed token allowlist is the right mitigation for (a)–(c).

**Is the minimal-proxy implementation safe?**
**Yes — the clone mechanics are the strongest part of this codebase.** `LibClone.cloneDeterministic` with appended immutable args, `FACTORY` as a genuine immutable (reading the implementation's value, correct under delegatecall), deterministic CREATE2 addresses with a cheap pre-check that avoids burning all gas on collision, per-clone EIP-712 domains, and a `merchant()` that correctly reads clone args. The tests confirm arg decoding, per-vault isolation, and cross-factory address separation.

Two gaps, neither in the proxy mechanics themselves: **H-03**, the missing one-shot guard on `initPayout` (an un-evented privileged setter that bypasses signatures), and **I-01**, the lack of protection on the implementation contract — its `merchant()` returns a garbage bytecode-derived address rather than reverting, so funds sent there are lost, though it cannot be taken over. Fix both before mainnet; neither requires changing the clone pattern.

**Is the current architecture appropriate for handling real funds?**
**No.** Three independent blockers, in order:

1. **The fee destination is operator-chosen and the split is unenforced**, so a single key compromise is total, silent loss across every vault (C-01, C-02). Requirement #9 is unmet in full.
2. **The merchant has no way to withdraw their own funds under any circumstances** — and the operator that can can also be permanently disabled by one bad `setOperator` call, freezing every vault forever (H-04).
3. **Nothing is wired up.** The backend computes no fee, signs nothing, calls no contract, and never reads its own `OPERATOR_KEY`. There is no chain client and no contract address configured (I-02).

Point 3 is the silver lining: the vulnerabilities are not yet reachable in production, so the fixes can land before the integration does. Fix items 1–4 of §5 — immutable fee recipient, recorded ledger with bounded credits, code-enforced fee rate, and a merchant withdrawal path — and this becomes a defensible design. Ship it in the current form and the first operator compromise or owner mistake is unrecoverable.

---

## 9. Prioritized changes before mainnet

**Blockers — do not deploy with real funds until these are done.**

| # | Change | Finding | Effort |
|---|---|---|---|
| 1 | Remove `feeRecipient` from `withdrawAll`; make the fee recipient(s) immutable on the factory | C-01 | Small |
| 2 | Add `merchantBalance`/`feeBalance` per token; cap every withdrawal leg by the recorded balance; add `ReentrancyGuard` **and** strict CEI ordering in the same change | C-02, M-04, L-02 | Medium — the core work |
| 3 | Enforce the fee rate in code from an operator-reported gross (`feeBps` immutable, capped); never let the operator choose the split | C-02 | Medium |
| 4 | Add a merchant withdrawal path gated on `msg.sender == merchant()` | H-04 | Small |
| 5 | Create every vault with `payout = merchant`; delete the `payout` parameter, or require `msg.sender == merchant` when it differs | H-02 | Small |
| 6 | Add `if (newOperator == address(0)) revert InvalidAddress();` to `setOperator` | H-04 | Trivial |
| 7 | Guard `initPayout` one-shot, or delete it in favour of a clone arg | H-03 | Small |
| 8 | Resolve the payout-authorization model (merchant vs previous payout) and make code, brief, backend comments and frontend copy agree | H-01 | Decision, then small |

**Strongly recommended before mainnet.**

| # | Change | Finding |
|---|---|---|
| 9 | Add `deadline` to `ChangePayout`; bump the domain version | M-01, M-06 |
| 10 | Emit `PayoutChanged`, `Withdrawn`, `OperatorChanged`, `SettlementRecorded` | M-02 |
| 11 | Owner-managed settlement-token allowlist | M-05, M-04, L-01 |
| 12 | Decide and document the fee-recipient shape for `facilitatorFee` vs `x402GoFee` | M-03 |
| 13 | Rotate the operator key; hold it only in the backend secret manager, never in a developer `contracts/.env` | I-05 |
| 14 | Write `docs/settlement.md` — the flow spec the tests are written against | I-03 |

**Recommended.**

| # | Change | Finding |
|---|---|---|
| 15 | Decide on low-s enforcement; rename the misleading malleability test either way | L-05 |
| 16 | Make the implementation contract inert (`merchant()` reverts without clone args) | I-01 |
| 17 | Standardise on two-step ownership handover for the factory | L-06 |
| 18 | `unchecked { ++i; }` in the withdrawal loop | Gas |
| 19 | Document ERC-20-only and the implementation-address warning | I-06, I-01 |
| 20 | Correct the OpenZeppelin references in the brief/deps; record the Solady malleability difference | I-04 |

**Suggested sequencing:** items 1–8 together as one change (they are interdependent — 2 and 5 both touch `createVault`/`withdrawAll`, and 8 determines what the tests in 1–7 must assert), with the §6 regression tests landing alongside. Then 9–14. Then build the backend integration (I-02) **against** the fixed contracts, not before.

---

*Audit conducted without modifying any contract source. The temporary PoC test file was executed against the working tree and removed afterwards.*

*Working-tree state, recorded for transparency: `git status` shows the audit's own addition (`contracts/AUDIT.md`, untracked) plus changes that were already present before the audit began and are **not** logic changes — a `[fmt]` section added to `foundry.toml`, `forge fmt` reflow of the test files (multi-line signatures joined; verified by test-function count, `X402Vault.t.sol` 92 → 92 and `X402VaultFactory.t.sol` 46 → 46, so no test was removed), trailing-whitespace trims in the deploy script, and NatSpec comments in the two `src/` files. A whitespace-ignoring diff of `contracts/src/` yields no code change beyond a single `}` line-ending artifact, so no contract behaviour differs from `HEAD`.*
