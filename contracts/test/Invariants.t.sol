// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {X402Base} from "./utils/X402Base.sol";
import {X402Signing} from "./utils/X402Signing.sol";
import {X402Vault} from "../src/X402Vault.sol";
import {X402VaultFactory} from "../src/X402VaultFactory.sol";
import {IX402Vault} from "../src/interfaces/IX402Vault.sol";
import {IPermit2} from "../src/interfaces/IPermit2.sol";
import {IX402ExactPermit2Proxy} from "../src/interfaces/IX402ExactPermit2Proxy.sol";
import {MockERC20} from "./utils/Mocks.sol";

/// @dev Everything the handler needs to build its own world. A struct rather than a dozen
/// positional arguments: the legacy codegen runs out of stack long before this.
struct VaultHandlerConfig {
    X402VaultFactory factory;
    MockERC20 token;
    address owner;
    address operator;
    address feeRecipient;
    address payer;
    uint256 payerPk;
    /// @dev Four merchants. The first two arrive with a vault; the last two get one from the
    /// handler, so vault creation is inside the fuzzed state space.
    address[4] merchants;
    /// @dev Only the first two ever sign a payout change; the spares keep `payout == merchant`.
    uint256[2] merchantPks;
    address extraPayout;
    address[2] prebuiltVaults;
}

