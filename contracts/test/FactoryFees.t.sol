// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {X402Base} from "./utils/X402Base.sol";
import {IX402VaultFactory} from "../src/interfaces/IX402VaultFactory.sol";
import {MockERC20} from "./utils/Mocks.sol";
import {Ownable} from "solady/auth/Ownable.sol";

/// @dev Suite J — the factory as fee sink: accumulation, sweeping and the withdrawal event.
contract FactoryFeesTest is X402Base {
    address internal merchant2 = makeAddr("merchant2");

    function _sweep(address[] memory tokens, address recipient) internal {
        vm.prank(owner);
        factory.withdrawFees(tokens, recipient);
    }

    // ------------------------------------------------------------ access control

    function test_withdrawFees_isOwnerOnly() public {
        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(stranger);
        factory.withdrawFees(_addrs(address(token6)), feeRecipient);

        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(operator);
        factory.withdrawFees(_addrs(address(token6)), feeRecipient);
    }

    function test_withdrawFees_rejectsZeroRecipient() public {
        vm.expectRevert(IX402VaultFactory.InvalidAddress.selector);
        vm.prank(owner);
        factory.withdrawFees(_addrs(address(token6)), address(0));
    }

    function test_withdrawFees_rejectsZeroRecipientEvenWithNothingToSweep() public {
        // The recipient check is first, so a sweep of an empty list to address(0) is still refused
        // rather than silently doing nothing.
        vm.expectRevert(IX402VaultFactory.InvalidAddress.selector);
        vm.prank(owner);
        factory.withdrawFees(new address[](0), address(0));
    }

    // ------------------------------------------------------------------ sweeping

    function test_withdrawFees_emptyTokenListIsAllowed() public {
        _sweep(new address[](0), feeRecipient);
    }

    function test_withdrawFees_sweepsSeveralTokens() public {
        token6.mint(address(factory), 1_000e6);
        token18.mint(address(factory), 5e18);
        address third = address(new MockERC20("Third", "TRD", 8));
        MockERC20(third).mint(address(factory), 42e8);

        address[] memory tokens = new address[](3);
        tokens[0] = address(token6);
        tokens[1] = address(token18);
        tokens[2] = third;

        _sweep(tokens, feeRecipient);

        assertEq(token6.balanceOf(feeRecipient), 1_000e6);
        assertEq(token18.balanceOf(feeRecipient), 5e18);
        assertEq(MockERC20(third).balanceOf(feeRecipient), 42e8);

        assertEq(token6.balanceOf(address(factory)), 0);
        assertEq(token18.balanceOf(address(factory)), 0);
        assertEq(MockERC20(third).balanceOf(address(factory)), 0);
    }

    function test_withdrawFees_emitsTheAmountPerToken() public {
        token6.mint(address(factory), 1_000e6);

        vm.expectEmit(true, true, false, true, address(factory));
        emit IX402VaultFactory.FeesWithdrawn(address(token6), feeRecipient, 1_000e6);

        _sweep(_addrs(address(token6)), feeRecipient);
    }

    function test_withdrawFees_zeroBalanceStillEmits() public {
        // The brief's point: the event records that the token was *visited*. A drained token and a
        // token nobody has paid in are otherwise indistinguishable from the outside.
        vm.expectEmit(true, true, false, true, address(factory));
        emit IX402VaultFactory.FeesWithdrawn(address(token6), feeRecipient, 0);

        _sweep(_addrs(address(token6)), feeRecipient);
    }

    function test_withdrawFees_repeatedSweepEmitsAnExplicitZero() public {
        token6.mint(address(factory), 7e6);

        vm.expectEmit(true, true, false, true, address(factory));
        emit IX402VaultFactory.FeesWithdrawn(address(token6), feeRecipient, 7e6);
        _sweep(_addrs(address(token6)), feeRecipient);

        vm.expectEmit(true, true, false, true, address(factory));
        emit IX402VaultFactory.FeesWithdrawn(address(token6), feeRecipient, 0);
        _sweep(_addrs(address(token6)), feeRecipient);

        assertEq(token6.balanceOf(feeRecipient), 7e6);
    }

    function test_withdrawFees_emitsForEveryTokenEvenWhenOnlyOneHasABalance() public {
        token18.mint(address(factory), 3e18);

        address[] memory tokens = new address[](2);
        tokens[0] = address(token6);
        tokens[1] = address(token18);

        vm.expectEmit(true, true, false, true, address(factory));
        emit IX402VaultFactory.FeesWithdrawn(address(token6), feeRecipient, 0);
        vm.expectEmit(true, true, false, true, address(factory));
        emit IX402VaultFactory.FeesWithdrawn(address(token18), feeRecipient, 3e18);

        _sweep(tokens, feeRecipient);
    }

    // -------------------------------------------------------------- accumulation

    function test_feesAccumulateAcrossVaultsAndTokens() public {
        _configure(address(token6), 10);
        _configure(address(token18), 250);

        address v1 = _deploy(merchant, merchant);
        address v2 = _deploy(merchant2, merchant2);

        token6.mint(payer, 1_000e6);
        token18.mint(payer, 10e18);

        _pay3009(payerPk, v1, address(token6), 100e6, keccak256("a"));
        _pay3009(payerPk, v1, address(token6), 50e6, keccak256("b"));
        _pay3009(payerPk, v2, address(token18), 2e18, keccak256("c"));

        uint256 fee6 = _fee(address(token6));
        uint256 fee18 = _fee(address(token18));

        assertEq(token6.balanceOf(address(factory)), fee6 * 2);
        assertEq(token18.balanceOf(address(factory)), fee18);
    }

    function test_factoryBalanceEqualsTheSumOfFeesPaid() public {
        _configure(address(token6), 10);

        address v1 = _deploy(merchant, merchant);
        address v2 = _deploy(merchant2, merchant2);

        token6.mint(payer, 1_000e6);
        uint256 fee = _fee(address(token6));

        uint256 expected;
        for (uint256 i; i < 4; ++i) {
            _pay3009(payerPk, i % 2 == 0 ? v1 : v2, address(token6), 25e6, keccak256(abi.encode("pay", i)));
            expected += fee;
            assertEq(token6.balanceOf(address(factory)), expected);
        }
    }

    function test_settlementFeesSurviveTheWithdrawal() public {
        _configure(address(token6), 10);

        address vault = _deploy(merchant, merchant);
        token6.mint(payer, 1_000e6);
        _pay3009(payerPk, vault, address(token6), 100e6, keccak256("pay"));

        uint256 fee = _fee(address(token6));
        assertEq(token6.balanceOf(address(factory)), fee);

        _sweep(_addrs(address(token6)), feeRecipient);

        assertEq(token6.balanceOf(feeRecipient), fee);
        assertEq(token6.balanceOf(address(factory)), 0);
        // The merchant's leg is untouched by the sweep.
        assertEq(token6.balanceOf(merchant), 100e6 - fee);
    }

    function test_withdrawFees_cannotReachAVaultsBalance() public {
        // The factory can only sweep what it holds; a vault's funds are not reachable through it.
        address vault = _deploy(merchant, merchant);
        token6.mint(vault, 5e6);

        _sweep(_addrs(address(token6)), feeRecipient);

        assertEq(token6.balanceOf(feeRecipient), 0);
        assertEq(token6.balanceOf(vault), 5e6);
    }
}
