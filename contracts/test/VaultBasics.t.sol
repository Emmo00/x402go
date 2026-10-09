// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {X402Base} from "./utils/X402Base.sol";
import {X402Vault} from "../src/X402Vault.sol";
import {IX402Vault} from "../src/interfaces/IX402Vault.sol";

/// @dev Suite D — vault-level basics: payout initialisation, implementation isolation, and the
/// storage layout the vault depends on.
contract VaultBasicsTest is X402Base {
    address internal vault;

    function setUp() public override {
        super.setUp();
        vault = _openVault();
    }

    // -------------------------------------------------------------- initPayout

    function test_initPayout_onlyFromTheFactory() public {
        vm.expectRevert(IX402Vault.Unauthorized.selector);
        vm.prank(stranger);
        X402Vault(vault).initPayout(payoutAddr);

        vm.expectRevert(IX402Vault.Unauthorized.selector);
        vm.prank(merchant);
        X402Vault(vault).initPayout(payoutAddr);

        vm.expectRevert(IX402Vault.Unauthorized.selector);
        vm.prank(owner);
        X402Vault(vault).initPayout(payoutAddr);
    }

    function test_initPayout_rejectsZero() public {
        vm.expectRevert(IX402Vault.InvalidAddress.selector);
        vm.prank(address(factory));
        X402Vault(vault).initPayout(address(0));
    }

    function test_initPayout_isOneShot() public {
        address withOverride = _deploy(makeAddr("m2"), payoutAddr);

        vm.expectRevert(IX402Vault.AlreadyInitialized.selector);
        vm.prank(address(factory));
        X402Vault(withOverride).initPayout(payoutAddr);
    }

    function test_initPayout_remainsOpenWhenThePayoutWasNotOverridden() public {
        // Documented consequence of the one-shot guard testing `_payout != 0`: when the factory
        // skips the override because `payout == merchant`, the slot stays zero and the factory
        // could still set it. Unreachable through `createVault`, which refuses a second vault for
        // the same merchant, but it is why the guard is not "has been initialised" in general.
        assertEq(uint256(vm.load(vault, bytes32(uint256(0)))), 0);

        vm.prank(address(factory));
        X402Vault(vault).initPayout(payoutAddr);

        assertEq(X402Vault(vault).payout(), payoutAddr);
    }

    // ------------------------------------------------- implementation isolation

    function test_directCallsToTheImplementationDoNotAffectClones() public {
        address implementation = factory.implementation();

        // The implementation has no clone args, so it has no merchant and cannot be initialised by
        // anyone but the factory. Nothing about the live clone changes.
        vm.expectRevert(IX402Vault.Unauthorized.selector);
        IX402Vault(implementation).initPayout(payoutAddr);

        assertEq(X402Vault(vault).merchant(), merchant);
        assertEq(X402Vault(vault).payout(), merchant);
        assertEq(X402Vault(vault).nonce(), 0);
    }

    function test_implementationHoldsNoFundsAndCannotBeSettled() public {
        address implementation = factory.implementation();
        _configure(address(token6), DEFAULT_BPS);

        // `merchant()` reads clone args that are not there, so the implementation's payout is not
        // the merchant's — and it holds nothing, so there is nothing to take either way.
        assertEq(token6.balanceOf(implementation), 0);
        assertTrue(X402Vault(implementation).merchant() != merchant);
    }

    function test_plainEthTransferToAVaultReverts() public {
        vm.deal(address(this), 1 ether);

        (bool ok,) = vault.call{value: 1 ether}("");
        assertFalse(ok, "the vault has no receive/fallback and must reject plain ETH");
        assertEq(vault.balance, 0);
    }

    function test_clonesAreIndependentInstances() public {
        address merchant2 = makeAddr("merchant2");
        address vault2 = _deploy(merchant2, merchant2);

        vm.prank(address(factory));
        X402Vault(vault).initPayout(payoutAddr);

        assertEq(X402Vault(vault).payout(), payoutAddr);
        assertEq(X402Vault(vault2).payout(), merchant2);
        assertEq(X402Vault(vault2).merchant(), merchant2);
    }

    // ------------------------------------------------------------ storage packing

    function test_payoutAndNonceShareSlotZero() public {
        // Slot 0 is entirely the vault's: it inherits an interface (no storage) and solady's EIP712
        // (immutables only), so `_payout` occupies the low 20 bytes and `nonce` the next 12.
        assertEq(uint256(vm.load(vault, bytes32(uint256(0)))), 0, "fresh vault");

        uint256 deadline = _deadline();
        bytes memory sig = _sig(merchantPk, vault, payoutAddr, 0, deadline);

        vm.prank(merchant);
        X402Vault(vault).changePayout(payoutAddr, deadline, sig);

        uint256 packed = uint256(vm.load(vault, bytes32(uint256(0))));
        // The truncation is the assertion: only the low 20 bytes carry the address.
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(address(uint160(packed)), payoutAddr, "payout is the low 20 bytes");
        assertEq(packed >> 160, 1, "nonce is the next 12 bytes");

        // And the view functions agree with the raw slot.
        assertEq(X402Vault(vault).payout(), payoutAddr);
        assertEq(X402Vault(vault).nonce(), 1);
        assertEq(uint256(vm.load(vault, bytes32(uint256(1)))), 0, "nothing else was written");
    }
}
