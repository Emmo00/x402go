// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {X402Base} from "./utils/X402Base.sol";
import {X402Vault} from "../src/X402Vault.sol";
import {IX402Vault} from "../src/interfaces/IX402Vault.sol";
import {MockERC20, Mock1271Wallet} from "./utils/Mocks.sol";
import {Ownable} from "solady/auth/Ownable.sol";

/// @dev Suite K — whole-lifecycle flows.
///
/// Each test here is written from the outside in: an operator onboards a merchant, the merchant
/// takes control of their payout, payers pay through both schemes, a stray balance is recovered, and
/// the owner sweeps. The point is the seams between the pieces, which the per-contract suites each
/// test only one side of.
contract EndToEndTest is X402Base {
    /// @dev Two payments for the same amount class, one per scheme, funded in one mint.
    function _legs(address vault, uint256 first, uint256 second) internal {
        token6.mint(payer, first + second);
        _pay3009(payerPk, vault, address(token6), first, keccak256(abi.encode("leg1", first)));
        _payPermit2(payerPk, vault, address(token6), second, uint256(keccak256(abi.encode("leg2", second))));
    }

    function test_endToEnd_onboardPaySweep() public {
        _configure(address(token6), DEFAULT_BPS);
        _installPermit2();
        _approvePermit2(address(token6), payer);

        // 1. The operator onboards the merchant with a platform-managed payout.
        address vault = _deploy(merchant, payoutAddr);
        assertEq(X402Vault(vault).merchant(), merchant);
        assertEq(X402Vault(vault).payout(), payoutAddr);

        // 2. The merchant signs their payout over to themselves.
        uint256 deadline = _deadline();
        bytes memory sig = _sig(merchantPk, vault, merchant, 0, deadline);
        vm.prank(stranger);
        X402Vault(vault).changePayout(merchant, deadline, sig);
        assertEq(X402Vault(vault).payout(), merchant);

        // 3. Two payments, one per scheme.
        _legs(vault, 100e6, 200e6);

        // 4. A stray balance arrives — a misconfigured payTo — and is recovered.
        token6.mint(vault, 5e6);
        vm.prank(stranger);
        X402Vault(vault).rescue(address(token6));

        // 5. The owner sweeps the fees.
        vm.prank(owner);
        factory.withdrawFees(_addrs(address(token6)), feeRecipient);

        uint256 fee = _fee(address(token6));
        assertEq(token6.balanceOf(merchant), 300e6 + 5e6 - fee * 3, "net of three fees");
        assertEq(token6.balanceOf(feeRecipient), fee * 3);
        assertEq(token6.balanceOf(vault), 0, "the vault never keeps anything");
        assertEq(token6.balanceOf(address(factory)), 0);
    }

    function test_endToEnd_merchantSelfOnboards() public {
        // The other onboarding route: the merchant creates their own vault, so the payout is never
        // set and `payout()` falls through to `merchant()`.
        _configure(address(token6), DEFAULT_BPS);

        address vault = _deployAs(merchant, merchant, merchant);
        assertEq(X402Vault(vault).payout(), merchant);

        token6.mint(payer, 100e6);
        _pay3009(payerPk, vault, address(token6), 100e6, keccak256("self"));

        assertEq(token6.balanceOf(merchant), 100e6 - _fee(address(token6)));
    }

    function test_endToEnd_twoMerchantsTwoTokensOneSweep() public {
        _configure(address(token6), DEFAULT_BPS);
        _configure(address(token18), 250);

        address merchant2 = makeAddr("merchant2");
        address vault1 = _deploy(merchant, merchant);
        address vault2 = _deploy(merchant2, merchant2);

        token6.mint(payer, 1_000e6);
        token18.mint(payer, 10e18);

        _pay3009(payerPk, vault1, address(token6), 100e6, keccak256("m1"));
        _pay3009(payerPk, vault2, address(token6), 300e6, keccak256("m2"));
        _pay3009(payerPk, vault2, address(token18), 4e18, keccak256("m2-18"));

        address[] memory tokens = new address[](2);
        tokens[0] = address(token6);
        tokens[1] = address(token18);

        uint256 fee6 = _fee(address(token6));
        uint256 fee18 = _fee(address(token18));

        vm.prank(owner);
        factory.withdrawFees(tokens, feeRecipient);

        assertEq(token6.balanceOf(feeRecipient), fee6 * 2);
        assertEq(token18.balanceOf(feeRecipient), fee18);

        assertEq(token6.balanceOf(merchant), 100e6 - fee6);
        assertEq(token6.balanceOf(merchant2), 300e6 - fee6);
        assertEq(token18.balanceOf(merchant2), 4e18 - fee18);

        assertEq(token6.balanceOf(vault1), 0);
        assertEq(token6.balanceOf(vault2), 0);
        assertEq(token18.balanceOf(vault2), 0);
    }

    function test_endToEnd_operatorHandoverMidFlight() public {
        _configure(address(token6), DEFAULT_BPS);

        address vault1 = _deploy(merchant, merchant);

        // The owner rotates the operator.
        vm.prank(owner);
        factory.grantRoles(operator2, operatorRole);
        vm.prank(owner);
        factory.revokeRoles(operator, operatorRole);

        assertFalse(factory.hasAnyRole(operator, operatorRole));
        assertTrue(factory.hasAnyRole(operator2, operatorRole));

        address merchant2 = makeAddr("merchant2");

        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(operator);
        factory.createVault(merchant2, merchant2);

        address vault2 = _deployAs(operator2, merchant2, merchant2);
        assertTrue(vault2 != address(0));

        // The already-created vault is unaffected by the rotation.
        token6.mint(payer, 100e6);
        _pay3009(payerPk, vault1, address(token6), 100e6, keccak256("after-rotation"));

        assertEq(token6.balanceOf(merchant), 100e6 - _fee(address(token6)));
    }

    function test_endToEnd_aFeeChangeAppliesToTheNextPaymentNotTheLast() public {
        _configure(address(token6), DEFAULT_BPS);
        address vault = _deploy(merchant, merchant);
        token6.mint(payer, 1_000e6);

        uint256 fee10 = _fee(address(token6));
        _pay3009(payerPk, vault, address(token6), 100e6, keccak256("before"));

        _configure(address(token6), 500);
        uint256 fee500 = _fee(address(token6));
        _pay3009(payerPk, vault, address(token6), 100e6, keccak256("after"));

        assertEq(fee10, 1_000);
        assertEq(fee500, 50_000);
        assertEq(token6.balanceOf(address(factory)), fee10 + fee500);
        assertEq(token6.balanceOf(merchant), 200e6 - fee10 - fee500);
    }

    function test_endToEnd_aContractMerchantOnboardsAndRedirects() public {
        _configure(address(token6), DEFAULT_BPS);

        Mock1271Wallet wallet = new Mock1271Wallet();
        address walletVault = _deploy(address(wallet), address(wallet));

        // 1271 payout change: the wallet approves the digest and the empty signature is accepted.
        uint256 deadline = _deadline();
        wallet.approve(_digest(walletVault, payoutAddr, 0, deadline));

        vm.prank(stranger);
        X402Vault(walletVault).changePayout(payoutAddr, deadline, hex"");
        assertEq(X402Vault(walletVault).payout(), payoutAddr);

        token6.mint(payer, 100e6);
        _pay3009(payerPk, walletVault, address(token6), 100e6, keccak256("contract-merchant"));

        uint256 fee = _fee(address(token6));
        assertEq(token6.balanceOf(payoutAddr), 100e6 - fee);
        assertEq(token6.balanceOf(address(wallet)), 0);
        assertEq(token6.balanceOf(address(factory)), fee);
    }

    function test_endToEnd_aBypassAttemptIsRecoveredIntoTheNormalAccounting() public {
        _configure(address(token6), DEFAULT_BPS);
        address vault = _deploy(merchant, merchant);

        token6.mint(payer, 100e6);

        // The bypass: pay the token directly, so `settle` never runs and no `Settle` is emitted.
        IX402Vault.Eip3009Authorization memory auth =
            _auth3009(payerPk, address(token6), vault, 100e6, keccak256("bypass"));
        token6.transferWithAuthorization(
            auth.from, vault, auth.value, auth.validAfter, auth.validBefore, auth.nonce, auth.v, auth.r, auth.s
        );

        // Recovery puts the accounting back where it would have been.
        vm.prank(stranger);
        X402Vault(vault).rescue(address(token6));

        uint256 fee = _fee(address(token6));
        assertEq(token6.balanceOf(merchant), 100e6 - fee);
        assertEq(token6.balanceOf(address(factory)), fee);
        assertEq(token6.balanceOf(vault), 0);
    }

    function test_endToEnd_aNewTokenCanBePricedWithoutTouchingExistingVaults() public {
        // Fees live on the factory, so adding a token is a single owner call and every existing
        // vault picks it up immediately.
        address vault = _deploy(merchant, merchant);

        MockERC20 third = new MockERC20("Third", "TRD", 8);
        third.mint(payer, 1_000e8);

        // Built before the cheatcodes are armed: `_auth3009` reads the token's domain separator, and
        // an external call in argument position would consume the pending `expectRevert`/`prank`.
        IX402Vault.Eip3009Authorization memory unsupported =
            _auth3009(payerPk, address(third), vault, 100e8, keccak256("x"));

        vm.expectRevert(IX402Vault.TokenNotSupported.selector);
        vm.prank(stranger);
        X402Vault(vault).settle(address(third), unsupported);

        _configure(address(third), 100);

        IX402Vault.Eip3009Authorization memory auth = _auth3009(payerPk, address(third), vault, 100e8, keccak256("y"));
        vm.prank(stranger);
        X402Vault(vault).settle(address(third), auth);

        uint256 fee = _fee(address(third));
        assertEq(fee, 1e6, "1% of 1e8 units");
        assertEq(third.balanceOf(merchant), 100e8 - fee);
        assertEq(third.balanceOf(address(factory)), fee);
    }
}
