// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {X402Base} from "./utils/X402Base.sol";
import {X402Vault} from "../src/X402Vault.sol";
import {IX402Vault} from "../src/interfaces/IX402Vault.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {
    BlacklistToken,
    FalsePayoutToken,
    FeeOnTransferToken,
    RevertingPayoutToken,
    UsdtStyleToken
} from "./utils/Mocks.sol";

/// @dev Suite G — `settle`, the EIP-3009 path.
///
/// The vault never sees the signature: the token verifies it. Everything this suite asserts about
/// authorisation therefore comes back as the *token's* revert reason, which is exactly what a real
/// settlement against FiatTokenV2 would surface.
contract SettleEip3009Test is X402Base {
    address internal vault;

    function setUp() public override {
        super.setUp();
        vault = _openVault();
        _configure(address(token6), DEFAULT_BPS);
        token6.mint(payer, 1_000e6);
    }

    function _settleAs(address caller, address token, IX402Vault.Eip3009Authorization memory auth) internal {
        vm.prank(caller);
        X402Vault(vault).settle(token, auth);
    }

    // -------------------------------------------------------------- happy path

    function test_settle_splitsBetweenTheMerchantAndTheFactory() public {
        uint256 value = 100e6;
        uint256 fee = _fee(address(token6));

        _pay3009(payerPk, vault, address(token6), value, keccak256("pay"));

        assertEq(token6.balanceOf(merchant), value - fee);
        assertEq(token6.balanceOf(address(factory)), fee);
        assertEq(token6.balanceOf(vault), 0, "the vault keeps nothing");
        assertEq(token6.balanceOf(payer), 1_000e6 - value);
        assertEq(token6.balanceOf(merchant) + token6.balanceOf(address(factory)), value);
    }

    function test_settle_paysTheOverridePayoutRatherThanTheMerchant() public {
        address merchant2 = makeAddr("merchant2");
        address overrideVault = _deploy(merchant2, payoutAddr);

        uint256 value = 100e6;
        uint256 fee = _fee(address(token6));

        // The payer is unrelated to the merchant, so the only thing steering funds is `payout()`.
        IX402Vault.Eip3009Authorization memory auth =
            _auth3009(payerPk, address(token6), overrideVault, value, keccak256("override"));
        vm.prank(stranger);
        X402Vault(overrideVault).settle(address(token6), auth);

        assertEq(token6.balanceOf(payoutAddr), value - fee);
        assertEq(token6.balanceOf(merchant2), 0);
        assertEq(token6.balanceOf(address(factory)), fee);
    }

    function test_settle_emitsTheSplit() public {
        uint256 value = 100e6;
        uint256 fee = _fee(address(token6));
        bytes32 authNonce = keccak256("pay");
        IX402Vault.Eip3009Authorization memory auth = _auth3009(payerPk, address(token6), vault, value, authNonce);

        vm.expectEmit(true, true, true, true, vault);
        emit IX402Vault.Settle(merchant, address(token6), payer, value - fee, fee);

        _settleAs(stranger, address(token6), auth);
    }

    function test_settle_isPermissionless() public {
        uint256 value = 10e6;

        // Four unrelated callers, four payments: the authorisation is the authority, not the caller.
        address[4] memory callers = [stranger, merchant, owner, operator];
        for (uint256 i; i < callers.length; ++i) {
            IX402Vault.Eip3009Authorization memory auth =
                _auth3009(payerPk, address(token6), vault, value, keccak256(abi.encode("relay", i)));
            _settleAs(callers[i], address(token6), auth);
        }

        assertEq(token6.balanceOf(merchant), (value - _fee(address(token6))) * 4);
    }

    function test_settle_secondPaymentWithADifferentNonceWorks() public {
        _pay3009(payerPk, vault, address(token6), 10e6, keccak256("one"));
        _pay3009(payerPk, vault, address(token6), 20e6, keccak256("two"));

        uint256 fee = _fee(address(token6));
        assertEq(token6.balanceOf(address(factory)), fee * 2);
        assertEq(token6.balanceOf(merchant), 30e6 - fee * 2);
    }

    // ---------------------------------------- the fee check precedes consumption

    function test_settle_valueEqualToFeeRevertsAndLeavesTheAuthorizationUnconsumed() public {
        uint256 fee = _fee(address(token6));
        bytes32 authNonce = keccak256("at-fee");
        IX402Vault.Eip3009Authorization memory auth = _auth3009(payerPk, address(token6), vault, fee, authNonce);

        vm.expectRevert(IX402Vault.AmountBelowFee.selector);
        _settleAs(stranger, address(token6), auth);

        assertFalse(token6.authorizationState(payer, authNonce), "the nonce must still be spendable");
        assertEq(token6.balanceOf(payer), 1_000e6);
    }

    function test_settle_valueBelowFeeRevertsAndLeavesTheAuthorizationUnconsumed() public {
        bytes32 authNonce = keccak256("below-fee");
        IX402Vault.Eip3009Authorization memory auth = _auth3009(payerPk, address(token6), vault, 1, authNonce);

        vm.expectRevert(IX402Vault.AmountBelowFee.selector);
        _settleAs(stranger, address(token6), auth);

        assertFalse(token6.authorizationState(payer, authNonce));
        assertEq(token6.balanceOf(address(factory)), 0);
    }

    function test_settle_oneUnitAboveTheFeeSettles() public {
        // The boundary is `>` not `>=`: one unit more than the fee is a legal, if useless, payment.
        uint256 fee = _fee(address(token6));
        _pay3009(payerPk, vault, address(token6), fee + 1, keccak256("boundary"));

        assertEq(token6.balanceOf(merchant), 1);
        assertEq(token6.balanceOf(address(factory)), fee);
    }

    // ------------------------------------------------- token-level authorisation

    function test_settle_expiredAuthorizationReverts() public {
        // forge-lint: disable-next-line(block-timestamp)
        IX402Vault.Eip3009Authorization memory auth =
            _auth3009(payerPk, address(token6), vault, 100e6, keccak256("expired"));
        auth.validBefore = block.timestamp;

        vm.expectRevert(bytes("authorization expired"));
        _settleAs(stranger, address(token6), auth);
    }

    function test_settle_notYetValidAuthorizationReverts() public {
        // forge-lint: disable-next-line(block-timestamp)
        IX402Vault.Eip3009Authorization memory auth =
            _auth3009(payerPk, address(token6), vault, 100e6, keccak256("early"));
        auth.validAfter = block.timestamp + 1;
        auth = _sign3009(payerPk, address(token6), vault, auth);

        vm.expectRevert(bytes("authorization not yet valid"));
        _settleAs(stranger, address(token6), auth);
    }

    function test_settle_authorizationNamingAnotherRecipientReverts() public {
        // Signed to pay the merchant directly; the vault presents itself as the recipient, so the
        // digest the token rebuilds no longer matches what the payer signed.
        IX402Vault.Eip3009Authorization memory auth =
            _auth3009(payerPk, address(token6), merchant, 100e6, keccak256("wrong-to"));

        vm.expectRevert(bytes("invalid authorization signature"));
        _settleAs(stranger, address(token6), auth);
    }

    function test_settle_signatureFromSomeoneElseReverts() public {
        IX402Vault.Eip3009Authorization memory auth =
            _auth3009(payerPk, address(token6), vault, 100e6, keccak256("wrong-signer"));
        auth.from = stranger;

        vm.expectRevert(bytes("invalid authorization signature"));
        _settleAs(stranger, address(token6), auth);
    }

    function test_settle_tamperedAmountReverts() public {
        IX402Vault.Eip3009Authorization memory auth =
            _auth3009(payerPk, address(token6), vault, 100e6, keccak256("tampered"));
        auth.value = 1_000e6; // signed for 100, presented as the whole balance

        vm.expectRevert(bytes("invalid authorization signature"));
        _settleAs(stranger, address(token6), auth);
    }

    function test_settle_reusedNonceReverts() public {
        bytes32 authNonce = keccak256("replay");
        IX402Vault.Eip3009Authorization memory auth = _auth3009(payerPk, address(token6), vault, 100e6, authNonce);

        _settleAs(stranger, address(token6), auth);

        vm.expectRevert(bytes("authorization already used"));
        _settleAs(stranger, address(token6), auth);
    }

    function test_settle_insufficientPayerBalanceReverts() public {
        IX402Vault.Eip3009Authorization memory auth =
            _auth3009(payerPk, address(token6), vault, 5_000e6, keccak256("too-much"));

        vm.expectRevert();
        _settleAs(stranger, address(token6), auth);
    }

    // ------------------------------------------------------- fee timing and safety

    function test_settle_usesTheFeeInForceAtSettlementTimeNotAtSigningTime() public {
        bytes32 authNonce = keccak256("fee-moved");
        IX402Vault.Eip3009Authorization memory auth = _auth3009(payerPk, address(token6), vault, 100e6, authNonce);

        // Signed under 10 bps, settled under 500 bps. The vault reads the factory at settle time, so
        // the payer's signature does not pin the price of the payment.
        _configure(address(token6), 500);
        uint256 fee = _fee(address(token6));
        assertEq(fee, 50_000);

        _settleAs(stranger, address(token6), auth);

        assertEq(token6.balanceOf(address(factory)), fee);
        assertEq(token6.balanceOf(merchant), 100e6 - fee);
    }

    function test_settle_aFeeRaisedToTheWholeUnitLeavesTheMerchantNothing() public {
        // The lever has no cap: 100% is a legal configuration, and the split degrades to
        // "everything to the factory, the merchant gets 0" rather than reverting.
        _configure(address(token6), 10_000);
        assertEq(_fee(address(token6)), 1e6);

        _pay3009(payerPk, vault, address(token6), 2e6, keccak256("whole-unit"));

        assertEq(token6.balanceOf(address(factory)), 1e6);
        assertEq(token6.balanceOf(merchant), 1e6, "the excess over the fee is still the merchant's");
    }

    function test_settle_blacklistedPayoutRevertsAtomically() public {
        BlacklistToken blk = new BlacklistToken();
        _configure(address(blk), DEFAULT_BPS);
        blk.mint(payer, 100e18);
        blk.setBlacklisted(merchant, true);

        bytes32 authNonce = keccak256("blacklisted");
        IX402Vault.Eip3009Authorization memory auth = _auth3009(payerPk, address(blk), vault, 100e18, authNonce);

        // Collection succeeds — the vault is not blacklisted — and the payout leg is what fails.
        // Solady collapses that into its own error, which is why the assertion names it.
        vm.expectRevert(SafeTransferLib.TransferFailed.selector);
        _settleAs(stranger, address(blk), auth);

        assertFalse(blk.authorizationState(payer, authNonce), "the failed settlement must not burn the nonce");
        assertEq(blk.balanceOf(payer), 100e18, "the payer keeps their funds");
        assertEq(blk.balanceOf(vault), 0);
        assertEq(blk.balanceOf(address(factory)), 0);
    }

    function test_settle_aTokenThatPaysOutNothingReverts() public {
        FalsePayoutToken t = new FalsePayoutToken();
        _configure(address(t), DEFAULT_BPS);
        t.mint(payer, 100e18);

        IX402Vault.Eip3009Authorization memory auth =
            _auth3009(payerPk, address(t), vault, 100e18, keccak256("false-payout"));

        vm.expectRevert(SafeTransferLib.TransferFailed.selector);
        _settleAs(stranger, address(t), auth);
    }

    function test_settle_aTokenWhosePayoutRevertsReverts() public {
        RevertingPayoutToken t = new RevertingPayoutToken();
        _configure(address(t), DEFAULT_BPS);
        t.mint(payer, 100e18);

        IX402Vault.Eip3009Authorization memory auth =
            _auth3009(payerPk, address(t), vault, 100e18, keccak256("reverting-payout"));

        vm.expectRevert(SafeTransferLib.TransferFailed.selector);
        _settleAs(stranger, address(t), auth);
    }

    function test_settle_aFeeOnTransferTokenCannotSettle() public {
        // Documented as an allowlist rule rather than a code guarantee: if one is configured anyway,
        // the vault collects 99% and then cannot cover the split, so the whole call reverts.
        FeeOnTransferToken t = new FeeOnTransferToken();
        _configure(address(t), DEFAULT_BPS);
        t.mint(payer, 100e18);

        bytes32 authNonce = keccak256("fee-on-transfer");
        IX402Vault.Eip3009Authorization memory auth = _auth3009(payerPk, address(t), vault, 100e18, authNonce);

        vm.expectRevert();
        _settleAs(stranger, address(t), auth);

        assertFalse(t.authorizationState(payer, authNonce));
    }

    // -------------------------------------------------------- unwrapped tokens

    function test_settle_handlesATokenWithNoReturnValues() public {
        // USDT-style: `transfer` returns nothing at all. Solady's safe transfer accepts that, so a
        // no-return token is a perfectly settleable one.
        UsdtStyleToken usdt = new UsdtStyleToken("Tether", "USDT", 6);
        _configure(address(usdt), DEFAULT_BPS);
        usdt.mint(payer, 1_000e6);

        uint256 fee = _fee(address(usdt));
        IX402Vault.Eip3009Authorization memory auth = _auth3009(payerPk, address(usdt), vault, 100e6, keccak256("usdt"));

        _settleAs(stranger, address(usdt), auth);

        assertEq(usdt.balanceOf(merchant), 100e6 - fee);
        assertEq(usdt.balanceOf(address(factory)), fee);
        assertEq(usdt.balanceOf(vault), 0);
    }

    // -------------------------------------------------------------------- fuzz

    /// @dev Each run signs and settles one payment, so the global 10_000 runs is more than this
    /// property needs.
    /// forge-config: default.fuzz.runs = 256
    function testFuzz_settle_conservesValue(uint16 bps, uint96 value) public {
        bps = uint16(bound(bps, 1, 10_000)); // 0 is "not configured", covered elsewhere
        uint256 fee = (uint256(bps) * 1e6) / 10_000;

        _configure(address(token6), bps);
        vm.assume(fee != 0);

        value = uint96(bound(value, fee + 1, 1_000e6));
        token6.mint(payer, value);

        _pay3009(payerPk, vault, address(token6), value, keccak256(abi.encode(bps, value)));

        uint256 toMerchant = token6.balanceOf(merchant);
        uint256 toFactory = token6.balanceOf(address(factory));

        assertEq(toMerchant + toFactory, value, "nothing created or destroyed");
        assertEq(toFactory, fee);
        assertEq(toMerchant, value - fee);
        assertEq(token6.balanceOf(vault), 0);
    }
}
