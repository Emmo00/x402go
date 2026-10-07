# x402Go Smart Contract Security Audit — Post-Blueprint

**Date:** 2026-10-07
**Scope:** `contracts/src/**`, `contracts/script/**`, `contracts/test/**`, `contracts/foundry.toml`, and the x402Go backend/frontend as they relate to on-chain settlement.
**Artifacts:** `X402Vault.sol` (4,021 B runtime), `X402VaultFactory.sol` (3,182 B runtime), `IX402VaultFactory.sol`, `DeployX402VaultFactory.s.sol`, 167 tests.

**Predecessor:** `AUDIT-pre-blueprint.md` audits the *previous* revision (`withdrawAll`, operator-supplied `feeRecipient`, no operator event). Several of its findings are fixed here; this report re-derives everything against the current bytecode rather than inheriting conclusions. **Finding IDs are not comparable between the two files** — each audit numbers its own findings, and both happen to contain a `C-01`. Where this report refers to the predecessor it says so explicitly.

**Finding IDs** encode severity: `C-` Critical, `H-` High, `M-` Medium, `L-` Low, `I-` Informational. 23 findings in total.

**Method:** full source review of both contracts; review of all 167 tests and the gas snapshot; review of the vendored Solady primitives actually reached (`LibClone`, `SignatureCheckerLib`, `SafeTransferLib`, `EIP712`, `Ownable`) with the exact code paths quoted; a survey of the backend and frontend for any on-chain integration; inspection of the Foundry broadcast artifact; a size-differential build to test EVM-version assumptions. **No contract, test, or script was modified during this audit** — the only writes were: preserving the previous report as `AUDIT-pre-blueprint.md`, and writing this file.

---

## 0. The brief's premises vs. the code as it actually is

Four premises in the brief do not hold. Each changes an answer, so they are stated up front rather than buried.

| Brief says | Reality | Consequence |
| --- | --- | --- |
| "OpenZeppelin dependencies", "OpenZeppelin ECDSA utilities" | **No OpenZeppelin anywhere.** `remappings.txt` and `lib/` contain only `solady/` and `forge-std/`. Verified: zero matches for `openzeppelin` in `src/`, `test/`, `script/`, `foundry.toml`, `remappings.txt`. | Audit target is **Solady v0.1.26** (`v0.1.26-36-g2afba69`). Materially, Solady's signature checker **does not enforce low-s**, where OZ's `ECDSA.recover` does. See M-04. |
| Requirement 6 / area 10: "`withdrawAll`" | Renamed to **`withdraw(tokens, merchantAmounts, feeAmounts)`** before this audit. `withdrawAll` appears nowhere in code, tests, or `.gas-snapshot`. | Audited under its current name. |
| Requirement 7 / area 2: "signature from the **previous payout address**" | The contract verifies **`merchant()`** — the address baked into the clone's immutable args — permanently. `payout()` is a separate mutable value and never signs. | **Requirement 7 is not met as written.** The client has since confirmed the merchant is the intended signer, so the *implementation* is correct and the *requirement* is stale. This is a hard fork in the threat model: the merchant key is a permanent, non-revocable authority over every future payout (M-03). |
| Area 4: "the backend calculates grossAmount, merchantAmount, x402GoFee, facilitatorFee" | **The backend calculates nothing.** There is no x402 middleware, handler, or paywall; no 402 response; no chain client, RPC URL, contract address, or ABI; and `grossAmount`, `merchantAmount`, `x402GoFee`, `facilitatorFee`, `recordSettlement` occur **zero times** outside the previous audit document. | "Consistency with the backend architecture" is currently **vacuous — there is nothing to be consistent with.** The split exists only as operator-supplied calldata. See H-04. |

`recordSettlement()` **does not exist**. There is no on-chain accounting of any kind, so the brief's question about it minting balances is answered below in the negative — with the caveat that the *absence* is the finding.

---

## 1. Executive summary

The vault mechanics are the strongest part of this codebase and are, in isolation, well built. The clone architecture is textbook: `merchant` is immutable in clone bytecode, `FACTORY` is immutable in the implementation so one operator rotation reaches every vault, the address is args-bound CREATE2 and therefore cannot be squatted, and initialization is atomic with deployment. The EIP-712 layer is correct — per-vault domain, chain-ID binding, deadline, and a consumed nonce. The 167-test suite is disciplined, and the pre-blueprint audit's critical finding (its own C-01: the operator naming an arbitrary fee sink) is genuinely fixed by making the fee leg structurally unreachable by the operator.

**The problem is no longer where money goes. It is who decides whether it leaves at all, and where it lands the first time.**

Two Critical/High paths remain, and both are consequences of the same design choice — that the **operator chooses the payout at vault creation** and the **operator alone decides the split and timing of every withdrawal**:

1. **The operator can steal a merchant's funds outright.** The operator may call `createVault(victim, attackerPayout)`. `initPayout` then runs *inside* that call, and because `payout()` is what `withdraw` pays, every subsequent withdrawal routes the merchant's money to the attacker. The vault address is public and predictable (`vaultOf`), so payments can be flowing into it before the merchant ever learns it exists. This is not a subtle composition — it is three ordinary calls.
2. **The operator can confiscate the merchant's funds without naming a payout at all**, by setting `merchantAmounts[i] = 0` and `feeAmounts[i] = balance`. The whole balance goes to the factory, reachable only by the owner. From the merchant's side the loss is identical.

Both are unaffected by the immutable fee recipient, because neither needs to *redirect* fees — the fee leg is a legitimate destination that the operator controls the *size* of.

Underneath both sits a structural gap: **the contract has no idea what any merchant is owed.** It keeps no balance, records no settlement, and validates no split. It transfers exactly the two arrays it is handed. The invariant `grossAmount = merchantAmount + x402GoFee + facilitatorFee` is enforced nowhere — not on chain, and not in the backend, which has no settlement code at all. Solvency and correctness are therefore properties of the operator's honesty, not of the contract.

There is also no merchant exit. A merchant has no function they can call to recover their own funds. If the operator stops cooperating, the funds sit in the vault indefinitely; the owner can rotate the operator, but if the owner key is lost or `renounceOwnership()` is called, they are frozen permanently.

**Verdict: the vault and signature layers are sound; the money model is not. As deployed today, "merchant funds are safe from the operator" is false, and there is nothing on chain to contradict anything the operator does.** The single highest-value change is one line of intent — the operator must never be able to choose a payout for someone else's vault.

---

## 2. Overall security assessment

| Property | Status |
| --- | --- |
| Clone isolation between merchants | **Sound.** One vault per merchant, args-bound salt, no cross-vault write path. |
| Initialization safety | **Sound.** Factory-gated and atomic with deployment; no race, no squatting. |
| Payout-redirect resistance (post-creation) | **Sound.** Only the merchant key can move `payout`; the operator and owner cannot. |
| Signature scheme (binding, replay, expiry) | **Sound.** Per-vault domain, chain ID, new payout, nonce, deadline. |
| Signature uniqueness (malleability) | **Weak.** High-s twins and EIP-2098 forms are accepted; the nonce makes it harmless, but a signature is not a unique identifier. |
| Operator cannot redirect merchant funds | **Broken at creation time.** The operator picks the payout when it creates the vault. |
| Operator cannot take merchant funds | **False.** Two independent paths (C-01, H-02). |
| Merchant can always recover own funds | **False.** No merchant-callable path exists. |
| On-chain accounting enforced | **Absent by design.** No record, no bound, no validation. |
| Fee destination immutable *within a vault* | **Sound.** Structural, not a parameter. |
| Fee destination at the factory | **Owner-chosen at sweep time**, and **unlogged**. |
| Atomicity of a withdrawal | **Sound.** One loop, one transaction, any failure reverts everything. |
| Token-handling safety | **Sound at the transfer layer** (Solady rejects no-code, false-returning and reverting tokens), **unbounded at the policy layer** (no allowlist). |
| Reentrancy | **No exposure today** — there is no state to corrupt. The risk is latent and arrives with any on-chain accounting. |
| DoS resistance | **Weak.** The operator can censor withdrawals indefinitely; nobody else can act. |
| Deployment readiness | **Blocked.** `evm_version` unpinned and the default build emits Cancun-era opcodes; the recorded Celo artifact is for the previous factory. |

---

## 3. Findings

### C-01 — Critical — The operator can create a merchant's vault with an arbitrary payout and drain every payment to it

**Affected:** `X402VaultFactory.createVault` (`X402VaultFactory.sol:33-54`), `X402Vault.initPayout` (`X402Vault.sol:49-54`), `X402Vault.withdraw` (`X402Vault.sol:92-111`).

