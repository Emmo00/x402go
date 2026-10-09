// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {X402Base} from "./utils/X402Base.sol";
import {X402Vault} from "../src/X402Vault.sol";
import {IX402Vault} from "../src/interfaces/IX402Vault.sol";
import {IX402VaultFactory} from "../src/interfaces/IX402VaultFactory.sol";
import {IPermit2} from "../src/interfaces/IPermit2.sol";
import {IX402ExactPermit2Proxy} from "../src/interfaces/IX402ExactPermit2Proxy.sol";
import {MockERC20} from "./utils/Mocks.sol";
import {Ownable} from "solady/auth/Ownable.sol";

/// @dev Suite F — fee configuration and the decimals-derived fee formula.
contract FeeConfigurationTest is X402Base {
    function test_setTokenFees_isOwnerOnly() public {
        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(stranger);
        factory.setTokenFees(_addrs(address(token6)), _bps(DEFAULT_BPS));

        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(operator);
        factory.setTokenFees(_addrs(address(token6)), _bps(DEFAULT_BPS));
    }

    function test_setTokenFees_rejectsMismatchedLengths() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(token6);
        tokens[1] = address(token18);

        vm.expectRevert(IX402VaultFactory.LengthMismatch.selector);
        vm.prank(owner);
        factory.setTokenFees(tokens, _bps(DEFAULT_BPS));
    }

    function test_setTokenFees_emitsFeeUpdatedPerToken() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(token6);
        tokens[1] = address(token18);

        uint16[] memory fees = new uint16[](2);
        fees[0] = 10;
        fees[1] = 250;

        vm.expectEmit(true, false, false, true, address(factory));
        emit IX402VaultFactory.FeeUpdated(address(token6), 10);
        vm.expectEmit(true, false, false, true, address(factory));
        emit IX402VaultFactory.FeeUpdated(address(token18), 250);

        vm.prank(owner);
        factory.setTokenFees(tokens, fees);

        assertEq(factory.tokenFeeBPS(address(token6)), 10);
        assertEq(factory.tokenFeeBPS(address(token18)), 250);
    }

    function test_setTokenFees_emptyCallIsAllowed() public {
        // No early `return` on an empty array and no minimum: a no-op call is legal.
        vm.prank(owner);
        factory.setTokenFees(new address[](0), new uint16[](0));
    }

    // ------------------------------------------------------------- the formula

    function test_tokenFee_sixDecimals() public {
        _configure(address(token6), 10);
        // 10 bps of 1e6 = 1_000 units = 0.001 USDC.
        assertEq(_fee(address(token6)), 1_000);
    }

    function test_tokenFee_eighteenDecimals() public {
        _configure(address(token18), 10);
        // 10 bps of 1e18 = 1e15 wei.
        assertEq(_fee(address(token18)), 1e15);
    }

    function test_tokenFee_zeroDecimals() public {
        MockERC20 zero = new MockERC20("Zero", "ZRO", 0);
        _configure(address(zero), 500); // 5% of one whole unit
        assertEq(_fee(address(zero)), 0, "0.05 of a 0-decimal unit truncates to nothing");

        _configure(address(zero), 10_000); // 100%
        assertEq(_fee(address(zero)), 1);
    }

    function test_tokenFee_unconfiguredTokenIsZero() public view {
        assertEq(factory.tokenFeeBPS(address(token6)), 0);
        assertEq(_fee(address(token6)), 0);
    }

    function test_tokenFee_derivesFromTheSingleStoredBps() public {
        // The "no per-token absolute fee" decision, made observable: one stored basis-point figure
        // per token, and the fee is a pure function of it and the token's own decimals.
        _configure(address(token6), 100);
        _configure(address(token18), 100);

        assertEq(factory.tokenFeeBPS(address(token6)), 100);
        assertEq(factory.tokenFeeBPS(address(token18)), 100);

        assertEq(_fee(address(token6)), 10_000); // 100 bps of 1e6
        assertEq(_fee(address(token18)), 1e16); // 100 bps of 1e18
        assertEq(_fee(address(token18)) / _fee(address(token6)), 1e12); // only the decimals differ
    }

    function test_setTokenFees_canResetToZero() public {
        _configure(address(token6), 10);
        assertTrue(factory.tokenFeeBPS(address(token6)) > 0);

        _configure(address(token6), 0);
        assertEq(factory.tokenFeeBPS(address(token6)), 0);
    }

    function test_setTokenFees_overwrites() public {
        _configure(address(token6), 10);
        _configure(address(token6), 999);
        assertEq(factory.tokenFeeBPS(address(token6)), 999);
    }

    function test_tokenFeeBpsGetterRoundTrips() public {
        _configure(address(token6), 4_242);
        assertEq(factory.tokenFeeBPS(address(token6)), 4_242);
    }

    function test_tokenFee_revertsForANonContractAddress() public {
        // `tokenFee` reads `decimals()` off the token, so an EOA is a hard failure rather than a
        // silent zero.
        vm.expectRevert();
        factory.tokenFee(makeAddr("notAContract"));
    }

    // ------------------------------------------------------------------- fuzz

    function testFuzz_tokenFeeBpsRoundTrips(uint16 bps) public {
        _configure(address(token6), bps);
        assertEq(factory.tokenFeeBPS(address(token6)), bps);
        assertEq(_fee(address(token6)), (uint256(bps) * 1e6) / 10_000);
    }

    /// @dev Bounded below the global 10_000 runs: each iteration deploys a token.
    /// forge-config: default.fuzz.runs = 256
    function testFuzz_tokenFeeMatchesTheReferenceFormula(uint16 bps, uint8 decimals) public {
        decimals = uint8(bound(decimals, 0, 18));
        MockERC20 t = new MockERC20("Fuzz", "FZ", decimals);

        _configure(address(t), bps);

        assertEq(_fee(address(t)), (uint256(bps) * (10 ** decimals)) / 10_000);
    }

    // ------------------------------------------- rounding to zero is not settleable

    function test_unconfiguredTokenCannotBeSettled() public {
        address vault = _openVault();
        token6.mint(payer, 1_000e6);

        IX402Vault.Eip3009Authorization memory auth =
            _auth3009(payerPk, address(token6), vault, 100e6, keccak256("unconfigured"));

        vm.expectRevert(IX402Vault.TokenNotSupported.selector);
        vm.prank(stranger);
        X402Vault(vault).settle(address(token6), auth);
    }

    function test_aTokenWhoseFeeRoundsToZeroCannotBeSettled() public {
        // `tokenFeeBPS > 0` does not imply a non-zero fee: 1 bp of a 2-decimal token truncates to
        // nothing, and the vault's second check turns that misconfiguration into a loud revert
        // rather than a silent fee-free settlement.
        MockERC20 low = new MockERC20("Low", "LOW", 2);
        _configure(address(low), 1);

        assertTrue(factory.tokenFeeBPS(address(low)) > 0);
        assertEq(_fee(address(low)), 0);

        address vault = _openVault();
        low.mint(payer, 1_000);

        IX402Vault.Eip3009Authorization memory auth =
            _auth3009(payerPk, address(low), vault, 100, keccak256("rounds-to-zero"));

        vm.expectRevert(IX402Vault.TokenNotSupported.selector);
        vm.prank(stranger);
        X402Vault(vault).settle(address(low), auth);
    }

    function test_aTokenWhoseFeeRoundsToZeroCannotBeSettledViaPermit2Either() public {
        _installPermit2();

        MockERC20 low = new MockERC20("Low", "LOW", 2);
        _configure(address(low), 1);

        address vault = _openVault();
        low.mint(payer, 1_000);
        _approvePermit2(address(low), payer);

        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
            _permit2Args(payerPk, vault, address(low), 100, uint256(keccak256("low-nonce")));

        vm.expectRevert(IX402Vault.TokenNotSupported.selector);
        vm.prank(stranger);
        X402Vault(vault).settleWithPermit2(permit, payer, wit, sig);
    }
}
