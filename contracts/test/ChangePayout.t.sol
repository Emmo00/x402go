// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {X402Base} from "./utils/X402Base.sol";
import {X402PaymentRelayer} from "../src/X402PaymentRelayer.sol";
import {IX402PaymentRelayer} from "../src/interfaces/IX402PaymentRelayer.sol";
import {Mock1271Wallet} from "./utils/Mocks.sol";

/// @dev Suite E — `changePayout`, which is the merchant's only lever over a vault an operator
/// created and named a payout for.
contract ChangePayoutTest is X402Base {
    address internal vault;

    function setUp() public override {
        super.setUp();
        vault = _openVault();
    }

    function _change(address caller, address newPayout, uint256 deadline, bytes memory sig) internal {
        vm.prank(caller);
        X402PaymentRelayer(vault).changePayout(newPayout, deadline, sig);
    }

    // -------------------------------------------------------------- happy paths

    function test_eoaMerchantSignatureWorks() public {
        uint256 deadline = _deadline();
        bytes memory sig = _sig(merchantPk, vault, payoutAddr, 0, deadline);

        _change(stranger, payoutAddr, deadline, sig);

        assertEq(X402PaymentRelayer(vault).payout(), payoutAddr);
        assertEq(X402PaymentRelayer(vault).nonce(), 1);
    }

    function test_erc1271MerchantWorks() public {
        Mock1271Wallet wallet = new Mock1271Wallet();
        address walletVault = _deploy(address(wallet), address(wallet));

        uint256 deadline = _deadline();
        wallet.approve(_digest(walletVault, payoutAddr, 0, deadline));

        vm.prank(stranger);
        X402PaymentRelayer(walletVault).changePayout(payoutAddr, deadline, hex"");

        assertEq(X402PaymentRelayer(walletVault).payout(), payoutAddr);
        assertEq(X402PaymentRelayer(walletVault).nonce(), 1);
    }

    function test_compactEip2098SignatureWorks() public {
        uint256 deadline = _deadline();
        bytes memory sig = _compactSig(merchantPk, vault, payoutAddr, 0, deadline);

        _change(stranger, payoutAddr, deadline, sig);

        assertEq(X402PaymentRelayer(vault).payout(), payoutAddr);
    }

    function test_anyoneCanRelayAValidMerchantSignature() public {
        uint256 deadline = _deadline();
        bytes memory sig = _sig(merchantPk, vault, payoutAddr, 0, deadline);

        // The signature is the authorisation; the caller is not. `changePayout` is deliberately
        // open so the merchant never has to hold gas.
        vm.prank(owner);
        X402PaymentRelayer(vault).changePayout(payoutAddr, deadline, sig);

        assertEq(X402PaymentRelayer(vault).payout(), payoutAddr);
    }

    function test_resettingBackToTheMerchantWorks() public {
        uint256 deadline = _deadline();
        _change(stranger, payoutAddr, deadline, _sig(merchantPk, vault, payoutAddr, 0, deadline));
        assertEq(X402PaymentRelayer(vault).payout(), payoutAddr);

        uint256 deadline2 = deadline + 1;
        vm.expectEmit(true, true, false, true, vault);
        emit IX402PaymentRelayer.PayoutChanged(merchant, merchant);
        _change(stranger, merchant, deadline2, _sig(merchantPk, vault, merchant, 1, deadline2));

        assertEq(X402PaymentRelayer(vault).payout(), merchant);
        uint256 packed = uint256(vm.load(vault, bytes32(uint256(0))));
        assertEq(packed >> 160, 2, "nonce, in the high bits");
        // Safe: the low 20 bytes are the address by construction; this is the layout under test.
        // forge-lint: disable-next-line(unsafe-typecast)
        assertTrue(address(uint160(packed)) == merchant, "payout, in the low bits");
    }

    function test_payoutChangedEventCarriesTheMerchantNotTheCaller() public {
        uint256 deadline = _deadline();
        bytes memory sig = _sig(merchantPk, vault, payoutAddr, 0, deadline);

        vm.expectEmit(true, true, false, true, vault);
        emit IX402PaymentRelayer.PayoutChanged(merchant, payoutAddr);

        _change(stranger, payoutAddr, deadline, sig);
    }

    // ------------------------------------------------------------------ deadline

    function test_deadlineEqualToBlockTimestampPasses() public {
        uint256 deadline = block.timestamp;
        bytes memory sig = _sig(merchantPk, vault, payoutAddr, 0, deadline);

        _change(stranger, payoutAddr, deadline, sig);

        assertEq(X402PaymentRelayer(vault).payout(), payoutAddr);
    }

    function test_expiredDeadlineRevertsWithItsOwnError() public {
        uint256 deadline = block.timestamp;
        bytes memory sig = _sig(merchantPk, vault, payoutAddr, 0, deadline);

        vm.warp(block.timestamp + 1);

        vm.expectRevert(IX402PaymentRelayer.SignatureExpired.selector);
        _change(stranger, payoutAddr, deadline, sig);
    }

    function test_expiryIsCheckedBeforeTheSignature() public {
        // A garbage signature with an expired deadline must report expiry, not an invalid
        // signature — otherwise the error tells a caller nothing about which input to fix.
        vm.warp(block.timestamp + 10);
        uint256 deadline = block.timestamp - 1;

        vm.expectRevert(IX402PaymentRelayer.SignatureExpired.selector);
        _change(stranger, payoutAddr, deadline, hex"deadbeef");
    }

    // -------------------------------------------------------------------- nonce

    function test_replayWithTheSameNonceFails() public {
        uint256 deadline = _deadline();
        bytes memory sig = _sig(merchantPk, vault, payoutAddr, 0, deadline);

        _change(stranger, payoutAddr, deadline, sig);

        vm.expectRevert(IX402PaymentRelayer.InvalidSignature.selector);
        _change(stranger, payoutAddr, deadline, sig);
    }

    function test_aSignatureForTheNextNonceCannotBeUsedEarly() public {
        uint256 deadline = _deadline();
        bytes memory sig = _sig(merchantPk, vault, payoutAddr, 1, deadline);

        vm.expectRevert(IX402PaymentRelayer.InvalidSignature.selector);
        _change(stranger, payoutAddr, deadline, sig);
    }

    function test_nonceOnlyIncreases() public {
        uint256 deadline = _deadline();
        assertEq(X402PaymentRelayer(vault).nonce(), 0);

        _change(stranger, payoutAddr, deadline, _sig(merchantPk, vault, payoutAddr, 0, deadline));
        assertEq(X402PaymentRelayer(vault).nonce(), 1);

        _change(stranger, payoutAddr, deadline, _sig(merchantPk, vault, payoutAddr, 1, deadline));
        assertEq(X402PaymentRelayer(vault).nonce(), 2);
    }

    // --------------------------------------------------------------- rejections

    function test_wrongSignerFails() public {
        uint256 deadline = _deadline();
        bytes memory sig = _sig(payerPk, vault, payoutAddr, 0, deadline);

        vm.expectRevert(IX402PaymentRelayer.InvalidSignature.selector);
        _change(stranger, payoutAddr, deadline, sig);
    }

    function test_operatorAndOwnerCannotChangeThePayoutWithoutTheMerchant() public {
        uint256 deadline = _deadline();
        // Signed by the operator's own key, which is not the merchant's.
        bytes memory operatorSig = _sig(0xBEEF, vault, payoutAddr, 0, deadline);

        vm.expectRevert(IX402PaymentRelayer.InvalidSignature.selector);
        _change(operator, payoutAddr, deadline, operatorSig);

        vm.expectRevert(IX402PaymentRelayer.InvalidSignature.selector);
        _change(owner, payoutAddr, deadline, operatorSig);

        vm.expectRevert(IX402PaymentRelayer.InvalidSignature.selector);
        _change(operator, payoutAddr, deadline, hex"");
    }

    function test_zeroNewPayoutReverts() public {
        uint256 deadline = _deadline();
        bytes memory sig = _sig(merchantPk, vault, address(0), 0, deadline);

        vm.expectRevert(IX402PaymentRelayer.InvalidAddress.selector);
        _change(stranger, address(0), deadline, sig);
    }

    function test_tamperedSignatureFails() public {
        uint256 deadline = _deadline();
        (uint8 v, bytes32 r, bytes32 s) = _rsv(merchantPk, vault, payoutAddr, 0, deadline);

        // Signed for `payoutAddr` but presented for a different recipient.
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.expectRevert(IX402PaymentRelayer.InvalidSignature.selector);
        _change(stranger, operator2, deadline, sig);
    }

    // ------------------------------------------------------- domain separation

    function test_crossVaultReplayFails() public {
        address vault2 = _deploy(makeAddr("other"), makeAddr("other"));

        uint256 deadline = _deadline();
        // Signed over vault's domain, aimed at vault2.
        bytes memory sig = _sig(merchantPk, vault, payoutAddr, 0, deadline);

        assertTrue(vault != vault2);
        assertTrue(_domainSeparator(vault) != _domainSeparator(vault2));

        vm.expectRevert(IX402PaymentRelayer.InvalidSignature.selector);
        vm.prank(stranger);
        X402PaymentRelayer(vault2).changePayout(payoutAddr, deadline, sig);
    }

    function test_crossChainReplayFails() public {
        uint256 deadline = _deadline();
        bytes memory sig = _sig(merchantPk, vault, payoutAddr, 0, deadline);

        vm.chainId(block.chainid + 1);

        vm.expectRevert(IX402PaymentRelayer.InvalidSignature.selector);
        _change(stranger, payoutAddr, deadline, sig);
    }
}