**Description.** `createVault(merchant, payout)` authorizes `msg.sender == operator` and accepts **any** `payout` for **any** `merchant`:

```solidity
if (msg.sender != merchant && msg.sender != operator) revert Unauthorized();
...
if (payout != merchant) X402Vault(vault).initPayout(payout);   // :51
```

The operator then calls `initPayout` on the vault it just created, with no merchant involvement. The vault's `withdraw` pays `payout()`:

```solidity
address to = payout();                                        // :100
address m = merchant();
if (mAmount != 0) SafeTransferLib.safeTransfer(token, to, mAmount);
```

The vault address is deterministic and *published before creation*: `vaultOf(merchant)` is a `view` function that works on undeployed addresses, and it is the natural thing for a backend to poll.

**Attack scenario.**
1. Operator (compromised key) computes `v = factory.vaultOf(victim)` — a public, deterministic address.
2. Operator calls `factory.createVault(victim, attackerPayout)`. Passes the `operator` check; `initPayout(attackerPayout)` runs inside the same transaction.
3. Payments for `victim` land in `v` — either because the backend had already provisioned `payTo = v`, or because the operator is the party that tells the backend which address to use.
4. Operator calls `X402Vault(v).withdraw([token], [balance], [0])`. Every token goes to `attackerPayout`.
5. The merchant's only defence is to call `changePayout` with their own key *before* step 4 — but nothing tells them the vault exists, and the operator controls the timing.

**Impact.** Total, irreversible loss of all merchant funds in that vault. The attacker needs only the operator key; the owner key is not required.