/// @dev Drives a fixed world of two tokens-worth of state through every entry point the vault has,
/// recording what the accounting *should* add up to in ghost variables.
///
/// Every action leaves the vault balance at zero, so any token the handler minted must be sitting in
/// one of the tracked holders. That is what makes the conservation invariant meaningful rather than
/// a restatement of ERC20's own supply accounting.
contract VaultInvariantHandler is X402Signing {
    X402VaultFactory internal immutable factory;
    MockERC20 internal immutable token;
    address internal immutable owner;
    address internal immutable operator;
    address internal immutable feeRecipient;
    address internal immutable payer;
    uint256 internal immutable payerPk;
    address internal immutable extraPayout;

    address[4] internal merchants;
    uint256[2] internal merchantPks;
    bool[2] internal spareCreated;

    address[] internal activeVaults;
    address[] internal activeMerchants;
    address[] internal holders;

    uint256 public ghostMinted;
    uint256 public ghostFeesCharged;
    uint256 public ghostFeesWithdrawn;
    uint256 internal nonceCounter;

    constructor(VaultHandlerConfig memory c) {
        factory = c.factory;
        token = c.token;
        owner = c.owner;
        operator = c.operator;
        feeRecipient = c.feeRecipient;
        payer = c.payer;
        payerPk = c.payerPk;
        extraPayout = c.extraPayout;
        merchants = c.merchants;
        merchantPks = c.merchantPks;

        activeVaults.push(c.prebuiltVaults[0]);
        activeVaults.push(c.prebuiltVaults[1]);
        activeMerchants.push(c.merchants[0]);
        activeMerchants.push(c.merchants[1]);

        holders.push(payer);
        holders.push(address(factory));
        holders.push(feeRecipient);
        holders.push(extraPayout);
        holders.push(c.merchants[0]);
        holders.push(c.merchants[1]);
        holders.push(c.merchants[2]);
        holders.push(c.merchants[3]);
        holders.push(c.prebuiltVaults[0]);
        holders.push(c.prebuiltVaults[1]);
    }

    // ------------------------------------------------------------------ getters

    function activeVaultsLength() external view returns (uint256) {
        return activeVaults.length;
    }

    function activeVault(uint256 i) external view returns (address) {
        return activeVaults[i];
    }

    function activeMerchant(uint256 i) external view returns (address) {
        return activeMerchants[i];
    }

    function holdersLength() external view returns (uint256) {
        return holders.length;
    }

    function holder(uint256 i) external view returns (address) {
        return holders[i];
    }

    // ------------------------------------------------------------------ actions

    function createVault(uint256 seed) external {
        uint256 idx = seed % 2;
        if (spareCreated[idx]) return;
        spareCreated[idx] = true;

        address m = merchants[2 + idx];

        vm.prank(operator);
        address v = factory.createVault(m, m);

        activeVaults.push(v);
        activeMerchants.push(m);
        holders.push(v);
    }

    function settleEip3009(uint256 vaultSeed, uint96 valueSeed) external {
        _settle(vaultSeed, valueSeed, false);
    }

    function settlePermit2(uint256 vaultSeed, uint96 valueSeed) external {
        _settle(vaultSeed, valueSeed, true);
    }

    function rescueStray(uint256 vaultSeed, uint96 amountSeed) external {
        address vault = activeVaults[vaultSeed % activeVaults.length];

        uint256 fee = factory.tokenFee(address(token));
        uint256 amount = bound(uint256(amountSeed), fee + 1, 1e24);

        token.mint(vault, amount);
        ghostMinted += amount;

        X402Vault(vault).rescue(address(token));

        ghostFeesCharged += fee;
    }

    function changePayout(uint256 vaultSeed, uint256 payoutSeed) external {
        uint256 i = vaultSeed % 2;
        address vault = activeVaults[i];

        address newPayout = payoutSeed % 3 == 0 ? merchants[0] : payoutSeed % 3 == 1 ? merchants[1] : extraPayout;

        uint256 deadline = _deadline();
        // Read the nonce before signing: the handler must sign whatever the vault is currently on.
        uint256 n = X402Vault(vault).nonce();
        bytes memory sig = _sig(merchantPks[i], vault, newPayout, n, deadline);

        // Permissionless: the signature is the authority.
        X402Vault(vault).changePayout(newPayout, deadline, sig);
    }

    function rotateFees(uint16 bps) external {
        // Never zero: a token priced at nothing cannot be settled at all, and this suite is about
        // what happens to tokens that *can* move.
        uint16 bounded = uint16(bound(uint256(bps), 1, 10_000));

        vm.prank(owner);
        factory.setTokenFees(_addrs(address(token)), _bps(bounded));
    }

    function withdrawFees() external {
        ghostFeesWithdrawn += token.balanceOf(address(factory));

        vm.prank(owner);
        factory.withdrawFees(_addrs(address(token)), feeRecipient);
    }

    // ------------------------------------------------------------------ internals

    function _settle(uint256 vaultSeed, uint96 valueSeed, bool viaPermit2) private {
        address vault = activeVaults[vaultSeed % activeVaults.length];

        uint256 fee = factory.tokenFee(address(token));
        uint256 value = bound(uint256(valueSeed), fee + 1, 1e24);

        token.mint(payer, value);
        ghostMinted += value;

        nonceCounter += 1;

        if (viaPermit2) {
            // A single counter keeps both nonce spaces disjoint and collision-free across the
            // whole sequence, so a revert here would be a real finding and not a replay.
            (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
                _permit2Args(payerPk, vault, address(token), value, nonceCounter);
            X402Vault(vault).settleWithPermit2(permit, payer, wit, sig);
        } else {
            IX402Vault.Eip3009Authorization memory auth =
                _auth3009(payerPk, address(token), vault, value, bytes32(nonceCounter));
            X402Vault(vault).settle(address(token), auth);
        }

        ghostFeesCharged += fee;
    }
}

/// @dev Suite L — stateful invariants.
contract InvariantsTest is X402Base {
    VaultInvariantHandler internal handler;
    address internal merchant2;

    /// @dev Invariants are re-checked after *every* call in the sequence, so each one has to be
    /// cheap: see the `[invariant]` budget in foundry.toml. The per-vault assertions are therefore
    /// folded into a single loop rather than spread across four functions that would each re-read
    /// the same storage.
    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 48
    function setUp() public override {
        super.setUp();

        // 18 decimals throughout: a basis point of 1e18 is never zero, so `rotateFees` cannot put
        // the world into the "configured but rounds to nothing" state that has its own suites.
        _configure(address(token18), DEFAULT_BPS);
        _installPermit2();

        // A real key, not `makeAddr`: the second merchant has to be able to sign a payout change, or
        // half the handler's `changePayout` calls would revert for want of a signer.
        uint256 merchant2Pk = 0xCAFE;
        merchant2 = vm.addr(merchant2Pk);

        address vault1 = _deploy(merchant, merchant);
        address vault2 = _deploy(merchant2, merchant2);

        VaultHandlerConfig memory config = VaultHandlerConfig({
            factory: factory,
            token: token18,
            owner: owner,
            operator: operator,
            feeRecipient: feeRecipient,
            payer: payer,
            payerPk: payerPk,
            merchants: [merchant, merchant2, makeAddr("spareA"), makeAddr("spareB")],
            merchantPks: [merchantPk, merchant2Pk],
            extraPayout: makeAddr("extraPayout"),
            prebuiltVaults: [vault1, vault2]
        });

        handler = new VaultInvariantHandler(config);
        targetContract(address(handler));
    }

    // ---------------------------------------------------------------- invariants

    /// @dev Every token the handler minted is still somewhere the handler knows about. A settlement
    /// that leaked value — to a wrong recipient, or into limbo — would break this.
    function invariant_tokenIsConserved() public view {
        uint256 sum;
        uint256 n = handler.holdersLength();
        for (uint256 i; i < n; ++i) {
            sum += token18.balanceOf(handler.holder(i));
        }

        assertEq(sum, handler.ghostMinted(), "tokens left the tracked world");
    }

    /// @dev The L02 property plus the vault's immovable state, under fuzz:
    ///
    /// - no vault is ever left holding a balance, whatever mixture of settlement, rescue and payout
    ///   change preceded it;
    /// - `payout()` is never the zero address (`_payout` falls back to `merchant()`);
    /// - `merchant()` — a clone argument, not storage — is exactly the merchant the vault was
    ///   created for, through any number of payout changes;
    /// - `nonce` stays far inside its 96-bit field and only a payout change ever writes it.
    function invariant_vaultsAreWellFormed() public view {
        uint256 n = handler.activeVaultsLength();
        for (uint256 i; i < n; ++i) {
            address vault = handler.activeVault(i);

            assertEq(token18.balanceOf(vault), 0, "a vault was left holding tokens");

            X402Vault v = X402Vault(vault);
            assertTrue(v.payout() != address(0), "payout fell through to zero");
            assertEq(v.merchant(), handler.activeMerchant(i), "the merchant changed");
            assertLe(v.nonce(), 1_000_000, "the nonce ran away");
        }
    }

    /// @dev The factory's balance is exactly the fees it has charged and not yet paid out — the fee
    /// accounting reconciles at every point in the sequence, not just at the end.
    function invariant_factoryBalanceReconcilesWithFees() public view {
        assertEq(
            token18.balanceOf(address(factory)),
            handler.ghostFeesCharged() - handler.ghostFeesWithdrawn(),
            "the factory's balance drifted from the fees it charged"
        );
    }

    /// @dev Multiple vaults for the same factory must never collide.
    function invariant_vaultsAreDistinct() public view {
        uint256 n = handler.activeVaultsLength();
        for (uint256 i; i < n; ++i) {
            for (uint256 j = i + 1; j < n; ++j) {
                assertTrue(handler.activeVault(i) != handler.activeVault(j));
            }
        }
    }
}