**Why the current implementation is vulnerable.** Payout authority is *initialized by the party that may be an attacker*. The merchant signature requirement exists only on the *change* path (`changePayout`), never on the *creation* path. `createVault` conflates two different privileges: "create the vault" (a convenience the platform legitimately performs on a merchant's behalf) and "choose where the merchant's money goes" (a privilege that must never be the platform's).

**Recommended fix.** Do not let the operator choose a payout for someone else's vault. The minimal change:

```solidity
if (msg.sender == merchant) {
    // self-service: any payout, the merchant authorized it by calling
} else {
    // operator: only the merchant's own address may be the initial payout
    if (payout != merchant) revert Unauthorized();
}
```

A vault whose payout differs from the merchant then requires the merchant's own `changePayout` signature, which is already implemented and already correct. If operator-provisioned custom payouts are genuinely needed at onboarding, require a merchant EIP-712 signature over the initial payout — reusing `CHANGE_PAYOUT_TYPEHASH` with `nonce == 0` works, since `initPayout` is one-shot and a signature for `nonce 0` is exactly a signature for the initial state.

**Test to add:** yes, and it is the most important test in this report. A test that plays the five steps above end-to-end and asserts the funds **cannot** reach `attackerPayout` — i.e. that step 2 reverts.

---

### H-01 — High — The operator can confiscate 100% of a vault's balance into the fee pool

**Affected:** `X402Vault.withdraw` (`X402Vault.sol:92-111`).

**Description.** Every element of both amount arrays is caller-supplied and unvalidated. There is no cap, no ratio, no recorded entitlement, and no relationship between the two legs:

```solidity
uint256 mAmount = merchantAmounts[i];
uint256 f = feeAmounts[i];
if (mAmount != 0) SafeTransferLib.safeTransfer(token, to, mAmount);
if (f != 0) SafeTransferLib.safeTransfer(token, FACTORY, f);
```

**Attack scenario.** Operator calls `withdraw([usdc], [0], [vaultBalance])`. The entire balance transfers to the factory. The merchant receives nothing. The funds are then held by the factory, where only the owner can release them via `withdrawFees`.

**Impact.** The merchant loses access to 100% of their funds. Unlike C-01 the destination is a known, owner-controlled address rather than an attacker address, so this is *appropriable* if the owner is honest and responsive — it is a confiscation rather than a theft. **In a small-team deployment where the operator and owner keys are held by the same party — the likely production arrangement — this collapses into C-01-level severity.** Note also that the fee leg is *legitimate*: nothing in the calldata is malformed, so no monitoring based on transaction shape can flag it. Only a human comparing the merchant's expected payout against their actual one would notice.

**Why the current implementation is vulnerable.** Making the fee *destination* immutable fixed where fees can go; it did nothing about *how much* can be declared as a fee. The operator's control over the split is the residual, and it is unlimited.

**Recommended fix.** Bound the fee leg. Any of:
- a per-vault immutable or owner-set `maxFeeBps` enforced as `feeAmounts[i] * 10_000 <= (merchantAmounts[i] + feeAmounts[i]) * maxFeeBps`;
- an owner-set absolute per-token ceiling;
- an on-chain entitlement record (see §5.3) so `withdraw` is bounded by a recorded balance rather than by calldata;
- most simply and most robustly, **a merchant-signed split** — the merchant signs `(vault, token, merchantAmount, feeAmount, nonce, deadline)` and the operator merely submits it. That reuses the machinery `changePayout` already has and makes the operator structurally unable to misstate the split.

**Test to add:** yes — `withdraw` with `merchantAmount = 0` and `feeAmount = fullBalance` must revert, or (if a cap is adopted) must be clamped.

---

### H-02 — High — No merchant-callable withdrawal: the operator can censor indefinitely, and key loss is permanent

**Affected:** `X402Vault.withdraw` (operator-gated, `X402Vault.sol:95`); absence of any merchant path.

**Description.** The only entity that can move money out of a vault is `IX402VaultFactory(FACTORY).operator()`. A merchant has no function to recover their own funds. The owner's `setOperator` is the only recovery lever, and `renounceOwnership()` destroys it.

**Attack scenario / failure modes.**
- *Censorship:* a compromised or merely unavailable operator simply never calls `withdraw`. Merchant funds accumulate and are unreachable. There is no time-based escape hatch, no challenge window, no merchant override.
- *Loss:* the operator key is lost. Recovery requires the owner to call `setOperator`. If the owner key is also lost — or if `renounceOwnership()` was called (permitted by Solady `Ownable`, `renounceOwnership` at `Ownable.sol:185-188`, which sets the owner slot to zero with no guard) — **every vault's balance is frozen forever.** The project's own test `test_ownership_renounceBricksOwnerActionsButKeepsOperator` documents the trigger.
- *Compromise of the owner instead:* the owner rotates in an attacker operator, who then executes C-01 or H-01. `OperatorChanged` is now emitted, which gives monitoring a hook, but there is no timelock — the rotation and the drain can be in the same block.

**Impact.** Reachable-permanent loss of all merchant funds with no on-chain recourse, from either a single unavailable key or a single governance mistake.

**Why the current implementation is vulnerable.** The design gives the merchant *authority over configuration* (payout) but *no authority over money*. Those two are decoupled in a way that leaves the merchant with no exit.

**Recommended fix.** Give the merchant an unconditional exit that does not depend on the operator, the owner, or the backend. Concretely: a merchant-callable `withdrawToPayout(token, amount)` bounded by an on-chain recorded merchant balance (§5.3), or — if accounting stays off-chain — a `sweepToPayout(token)` callable by the merchant after a configurable inactivity period. Pair with a two-step, timelocked `setOperator` (request/accept with a delay) so a compromised owner cannot install a thief and drain in one transaction. At minimum, document that losing the owner key is equivalent to losing all funds.

**Test to add:** yes — a test asserting the merchant can recover their recorded balance with the operator key revoked/unavailable.

---

### H-03 — High — The settlement split is unverifiable on chain, and the backend that should compute it does not exist

**Affected:** `X402Vault.withdraw`; the entire backend.

**Description.** The contract has no `recordSettlement`, no balance mapping, no gross/net computation, and no validation of the split. Verified by exhaustive search: `grossAmount`, `merchantAmount`, `x402GoFee`, `facilitatorFee`, `recordSettlement` occur **zero times** anywhere in `backend/` or `frontend/` outside the previous audit document. There is no x402 middleware or paywall; no route returns 402; the backend's complete surface is `Index`, `Auth`, `ApiKeys`, `Payout`, and an empty `UsersRoute`. `OPERATOR_KEY` is *required* by `src/utils/validateEnv.ts` so the server refuses to boot without it, and is then **never read by any line of code** — there is nothing for it to sign with, because no chain client exists. `CELO_FACILITATOR_API_KEY` is likewise set and referenced nowhere.

**Impact.** The intended invariant `grossAmount = merchantAmount + x402GoFee + facilitatorFee` holds nowhere. Every withdrawal is an unverifiable assertion. Errors — an off-by-one, a stale nonce, a mis-scaled decimal, a duplicated settlement — are undetectable on chain and leave no record to reconcile against. The only "verification" available is trusting the same party that could benefit from getting it wrong.

This is the finding that makes H-01 and H-03-in-the-token-sense dangerous rather than theoretical: with no ledger, there is no diff to detect an over-charge, and no way to prove one occurred after the fact.

**Why the current implementation is vulnerable.** Accounting was deliberately moved off chain (a legitimate choice for gas), but nothing replaced the on-chain check with an off-chain one: there is no settlement model, no ledger, no reconciliation, and no test.

**Recommended fix.** Choose one and make it explicit rather than implicit:
- **On chain (bounded trust):** add an operator-writable `recordSettlement(token, merchantAmount, feeAmount)` that *increments* recorded entitlements, and bound `withdraw` by them. This does not stop a malicious operator from minting entitlements — so it must be paired with a bound (M-cap on fees) or with merchant-signed settlements to be meaningful. It does, however, make withdrawn-vs-recorded auditable and makes the merchant's balance publicly readable.
- **Off chain (explicit trust):** build the ledger in the backend, and have the withdrawal flow *verify post-conditions* — read `vault.tokenBalance(token)` and recipient balances before and after, and reconcile against the recorded entitlement delta before marking the settlement final. Then the contract is a dumb pipe and the backend is the system of record, which must be stated as a trust assumption (§4).

Either way: do not ship a payment path where the only evidence of correctness is the operator's own transaction.

**Test to add:** yes — the invariant test in §6.1.

---

### H-04 — High — No token allowlist; fee-on-transfer and rebasing tokens silently break the ledger

**Affected:** `X402Vault.withdraw`, `X402VaultFactory.withdrawFees`.

**Description.** Any address can be passed as `tokens[i]`. Solady's `safeTransfer` (verified, `SafeTransferLib.sol:336-354`) is a strong transfer-layer guard: it reverts `TransferFailed()` when the token has **no code**, returns a word other than `1`, or reverts; it accepts a token returning no data (USDT-style). That closes the "EOA pretending to be a token" and "returns false" classes. It cannot close the following:

- **Fee-on-transfer tokens.** The vault is debited the full amount; the recipient receives less. The contract cannot tell. Every settlement denominated in such a token is wrong by the fee, and the error compounds. There is no on-chain record, so the drift is invisible (H-03).
- **Rebasing tokens.** The vault's balance changes between the moment the backend computes the split and the moment the transaction executes. The split is then stale — in the deflationary direction this makes `withdraw` revert atomically (safe), in the inflationary direction it under-withdraws and leaves dust that must be reconciled.
- **Tokens with unusual decimals.** No on-chain consequence, but a 6-vs-18 mix-up produces a 10^12 error that nothing on chain will catch.
- **Conforming-but-malicious tokens.** A token that returns `true` without moving value passes every check. The only defence is to never accept it.
- **Rebasing/hook tokens with callback surface.** A token may call back into the vault during `transfer`; see L-04 for why this is currently harmless.

**Impact.** Silent, systematic mis-accounting of merchant funds with no on-chain detection path. In the malicious case, a vault can be drained relative to its ledger.

**Why the current implementation is vulnerable.** The transfer layer is hardened but the *policy* layer is absent. "Which tokens may this system hold" is a decision the contract never makes and the backend never records.

**Recommended fix.** Add an owner-managed token allowlist on the factory, enforced in `withdraw` and `withdrawFees` (`if (!factory.isAllowed(token)) revert TokenNotAllowed()`). Explicitly document the token assumptions the system relies on: standard ERC-20 semantics, no transfer fee, no rebase, 18 or 6 decimals only, and — for the accounting to hold — that `transfer` moves exactly the requested amount. Reject anything else at allowance time rather than discovering it at settlement.

**Test to add:** yes — a fee-on-transfer mock asserting the documented behaviour (that the recipient receives less than the amount, and that the backend must therefore verify post-conditions), plus an allowlist rejection test.

---

### M-01 — Medium — `withdrawFees` emits no event: fee outflows are unmonitorable

**Affected:** `X402VaultFactory.withdrawFees` (`X402VaultFactory.sol:64-73`).

**Description.** The vault→factory fee leg is logged via `Withdrawn(merchant, token, merchantAmount, feeAmount)`. The factory→treasury leg — the one that moves actual value out of the system — emits nothing. There is no `FeesWithdrawn(address[] tokens, address feeRecipient, uint256[] amounts)` event.

**Impact.** An indexer cannot reconstruct fee flows. An incident responder cannot tell whether fees were swept, when, or where. Combined with the fact that `feeRecipient` is an owner-supplied parameter chosen at sweep time, a compromised owner key can drain all accumulated fees **in a single unlogged transaction**. The pre-blueprint audit's M-06 ("state changes with no event") was fixed for vault creation, payout change, operator rotation, and withdrawal — this is the remaining hole.

**Why the current implementation is vulnerable.** The function was added without the event that every other state-changing function has.

**Recommended fix.** Emit `FeesWithdrawn(tokens, feeRecipient, amounts)` per call, mirroring `Withdrawn`'s granularity. Consider also making `feeRecipient` an immutable set in the constructor, removing the owner's ability to choose the destination at sweep time entirely — that is the same structural fix that closed C-01 in the previous revision.

**Test to add:** yes — `vm.expectEmit` on the sweep, including the zero-balance and multi-token cases.

---

### M-02 — Medium — `evm_version` is unpinned and the default build emits Cancun-era opcodes

**Affected:** `contracts/foundry.toml`.

**Description.** `foundry.toml` sets no `evm_version`, so the build targets solc 0.8.28's default. Building the identical sources with `FOUNDRY_EVM_VERSION=paris` produces **different, larger** bytecode (X402Vault 4,115 B vs 4,021 B; X402VaultFactory 3,253 B vs 3,182 B), which demonstrates that the default build is emitting opcodes unavailable before Cancun (the size *reduction* is the signature of a multi-byte sequence collapsing into a single opcode such as `MCOPY`).

**Impact.** If the target chain does not support the built-for revision, the contracts hit an invalid opcode at runtime. On a chain that *does* support it, the risk is nil — but the build is not self-documenting, and a future `foundry.toml` or toolchain change can silently move the target. A vault or factory that deploys successfully but reverts on first `withdraw` or `changePayout` is the worst failure mode available: funds received, then unreachable.

**Why the current implementation is vulnerable.** The EVM target is inherited from a compiler default rather than declared. The broadcast artifact confirms the target is **Celo (chain ID 42220)**; the supported revision must be confirmed against Celo rather than assumed from solc.

**Recommended fix.** Confirm the target chain's supported revision, then pin it explicitly (`evm_version = "cancun"`, or `"paris"` — the paris build compiles cleanly, so that is a viable fallback with no source changes). Add a CI job that builds with the pinned version and runs the suite, so the pin is enforced rather than aspirational.

**Test to add:** yes — a CI build/test under the pinned EVM version. Also a post-deploy smoke test on the target chain that exercises `createVault` → `initPayout` → `changePayout` → `withdraw`, since an opcode mismatch appears at first execution rather than at deployment.

---

### M-03 — Medium — The merchant key is a permanent, non-revocable payout authority

**Affected:** `X402Vault.changePayout` (`X402Vault.sol:62-80`).

**Description.** The signer is `merchant()`, read from clone bytecode and therefore immutable for the vault's lifetime. There is no rotation, no delegation, no expiry, and no way to revoke. Once a merchant key touches `changePayout`, it holds the power to redirect every future payout forever. The brief's requirement 7 — that the *current payout address* authorize the change — would have made this a naturally decaying authority; the implementation, per the client's confirmation, does not do that.

**Impact.** A merchant who signs from a browser hot wallet (which the frontend's onboarding flow actively encourages — `PayoutSetup.jsx` offers the connected wallet as the payout) exposes a permanent redirection capability from a key with the largest practical attack surface. Compromise of that key does not just lose current funds; it permanently redirects all future settlements, and the merchant cannot take the authority back — only the attacker's chosen payout can be overwritten *by the same compromised key*.

**Why the current implementation is vulnerable.** Authority is bound to an identity that can never be changed, with no compensating control.

**Recommended fix.** Add merchant-controlled authority rotation: a `changeMerchant(newMerchant, deadline, signature)` gated on a signature from the *current* merchant, reusing the existing EIP-712 machinery. That converts a permanent compromise into a recoverable one, and it also gives the platform a clean answer to "what if the merchant's key is lost" (they re-onboard and the old vault is abandoned — which is honest, rather than pretending the key can be recovered). Additionally, bind the payout authority to a payout-specific key where possible, or document loudly that the merchant key must be a hardware or dedicated key, not the browser key.

**Test to add:** yes — rotation succeeds with the current merchant's signature, fails without it, and the old merchant loses authority afterwards.

---

### M-04 — Medium — `changePayout` accepts malleable and compact signatures; a signature is not a unique identifier

**Affected:** `X402Vault.changePayout` (`X402Vault.sol:72`).

**Description.** Verification is `SignatureCheckerLib.isValidSignatureNowCalldata(merchant(), digest, signature)`. Verified against the vendored source:

- **Low-s is not enforced.** The source header states it outright: *"This implementation does NOT check if a signature is non-malleable."* (`SignatureCheckerLib.sol:23`), and no `s <= secp256k1n/2` comparison exists in the function.
- **EIP-2098 64-byte compact signatures are accepted** alongside 65-byte `(r,s,v)` (`:92-101`), so the same logical signature has at least two encodings.
- Malleability is *neutralised*, not *prevented*: the nonce is consumed by whichever variant lands first, so the twin reverts. The suite tests exactly this (`test_changePayout_malleableTwinNeutralisedByNonce`).

**Impact.** No fund-loss path — the nonce carries the security. The impact is on everything that treats a signature as an identifier: off-chain deduplication, idempotency keys, "have I already processed this request" checks, and audit records. Two submissions of the same logical authorization look like two different signatures. Any backend that dedupes by signature bytes will mis-handle a retry. This is a correctness trap for the integration that does not exist yet, which is precisely when it is cheapest to fix.

**Why the current implementation is vulnerable.** Solady is a deliberate choice and a good one, but its signature checker is intentionally more permissive than OpenZeppelin's `ECDSA`, which rejects high-s. Substituting the library changes the malleability guarantee.

**Recommended fix.** If uniqueness matters (and for an idempotent settlement API it does), add an explicit low-s check after recovery, or dedupe off chain by `(vault, nonce, deadline, newPayout)` rather than by signature bytes. Document the choice either way. Note that adding low-s enforcement is a ~50-gas check and removes a whole class of downstream reasoning.

**Test to add:** yes — assert the current permissive behaviour explicitly (so a future low-s change is a deliberate, visible decision), and add the replay-across-encodings case.

---

### M-05 — Medium — The two-leg withdrawal cannot express the documented three-way split

**Affected:** `X402Vault.withdraw`; architecture vs. brief item 3.

**Description.** The brief's accounting model is `grossAmount = merchantAmount + x402GoFee + facilitatorFee` — four values. The contract accepts two (`merchantAmounts`, `feeAmounts`) and has exactly two destinations (`payout()`, `FACTORY`). `facilitatorFee` has no on-chain representation anywhere in the repository.

**Impact.** The facilitator's share must be silently summed into the fee leg, and then re-split off chain after the factory sweep. That convention is enforced nowhere and recorded nowhere, and it is exactly the kind of implicit contract that breaks during an incident or a facilitator change. If the facilitator must be paid *directly* (a plausible requirement for a third-party facilitator with its own settlement expectations), the current contract cannot do it at all without a redeploy.

**Why the current implementation is vulnerable.** The destination model was designed for two parties and the business model has three.

**Recommended fix.** Decide and document explicitly: either (a) the facilitator is paid out of the fee leg post-sweep, and this is written down in the settlement spec and asserted in the backend's reconciliation, or (b) add a third leg. If (b), the cleanest shape keeps the current call ABI and adds an owner-configured immutable `facilitator` destination with a third amount array — but note this is an ABI change and a redeploy, so decide before mainnet rather than after.

**Test to add:** yes — a settlement test asserting the three-way identity holds in the backend's computation (not a contract test, per the off-chain-accounting decision, but a test somewhere must own it).

---

### M-06 — Medium — `renounceOwnership()` permanently destroys the operator-rotation and fee-withdrawal paths

**Affected:** `X402VaultFactory` via Solady `Ownable` (`Ownable.sol:185-188`).

**Description.** `renounceOwnership()` is inherited unmodified and sets the owner to `address(0)` with no guard. Afterwards `setOperator` and `withdrawFees` revert `Unauthorized()` forever. The suite documents the consequence (`test_ownership_renounceBricksOwnerActionsButKeepsOperator`).

**Impact.** Operator loss after renunciation is unrecoverable: no rotation is possible, so `withdraw` is dead for every vault, and fees already swept into the factory are stranded. This is a footgun that turns one key-loss event into total loss.

**Why the current implementation is vulnerable.** Solady's `Ownable` offers `renounceOwnership` because most contracts want it; this contract's security model depends on the owner existing as a recovery path, so the default is wrong here.

**Recommended fix.** Override `renounceOwnership()` to revert, or gate it behind a two-step confirmation, and document that the owner key is a *liveness* dependency, not just a governance convenience. Consider whether ownership should be a multisig or a timelocked contract before mainnet, since it is the only recovery lever.

**Test to add:** yes — assert `renounceOwnership()` reverts (once changed), and assert that `setOperator` + `withdraw` work after a rotation performed by a handover.

---

### M-07 — Medium — Constructor accepts `operator = address(0)`, producing a factory whose vaults nobody can withdraw from

**Affected:** `X402VaultFactory` constructor (`X402VaultFactory.sol:22-26`).

**Description.** `setOperator` correctly rejects `address(0)`, but the constructor does not validate. `new X402VaultFactory(owner, address(0))` deploys successfully. Every vault it creates is permanently unwithdrawable (`msg.sender != address(0)` is true for every caller) until the owner calls `setOperator`. The deploy script defaults `OPERATOR` to `address(0)`, so **the default deployment path produces exactly this factory**.

**Impact.** Vaults can be created and funded before anyone notices; funds are frozen on arrival. The owner *can* repair it, so this is not permanent — it is a silent misconfiguration with a funding window in the middle.

**Why the current implementation is vulnerable.** Validation is present on the mutating path but omitted on the constructing path. The default in the script makes the bad value the easy path.

**Recommended fix.** Reject `address(0)` in the constructor, and make the deploy script *fail* rather than default when `OPERATOR` is unset (it is a required argument in every real deployment). Note that the previous revision's `test_setOperator_canBeCleared` treated an unset operator as a supported state; that state is no longer reachable through `setOperator`, so the constructor is the only remaining way to reach it — which is a good argument for closing it.

**Test to add:** yes — constructor with a zero operator reverts.

---

### M-08 — Medium — Stale deployment artifact and key-handling mismatch in the deploy script

**Affected:** `contracts/broadcast/DeployX402VaultFactory.s.sol/42220/dry-run/run-latest.json`; `script/DeployX402VaultFactory.s.sol`.

**Description.** Two independent issues in the deployment path.

1. **The recorded artifact is for the previous contract.** The dry-run on Celo (chain 42220) records a `X402VaultFactory` deployment whose constructor `arguments` array contains **one** address — the pre-blueprint 1-argument constructor. The current constructor takes two. Anyone re-broadcasting this artifact, or reading it to recover the deployed addresses, gets the old factory with an operator that can never be set at construction.
2. **The script reads a raw private key from the environment while its own usage text says otherwise.** `vm.envUint("PRIVATE_KEY")` with `vm.startBroadcast(privateKey)`, while the usage block directly above says `--account <keystore-name>`. A raw key in an environment variable is exposed to process listings, shell history, `.env` files, and any child process; the documented keystore path never runs.

**Impact.** Either issue alone is a deployment incident: the first deploys or misrepresents the wrong bytecode, the second leaks the owner/deployer key. The deployer key is the most valuable key in the system at that moment — it becomes the factory owner, which controls operator rotation and fee withdrawal.

**Why the current implementation is vulnerable.** The artifact predates the contract change; the script's documentation and implementation diverged.

**Recommended fix.** Delete the stale `broadcast/` directory (it is simulated output for superseded code, and keeping it invites exactly this mistake), or regenerate it after the fix. Change the script to `vm.startBroadcast()` with no argument so it uses the `--account`/`--ledger` signer, and make `OPERATOR` a required variable. Deploy the factory from a hardware wallet or a keystore, and verify the deployed implementation address matches `factory.implementation()` on chain.

**Test to add:** yes — a fork test against the target chain that runs the deploy script and asserts the resulting factory's owner, operator, and implementation are the intended ones. `forge script` supports `--fork-url` for exactly this.

---

### L-01 — Low — `payout` may be set to the vault, the factory, or an address that cannot receive, with no validation

**Affected:** `X402Vault.changePayout` (`X402Vault.sol:63`), `X402VaultFactory.createVault`.

**Description.** Only `address(0)` is rejected. Setting `payout = address(vault)` makes `safeTransfer(token, vault, amount)` a self-transfer that moves nothing while returning success — the merchant's funds silently stop progressing, and the merchant must sign a new payout change to recover. Setting `payout = FACTORY` commingles merchant funds with the fee pool, where the owner's `withdrawFees` sweep will move them out to the owner's chosen recipient — a self-inflicted version of H-01.

**Impact.** Self-inflicted or socially-engineered fund misrouting. Low because it requires the merchant's own signature, but the failure is silent and the `payout = FACTORY` case escalates beyond the merchant's control once swept.

**Recommended fix.** Reject `newPayout == address(this)` and `newPayout == FACTORY` in `changePayout` and `createVault`. Both are unambiguous mistakes with no legitimate use.

**Test to add:** yes — both must revert.

---

### L-02 — Low — The implementation contract is not a "locked" instance: `merchant()` returns garbage rather than reverting

**Affected:** `X402Vault.merchant()` (`X402Vault.sol:37-39`), the implementation deployed by the factory constructor.

**Description.** `LibClone.argsOnClone(instance, start, end)` is documented *"The `instance` MUST be deployed via the clone with immutable args functions. Otherwise, the behavior is undefined."* (`LibClone.sol:682-683`). It reverts only when the address has **less than 0x2d (45) bytes of code**; a larger ordinary contract does not revert — the function `extcodecopy`s arbitrary bytes of its own runtime code and returns them as the args. Tracing the exact path for the implementation (`end = 20`, `start = 0`, `extcodesize ≈ 4021`, so `n ≈ 3976`): the clamp `d := mul(gt(n, start), sub(d, mul(gt(end, n), sub(end, n))))` resolves to `20` on both branches of the marker check, so `merchant()` deterministically returns `address(bytes20(runtimeCode[0x0d:0x21]))`.

For the current build that value is `0x5f5FfD5b5060043610610085575f3560e01c8063` — a dead address. **It does not revert.**

Consequences: `changePayout` on the implementation always reverts (`InvalidSignature` — nobody holds that key), which is the intended outcome by accident. `withdraw` on the implementation, however, passes its only gate (`msg.sender == operator()`) and would send any tokens held by the implementation to that dead address. There is no rescue function.

**Impact.** Low in practice — the implementation should never hold tokens. But the safety here is incidental rather than designed: the implementation is protected because `initPayout` is factory-gated, not because the implementation is inert. If a token is ever accidentally sent to the implementation, it is unrecoverable and the operator's only "recovery" is to send it to a dead address.

**Recommended fix.** Override `merchant()` (or add a guard in `withdraw`) so the implementation is explicitly inert — e.g. revert when `address(this) == FACTORY_IMPLEMENTATION`, or when `merchant()` reads as a non-clone. The conventional equivalent of OpenZeppelin's `_disableInitializers`. At minimum, document that the implementation must never hold value.

**Test to add:** yes — pin the current behaviour and assert the intended one: `X402Vault(factory.implementation()).merchant()` should revert (or return `address(0)`), not garbage.

---

### L-03 — Low — Rogue clones of the implementation are functional, and the real operator holds withdrawal rights over them

**Affected:** `X402Vault.withdraw` gated on `IX402VaultFactory(FACTORY).operator()`.

**Description.** Anybody may call `LibClone.cloneDeterministic(implementation, attackerChosenArgs, salt)` from their own contract. The clone's `FACTORY` immutable resolves to the **real** factory (immutables are baked into the implementation, not the clone), so its `withdraw` is callable by the **real operator**, and its `payout()` is the merchant address the attacker encoded in the args. Such a clone cannot be initialized (`initPayout` requires `msg.sender == FACTORY`, and the factory only calls it on addresses it deploys itself), but it does not need to be — `payout()` falls back to `merchant()`.

**Impact.** Informational-to-Low. An attacker cannot profit: any funds sent to a rogue clone are withdrawable by the real operator to the *attacker-chosen merchant address*, which the attacker also chose — so they could arrange for value to reach an address they control, but only value that somebody voluntarily sent to a contract that is not the canonical vault. The realistic risk is confusion: a rogue clone with `merchant = victim` looks like a plausible vault at an address that is not `vaultOf(victim)`. `vaultOf()` is the authoritative check, and the backend must use it rather than trusting a supplied address.

**Recommended fix.** Document that `vaultOf(merchant)` is the only canonical address, and have the backend derive `payTo` from it rather than accepting an address. Consider having `withdraw` also verify `merchant() != address(0)` and `LibClone` membership, or bind the clone to the factory by construction.

**Test to add:** yes — assert that a rogue clone deployed outside the factory cannot be initialized, and that `vaultOf` never returns a rogue address.

---

### L-04 — Low — No reentrancy exposure today, but the risk is latent and untested in the form that will matter

**Affected:** `X402Vault.withdraw`, `X402VaultFactory.withdrawFees`.

**Description.** `withdraw` performs external calls in a loop with no reentrancy guard. It is **currently safe**, for a specific reason: it contains no state to corrupt. The only storage in the vault is `_payout`/`nonce`, written exclusively by `changePayout` (signature-gated) and `initPayout` (factory-gated, one-shot, already consumed by the time any withdrawal can occur). A token re-entering `withdraw` fails the operator check (`msg.sender == token != operator`), which `test_withdraw_reentrancyThroughTokenIsBlocked` demonstrates. `withdrawFees` re-reads `balanceOf` per iteration, so a re-entrant call cannot double-spend.

The gap is in the *test*, not the code: the existing reentrancy test only proves the "token is not the operator" case. When on-chain accounting is added (§5.3), the attack becomes real — a malicious token called in the merchant leg re-enters `withdraw` before the balance decrement lands, and drains against a stale entitlement. The current test would still pass, because it asserts the wrong failure mode.

**Impact.** None today. Potentially High the moment accounting is added, and the existing test would give false confidence at exactly that moment.

**Recommended fix.** Do not add `nonReentrant` now — it costs gas to protect state that does not exist. Instead: (a) document in the contract that `withdraw` holds no state and that any accounting added to it must follow checks-effects-interactions with a guard; (b) add the reentrancy test *when the state is added*, in a form where the token re-enters **as the operator**.

**Test to add:** yes, deferred and conditional. Record the intent now so it is not forgotten.

---

### L-05 — Low — Duplicate token addresses in one batch are permitted

**Affected:** `X402Vault.withdraw`.

**Description.** The same token may appear multiple times in `tokens`, each with its own amounts (tested: `test_withdraw_sameTokenListedTwice`). Not exploitable — the sum must still fit the balance, and an over-draw reverts the whole batch atomically. But it multiplies the external calls, complicates reconciliation, and makes a backend bug (a duplicated settlement row) express itself as a doubled transfer rather than a revert.

**Recommended fix.** Either reject duplicates (`token > previous` monotonic ordering, cheap and enforceable in the loop) or document that duplicates are the backend's responsibility to avoid.

**Test to add:** yes — assert the ordering requirement rejects duplicates, if adopted.

---

### L-06 — Low — No ETH ingress, and no rescue for force-fed ETH

**Affected:** `X402Vault` (no `receive`/`fallback`), `X402VaultFactory`.

**Description.** Neither contract has a `receive()` function, so ordinary ETH transfers revert — good, since nothing handles native value. But ETH can still be forced in via `selfdestruct` from another contract, and there is no path to move it out. Solady's `SafeTransferLib` also provides `safeTransferETH`, which is unused.

**Impact.** Negligible for an ERC-20-only system on Celo; the only exposure is permanently stranded dust from a forced send. Worth noting only because the absence of `receive()` makes it look handled when it is only *mostly* handled.

**Recommended fix.** Document that the vault is ERC-20-only and that native value is unsupported. If it matters, add an operator-gated native sweep.

**Test to add:** no.

---

### I-01 — Informational — `Unauthorized()` has the same selector in `Ownable` and `X402Vault`

`X402Vault` declares `error Unauthorized()` (`X402Vault.sol:23`) and Solady's `Ownable` declares the same (`Ownable.sol:20`). Both resolve to selector `0x82b42900`. Reverts from the factory's `onlyOwner` path and from the vault's operator check are therefore byte-identical, so a client cannot distinguish "you are not the owner" from "you are not the operator" without knowing which contract reverted. Cosmetic, but it complicates error handling in the integration that does not exist yet. Consider distinct error names per contract.

Relatedly, `X402Vault.AlreadyInitialized()` shares its selector with Solady `Ownable.AlreadyInitialized()` (`0x0dc149f0`) — same reasoning, same (low) impact.

---

### I-02 — Informational — Nonce overflow panics rather than reverting with a typed error

`nonce` is `uint96` and increments with checked arithmetic (`nonce = n + 1`), so overflow panics (`0x11`) rather than raising a named error. Reaching 2^96 signatures is not feasible; noted only because the error is untyped. Tested by `test_changePayout_nonceOverflowPanics`.

---

### I-03 — Informational — The EIP-712 domain-separator cache is defeated on every clone

`EIP712` caches `_cachedThis`, `_cachedChainId` and the domain separator as **immutables computed in the constructor** (`EIP712.sol:39-80`), and invalidates them when `address(this)` or `block.chainid` changes (`_cachedDomainSeparatorInvalidated`, `:291-299`). Because a clone's `address(this)` is never the implementation's address, `_hashTypedData` **always** takes the `_buildDomainSeparator()` path on a clone — two `keccak256` calls per verification, plus reads of five immutables.

This is **correct** (the invalidation check is precisely what makes it safe, and `test_eip712Domain_reportsVaultAsVerifyingContract` plus the chain-ID tests confirm it), and it is the right answer to the brief's question about constructor/immutable compatibility with clones. It is recorded here only because the cache is pure cost in this architecture — the code reads as though it is cached, and it never is.

If `changePayout` volume ever justifies it, caching the separator in storage on first use would trade one cold `SSTORE` for a warm `SLOAD` on subsequent verifications. Given payout changes should be rare, **this is not worth adding state for.** No change recommended.

---

### I-04 — Informational — Generic domain name and no `salt`

`_domainNameAndVersion()` returns `("X402Vault", "1")` (`X402Vault.sol:117-119`) and EIP-5267 `eip712Domain()` reports `salt = bytes32(0)`. Cross-deployment separation is still sound because `verifyingContract` differs per clone (each clone is its own verifying contract, so a signature for one vault can never be valid for another — tested by `test_domain_signatureNotValidOnOtherVault` and `test_domain_sameMerchantSignatureCannotCrossFactories`). The residual risk is a *different* protocol reusing the name "X402Vault" with a colliding domain; a merchant signing blind could not tell them apart. Consider a project-specific name string. Low practical impact.

---

## 4. Trust assumptions

Stated explicitly, because several of them are currently implicit and at least two are load-bearing.

| # | Assumption | Enforced? | If violated |
| --- | --- | --- | --- |
| T1 | The **operator** declares the correct split on every withdrawal | **Not enforced anywhere.** Honesty only. | H-01: merchant funds confiscated. No detection path (H-03). |
| T2 | The **operator** does not create vaults with a hostile payout | **Not enforced.** Only the operator's own restraint prevents it. | C-01: total theft. |
| T3 | The **operator** eventually calls `withdraw` | **Not enforced.** No merchant exit exists. | H-02: indefinite censorship; permanent if the owner key is also gone. |
| T4 | The **owner** key is available for recovery | Enforced by nothing; `renounceOwnership` can destroy it. | M-06: permanent freeze. |
| T5 | The **merchant** key is uncompromised and kept secure | Enforced by nothing; the frontend encourages a browser wallet. | M-03: permanent payout redirection. |
| T6 | All tokens behave as standard ERC-20s (no fee, no rebase, exact transfers) | **Not enforced.** No allowlist. | H-04: silent ledger drift, undetectable. |
| T7 | The **backend** computes the split correctly and idempotently | **The backend does not compute a split at all.** | H-03: the invariant holds nowhere. |
| T8 | `tokenBalance` → `withdraw` is not raced | Not enforced; no snapshot, no ledger. | Stale splits: revert (safe) or dust (reconciliation drift). |
| T9 | The facilitator's fee is netted out of the fee leg by convention | Not enforced; not even documented in code. | M-05: under- or double-payment of the facilitator. |
| T10 | The implementation contract is never sent value | Not enforced; only incidental (L-02). | Unrecoverable tokens. |

**The single most important line in this table is T1/T2.** Everything the contract does well — immutable fee destination, per-vault signature domains, atomic transfers, clone isolation — is downstream of a trust assumption it does not check. The immutable fee recipient closed the previous revision's critical finding by removing the operator's ability to name a *destination*; the remaining exposure is the operator's ability to name an *amount* and an *initial destination*.

---

## 5. Recommended architectural changes

Ordered by value per unit of change. Items 5.1 and 5.2 are the ones that matter before mainnet.

### 5.1 Never let the operator choose a payout for someone else's vault (closes C-01)

The highest-value change in this report, and the smallest. In `createVault`, require that an operator-created vault has `payout == merchant`:

```solidity
if (msg.sender != merchant && msg.sender != operator) revert Unauthorized();
// An operator may provision the vault, but may not choose where the merchant's
// money goes. Only the merchant may name a payout other than their own address,
// and only by signing it.
if (msg.sender != merchant && payout != merchant) revert Unauthorized();
```

A merchant-initiated `createVault` keeps today's freedom. An operator-initiated one gets the safe default, and any custom payout must then come from the merchant's own `changePayout` signature — which already exists, is already domain-bound, and is already tested. If onboarding needs an operator-provisioned custom payout, accept a merchant signature over `CHANGE_PAYOUT_TYPEHASH` with `nonce == 0`.

### 5.2 Bound the operator's control over the split (bounds H-01)

With 5.1 in place, the operator can no longer redirect funds — but it can still declare any amount a "fee". Three options, in ascending order of robustness:

- **Fee cap.** An owner-set `maxFeeBps` on the factory, enforced as `feeAmounts[i] * 10_000 <= (merchantAmounts[i] + feeAmounts[i]) * maxFeeBps`. Cheap, one `SLOAD` per vault (`maxFeeBps` read once outside the loop), and bounds the damage to the fee rate.
- **Recorded entitlement.** An operator-writable `recordSettlement(token, merchantAmount, feeAmount)` that *increments* per-token credits, with `withdraw` bounded by them. Makes the merchant's balance publicly readable and makes withdrawn-vs-recorded auditable. Does **not** by itself stop a malicious operator (it can mint credits), so it must ship with a cap or with merchant-signed settlements — but it converts "no record at all" into "a record that can be diffed".
- **Merchant-signed split.** The merchant signs `(vault, token, merchantAmount, feeAmount, nonce, deadline)`; the operator submits. This makes the operator structurally unable to misstate anything, and it reuses `changePayout`'s existing machinery almost verbatim. It is the only option that makes T1 true.

Recommendation: ship 5.1 plus the fee cap now (both are small and neither changes the withdrawal ABI), and add the entitlement record when the backend ledger is built, so that the backend and the chain have the same shape. Treat merchant-signed splits as the target state if the merchant volume justifies the UX cost.

### 5.3 A merchant exit path (closes H-02)

The merchant needs something they can call themselves. With a recorded entitlement (5.2) this is straightforward: `withdrawToPayout(token)` callable by the merchant, bounded by their recorded balance. Without on-chain accounting, the honest options are a merchant-callable sweep permitted after an inactivity period, or an explicit, documented statement that the owner key is a liveness dependency and the merchant has no on-chain recourse. The second is defensible for a custodial platform; it is not defensible if the marketing says the merchant controls their funds.

### 5.4 Token allowlist (closes H-04)

An owner-managed allowlist on the factory, enforced in `withdraw` and `withdrawFees`. Reject non-standard tokens at allowance time rather than discovering the problem at settlement. Write down the assumptions being enforced: exact-amount transfers, no transfer fee, no rebasing, supported decimals, standard return semantics.

### 5.5 Governance hardening (bounds the owner-key blast radius)

- Two-step, timelocked `setOperator` (request/accept with a delay), so a compromised owner cannot install a thief and drain in one block. `OperatorChanged` already gives monitoring a hook; a timelock gives it time to act.
- Override `renounceOwnership()` to revert (M-06).
- Reject `address(0)` in the constructor (M-07).
- Move ownership to a multisig or a timelocked contract before mainnet.

### 5.6 Make the fee outflow observable (closes M-01)

Emit `FeesWithdrawn(tokens, feeRecipient, amounts)` from `withdrawFees`. Consider making `feeRecipient` immutable at construction — the same structural fix that closed the previous critical finding for vaults.

### 5.7 Close the deployment path (closes M-02, M-08)

Pin `evm_version` after confirming the target chain's supported revision (both `cancun` and `paris` build cleanly today). Delete or regenerate the stale `broadcast/` artifact — it records the previous 1-argument factory. Switch the deploy script to keystore/`--account` signing and make `OPERATOR` required. Add a fork test that runs the script against the target chain and asserts the resulting owner, operator, and implementation.

### 5.8 Explicitly decline the changes that add risk without adding safety

- **Do not** add an upgrade mechanism or proxy admin. The implementation is immutable; a bug means a new factory and a migration. That is the right trade for this contract size and this threat model — an upgrade path would add a privileged write to every vault's behaviour, which is a strictly larger blast radius than the bug it insures against.
- **Do not** add `nonReentrant` yet (L-04). It would cost gas to protect state that does not exist.
- **Do not** replace Solady with OpenZeppelin. Solady is well suited here (CWIA clone support is the reason this architecture is cheap). The one behavioural difference that matters — malleability (M-04) — should be handled with an explicit low-s check, not a library swap.

---

## 6. Recommended tests

The existing suite is strong on the paths it covers: 167 tests, 10,000 fuzz runs each, and genuinely good coverage of signature edge cases (cross-vault, cross-chain, wrong signer, malformed lengths, compact form, deadline boundary, replay, malleable twin), token quirks (no-return, false-return, reverting, no-code, reentrancy), multi-token and duplicate-token batches, zero/empty/max amounts, and initialization gating. The gaps are the ones the current design would not have caught.

### 6.1 The tests that would have found these findings

1. **Operator-theft end-to-end (C-01).** Create a vault as the operator with a hostile payout, fund it, withdraw, assert the funds **cannot** reach `attackerPayout`. This is the single most valuable test to add.
2. **Operator confiscation (H-01).** `withdraw` with `merchantAmounts = [0]` and `feeAmounts = [balance]` must revert (or clamp, if a cap is adopted).
3. **Merchant exit (H-02).** With the operator key revoked, the merchant can still recover their recorded balance.
4. **Accounting invariant (H-03).** A stateful invariant: for every token, `factory balance == Σ fee legs`, and no vault's balance ever decreases without a matching `Withdrawn` event. Run under `[invariant]` in `foundry.toml` — no invariant section exists today.
5. **Fee-on-transfer token (H-04).** Assert the documented behaviour: the recipient receives *less* than the requested amount and the contract still succeeds — pinning the fact that the backend must verify post-conditions.
6. **Rebasing token simulation (H-04).** Change the balance between computing a split and executing it; assert the deflationary case reverts atomically and the inflationary case under-withdraws.
7. **`withdrawFees` event (M-01)** — `vm.expectEmit` across zero-balance, single-token, and multi-token sweeps.
8. **Non-owner cannot sweep to an arbitrary recipient (M-01)** — exists (`test_withdrawFees_onlyOwner`); extend it to assert the emitted event's recipient so a redirect is visible.
9. **Payout-change authority rotation (M-03)** — once added, the old merchant loses authority.
10. **Malleability pinned (M-04)** — assert the current permissive behaviour deliberately, so a future low-s change is a visible decision rather than a silent one.
11. **Three-way split identity (M-05)** — a backend test asserting `gross == merchant + x402Go + facilitator`; no test owns this today.
12. **`renounceOwnership()` (M-06)** — assert it reverts, once overridden.
13. **Constructor zero-operator (M-07)** — asserts the deploy-time footgun is closed.
14. **Fork test of the deploy script (M-08)** — owner, operator, and implementation as intended on the target chain.
15. **`payout == address(this)` and `payout == FACTORY` (L-01)** — both rejected.
16. **Implementation is inert (L-02)** — pin `merchant()`'s behaviour on the implementation, and assert the intended one.
17. **Rogue clone (L-03)** — cannot be initialized; `vaultOf` never returns it.
18. **Empty and single-element bounds (area 14)** — largely present; add the one-unit case explicitly for `withdraw` and `changePayout`.
19. **Concurrent withdrawals (area 9)** — two withdrawals built on the same snapshot; assert the second reverts atomically rather than partially settling.

### 6.2 Test-infrastructure recommendations

- Add an `[invariant]` section to `foundry.toml` and the stateful invariants above. Unit tests with 10,000 fuzz runs are excellent at finding boundary bugs and structurally incapable of finding "the sum of all fee legs must equal the factory balance".
- Add a `--evm-version`-pinned CI job, and a fork test against the target chain.
- Add a test that asserts the deployment artifact and the contracts agree — the stale broadcast file (M-08) is exactly the class of drift a build-verification test catches.

---

## 7. Gas optimization recommendations

The gas profile is already good and none of the following should be pursued at the expense of clarity or safety. The architecture's biggest win is structural: CWIA clones mean a vault costs ~50 + 20 bytes of deployed code regardless of the 4,021-byte implementation, so per-merchant onboarding is cheap by construction.

**Already optimal — leave alone.**

- **`_payout` + `nonce` packed into one 32-byte slot** (`address` 160 bits + `uint96` 96 bits). A payout change is one `SSTORE` to a warm slot, not two. This is the single best storage decision in the contract.
- **`FACTORY` and `implementation` are `immutable`** — read from code, no `SLOAD`.
- **Amounts are `calldata`**, iterated by index without copying to memory.
- **`payout()` and `merchant()` are hoisted out of the `withdraw` loop** (`X402Vault.sol:100-101`) — one `SLOAD` and one `extcodecopy` per withdrawal, not per token. `merchant()` in particular is an `EXTCODECOPY` of the clone's own runtime code, so hoisting it matters.
- **Custom errors** throughout, rather than revert strings.
- **`unchecked { ++i }`** in `withdrawFees`. The same treatment is missing in `withdraw`'s loop — see below.
- **`optimizer_runs = 1000000`** favours runtime gas over deployed size. For the implementation (deployed once by the factory, executed by every vault forever) this is the correct bias, and it does not affect per-vault deploy cost, which is dominated by the fixed-size clone stub.

**Worth doing — small, safe.**

- **`unchecked { ++i }` in `X402Vault.withdraw`.** The loop bound comes from `tokens.length`, which cannot exceed calldata size, so overflow is unreachable. Saves ~30–80 gas per token in a multi-token batch, which is the common path for a settlement sweep.
- **Cache `merchant()` in `changePayout`.** It is currently called twice — once for verification (`:72`) and once for the event (`:79`) — so every payout change pays two `EXTCODECOPY` operations over the clone's runtime code. A single `address m = merchant();` hoisted to the top removes one. Payout changes are rare, but this is free.

**Not worth doing.**

- **Caching the EIP-712 domain separator in storage** (I-03). The immutable cache is always invalidated on a clone, so the separator is rebuilt every time — but a payout change is a rare event, and adding an `SSTORE` (cold, ~20k) to save two `keccak256` calls would be a net loss until a vault had changed payout several times. Leave it.
- **Adding `nonReentrant`** (L-04). Costs gas on every withdrawal to protect state that does not exist.
- **Removing the `IX402VaultFactory(FACTORY).operator()` external call** (~2,600 gas cold per withdrawal). It is the price of operator rotation reaching existing vaults, which `test_withdraw_operatorRotationTakesEffectOnExistingVaults` correctly requires. The only alternative — pushing the operator into each vault on rotation — reintroduces a privileged write path across every vault and is a strictly worse trade. **Leave it as is.**
- **Optimising `withdrawFees`' per-token `balanceOf`.** It is `onlyOwner` and rare.
- **Packing or reordering anything else in `X402Vault`.** Storage is one slot; there is nothing left to pack.

---

## 8. Direct answers to the required questions

**Can a compromised operator wallet steal merchant funds?**
**Yes — completely, via C-01.** The operator can call `createVault(victim, attackerPayout)` and then `withdraw`, routing every token to an address it chose. Three ordinary calls, no owner key, no merchant signature, no detection path. Independently, the operator can confiscate 100% of a vault's balance into the fee pool (H-01) without naming any payout. Both are direct violations of the brief's requirements 9 and 10 and of the preferred model stated in area 7.

**Can the operator redirect funds to an arbitrary wallet?**
**Yes at creation (C-01); no afterwards.** Once a vault exists, `payout()` can be changed only by the merchant's signature — the operator has no path to it, and this is a genuine improvement over the previous revision. The exposure is entirely in the *initial* choice of payout, which the operator makes unilaterally when it creates the vault.

**Can a malicious user initialize or take control of a clone?**
**No.** Three independent reasons, all verified against the source. `initPayout` requires `msg.sender == FACTORY` (`X402Vault.sol:50`), and the factory calls it only inside `createVault`, on the address it deployed in the same transaction (`X402VaultFactory.sol:49-51`) — there is no window between deployment and initialization. The CREATE2 deployer is the factory and the initcode hash includes the merchant args (`LibClone.initCodeHash`, `:618-637`), so the predicted address can only ever be occupied by a clone carrying the *same* args; address squatting is impossible. And the implementation itself cannot be initialized either. A rogue clone can be deployed by anyone, but it is inert with respect to the protocol and holds no one else's funds (L-03). This is the strongest part of the design.

**Can payout-change signatures be replayed?**
**No.** The digest binds `verifyingContract` (per-clone EIP-712 domain), `block.chainid` (with the cached separator correctly invalidated on chain change), `newPayout`, `nonce`, and `deadline`; the nonce increments on success, so a replayed signature fails. Cross-vault (`test_domain_signatureNotValidOnOtherVault`), cross-factory (`test_domain_sameMerchantSignatureCannotCrossFactories`), and cross-chain (`testFuzz_changePayout_chainIdBinding`) replay all fail, and an expired deadline is rejected. Malleable high-s twins are *accepted* but are single-use because the first variant consumes the nonce — so replay is prevented, though signature bytes are not unique (M-04). The residual risk is not replay but key compromise (M-03).

**Can settlement accounting be fabricated?**
**There is no on-chain accounting to fabricate — and nothing to verify against.** `recordSettlement` does not exist; `grossAmount`, `merchantAmount`, `x402GoFee`, `facilitatorFee` appear nowhere in the repository outside the previous audit document. The fabricated quantity is the *split itself*: the operator supplies both amount arrays as unvalidated calldata and the contract transfers exactly what it is told (H-03). So the answer is: no fabricated *balances* (there are none), but a wholly fabricated *settlement*, unchecked and unrecorded.

**Can merchant and fee balances ever become inconsistent?**
**On chain, no — there are no balances to desync.** The vault holds tokens and transfers them; it keeps no record, so no record can disagree. A withdrawal is atomic: one loop, one transaction, and any failing leg reverts the entire call, so a partial settlement is impossible (`test_withdraw_feeLegFailureRollsBackMerchantLeg`, `test_withdraw_secondTokenFailureRollsBackFirst`). **Off chain, they diverge routinely:** any operator-chosen split (H-01), fee-on-transfer tokens (recipient receives less than debited), rebasing tokens (balance moves between computation and execution), and concurrent withdrawals racing a stale snapshot (second reverts, or dust remains). Because there is no ledger, none of this is detectable on chain (H-03, H-04).

**Can a malicious ERC-20 token break withdrawals?**
**It can force a revert, but it cannot break the contract's consistency.** Solady's `safeTransfer` (verified, `SafeTransferLib.sol:336-354`) reverts `TransferFailed()` when the token has no code, reverts, or returns a word other than `1`, and accepts only the no-data (USDT) case as a success. So a hostile token halts the whole batch atomically and leaves state untouched — a liveness problem for that token, not a safety problem. A token that *conforms* while lying (returns `true`, moves nothing) cannot be detected on chain and will corrupt the off-chain ledger — which is why an allowlist (H-04) is a correctness control rather than hygiene. Reentrancy through a token's `transfer` is currently harmless (L-04).

**Is the minimal-proxy implementation safe?**
**Yes — this is the best-engineered part of the system.** Solady's CWIA pattern (`cloneDeterministic`, `:503-533`) with `merchant` as immutable args read from clone bytecode (tamper-proof, no storage to corrupt) and `FACTORY` immutable in the implementation so that one `setOperator` reaches every vault. There is no initializer race, no squatting, and no upgrade surface. The `EIP712` constructor-immutable caching is *compatible* with clones because of the explicit `address(this)` invalidation check — correct, though it means the cache never hits (I-03). Two caveats: the implementation is not explicitly inert — `merchant()` returns deterministic garbage rather than reverting (L-02, verified by tracing the `argsOnClone` assembly) — and its safety rests on `initPayout` being factory-gated rather than on any implementation-level guard.

**Is the current architecture appropriate for handling real funds?**
**Not yet.** The vault mechanics, clone isolation, signature scheme, and atomic transfer layer are sound and would be appropriate. The money model is not: the operator can steal via creation-time payout choice (C-01) or confiscate via the split (H-01); the merchant has no exit and can be censored indefinitely (H-02); the split is unverifiable and the backend that should compute it does not exist (H-03); there is no token allowlist (H-04); fee outflows are unlogged (M-01); and the build target is unpinned against a Celo deployment (M-02) with a stale deployment artifact on disk (M-08). Requirement 9 ("a compromised operator must have the smallest practical blast radius") is not met: the blast radius today is *every vault's entire balance*, and requirement 10's guarantee holds against third parties but not against the operator.

Fix 5.1 and 5.2 and the core proposition — "the operator can trigger legitimate withdrawals but cannot redirect merchant funds without merchant authorization" — becomes true. Until then it is not.

---

## 9. Prioritized pre-mainnet list

Ordered by risk reduced per unit of change. Items 1–3 are the ones that decide whether this can hold real money.

| # | Change | Closes | Size | Why now |
| --- | --- | --- | --- | --- |
| 1 | **`createVault`: an operator may not choose a payout other than the merchant's own address** (§5.1) | **C-01** | 3 lines | The only remaining path to total theft with no merchant signature. Fixes the "operator cannot redirect funds" property outright. |
| 2 | **Bound the fee leg** — owner-set `maxFeeBps` enforced in `withdraw` (§5.2) | **H-01** | ~10 lines | Removes the operator's ability to declare 100% of a balance a "fee". |
| 3 | **Merchant exit path** — bounded by a recorded entitlement, or an explicit documented statement that none exists (§5.3) | **H-02** | Medium–Large | Without it, a lost operator key plus a lost owner key is total loss, and the merchant has no recourse. |
| 4 | **Token allowlist + written token assumptions** (§5.4) | **H-04** | Small–Medium | Converts silent ledger drift into a deploy-time rejection. |
| 5 | **Pin `evm_version`** after confirming the target chain's revision; add a pinned CI job (§5.7) | **M-02** | 1 line + CI | A wrong target is a funds-received-then-unreachable failure. Must be settled before any deploy. |
| 6 | **Delete/regenerate the stale `broadcast/` artifact; keystore signing; required `OPERATOR`; fork test of the deploy script** (§5.7) | **M-08** | Small | The artifact on disk deploys the *previous* factory; the script leaks a raw key while documenting a keystore. |
| 7 | **Build the backend settlement ledger, or explicitly declare the trust boundary** (§5.2/H-03) | **H-03** | Large | The invariant `gross = merchant + x402Go + facilitator` must be owned by something. Today it is owned by nothing. |
| 8 | **`withdrawFees` event; consider an immutable `feeRecipient`** (§5.6) | **M-01** | Small | Makes fee outflows observable; the fee destination is currently owner-chosen at sweep time and unlogged. |
| 9 | **Two-step timelocked `setOperator`; override `renounceOwnership`; reject a zero operator in the constructor; move ownership to a multisig** (§5.5) | **M-06, M-07** | Small–Medium | The owner key is the only recovery lever; it should not be able to destroy that lever or install a thief atomically. |
| 10 | **Decide and document the fee model: two legs or three** (§5.3 M-05) | **M-05** | Small (decision) | Determines whether `facilitatorFee` is netted by convention or paid directly. Cheap now, a redeploy later. |
| 11 | **Merchant authority rotation; document that the merchant key must not be a browser hot wallet** (§5.3 M-03) | **M-03** | Medium | Turns a permanent key compromise into a recoverable one. |
| 12 | **Explicit low-s check, or document malleability and dedupe by nonce off chain** (§5.3 M-04) | **M-04** | 1 line | Prevents idempotency bugs in the settlement API before that API exists. |
| 13 | **Reject `payout == address(this)` and `payout == FACTORY`** (§5.3 L-01) | **L-01** | 2 lines | Unambiguous mistakes with no legitimate use. |
| 14 | **Make the implementation explicitly inert; document that it must never hold value** (§5.3 L-02) | **L-02** | Small | Removes reliance on incidental safety. |
| 15 | **Add `[invariant]` tests and the §6.1 test list** | Coverage | Medium | Unit tests cannot express "the sum of all fee legs equals the factory balance". |
| 16 | **Distinct error names per contract** (§5.3 I-01) | I-01 | 2 lines | Cosmetic, but cheap while nothing depends on the current selectors. |

**Sequencing.** 1, 2, 5, 6, 13 and 16 are small, independent, and can land together as one change with their tests — that single batch is enough to make the core security proposition true and the deployment path safe. 3, 4, 7 and 11 are the medium-term items and should be designed before the backend is built, so the backend and the chain share one shape rather than two. Item 7 in particular should be settled *before* the settlement ledger is written, not after — it determines whether the backend is a system of record or a convenience layer over an on-chain one.

**What not to build.** No upgrade proxy, no `nonReentrant`, no OpenZeppelin migration. Each adds surface without addressing a finding in this report (§5.8).
