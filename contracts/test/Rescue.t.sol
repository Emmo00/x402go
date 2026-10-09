// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {X402Base} from "./utils/X402Base.sol";
import {X402Vault} from "../src/X402Vault.sol";
import {IX402Vault} from "../src/interfaces/IX402Vault.sol";
import {IPermit2} from "../src/interfaces/IPermit2.sol";
import {IX402ExactPermit2Proxy} from "../src/interfaces/IX402ExactPermit2Proxy.sol";
import {MockERC20, MockX402ExactPermit2Proxy, PERMIT2_ADDR, X402_PROXY_ADDR} from "./utils/Mocks.sol";

/// @dev Suite I — `rescue`, the emergency path for tokens that reached a vault without going through
/// `settle`.
///
/// The interesting property is not that it recovers funds — it is that it cannot be used to *avoid*
/// the fee, and cannot be used to send funds anywhere but `payout()`.
contract RescueTest is X402Base {
    address internal vault;

    function setUp() public override {
        super.setUp();
        vault = _openVault();
        _configure(address(token6), DEFAULT_BPS);
    }

    function _rescueAs(address caller, address token) internal {
        vm.prank(caller);
        X402Vault(vault).rescue(token);
    }

    // ---------------------------------------------------------------- recovery

    function test_rescue_recoversTokensSentDirectly() public {
        token6.mint(vault, 100e6);
        uint256 fee = _fee(address(token6));

        _rescueAs(stranger, address(token6));

        assertEq(token6.balanceOf(merchant), 100e6 - fee);
        assertEq(token6.balanceOf(address(factory)), fee);
        assertEq(token6.balanceOf(vault), 0);
    }

    function test_rescue_recoversTokensSentBeforeDeployment() public {
        // The vault address is deterministic, so tokens can be sitting there before the clone exists.
        address merchant2 = makeAddr("merchant2");
        address predicted = _vaultOf(merchant2);
        token6.mint(predicted, 50e6);

        assertEq(predicted.code.length, 0, "not deployed yet");

        address deployed = _deploy(merchant2, merchant2);
        assertEq(deployed, predicted);

        vm.prank(stranger);
        X402Vault(deployed).rescue(address(token6));

        uint256 fee = _fee(address(token6));
        assertEq(token6.balanceOf(merchant2), 50e6 - fee);
        assertEq(token6.balanceOf(address(factory)), fee);
    }

    function test_rescue_respectsThePayoutOverride() public {
        address merchant2 = makeAddr("merchant2");
        address overrideVault = _deploy(merchant2, payoutAddr);

        token6.mint(overrideVault, 100e6);
        uint256 fee = _fee(address(token6));

        vm.prank(stranger);
        X402Vault(overrideVault).rescue(address(token6));

        assertEq(token6.balanceOf(payoutAddr), 100e6 - fee);
        assertEq(token6.balanceOf(merchant2), 0);
    }

    function test_rescue_afterAPayoutChangeFollowsTheNewPayout() public {
        token6.mint(vault, 100e6);

        uint256 deadline = _deadline();
        bytes memory sig = _sig(merchantPk, vault, payoutAddr, 0, deadline);
        vm.prank(merchant);
        X402Vault(vault).changePayout(payoutAddr, deadline, sig);

        _rescueAs(stranger, address(token6));

        assertEq(token6.balanceOf(payoutAddr), 100e6 - _fee(address(token6)));
        assertEq(token6.balanceOf(merchant), 0);
    }

    // ------------------------------------------------------- bypass resistance

    function test_rescue_afterAFrontRunThroughTheTokenStillChargesTheFee() public {
        // A third party submits the payer's signed authorization straight to the token, naming the
        // vault as recipient. The vault is credited with no `settle` call, no split and no event —
        // the exact shape of a fee-bypass attempt. `rescue` still takes the fee.
        token6.mint(payer, 100e6);
        uint256 value = 100e6;
        uint256 fee = _fee(address(token6));

        IX402Vault.Eip3009Authorization memory auth =
            _auth3009(payerPk, address(token6), vault, value, keccak256("front-run"));

        token6.transferWithAuthorization(
            auth.from, vault, auth.value, auth.validAfter, auth.validBefore, auth.nonce, auth.v, auth.r, auth.s
        );

        assertEq(token6.balanceOf(vault), value, "the vault was credited outside settle");

        _rescueAs(stranger, address(token6));

        assertEq(token6.balanceOf(address(factory)), fee, "the fee is not avoidable by skipping settle");
        assertEq(token6.balanceOf(merchant), value - fee);
        assertEq(token6.balanceOf(vault), 0);
    }

    function test_rescue_afterADirectProxySettleStillChargesTheFee() public {
        // Same bypass through the Permit2 path: the proxy is called directly, so the witness names
        // the vault and the vault is credited without the split running.
        _installPermit2();
        token6.mint(payer, 100e6);
        _approvePermit2(address(token6), payer);

        uint256 value = 100e6;
        uint256 fee = _fee(address(token6));

        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
            _permit2Args(payerPk, vault, address(token6), value, uint256(keccak256("direct-proxy")));

        MockX402ExactPermit2Proxy(X402_PROXY_ADDR).settle(permit, payer, wit, sig);

        assertEq(token6.balanceOf(vault), value, "the proxy paid the vault directly");

        _rescueAs(stranger, address(token6));

        assertEq(token6.balanceOf(address(factory)), fee);
        assertEq(token6.balanceOf(merchant), value - fee);
    }

    function test_rescue_theMerchantCannotSteerTheRecovery() public {
        // There is no recipient parameter. Owner, operator and merchant all get the same result:
        // funds land on `payout()` and nowhere else.
        token6.mint(vault, 100e6);
        uint256 fee = _fee(address(token6));

        vm.prank(owner);
        X402Vault(vault).rescue(address(token6));

        assertEq(token6.balanceOf(payoutAddr), 0);
        assertEq(token6.balanceOf(owner), 0);
        assertEq(token6.balanceOf(operator), 0);
        assertEq(token6.balanceOf(stranger), 0);
        assertEq(token6.balanceOf(merchant), 100e6 - fee);
    }

    // ---------------------------------------------------------- unconfigured

    function test_rescue_anUnconfiguredTokenGoesEntirelyToThePayout() public {
        MockERC20 third = new MockERC20("Third", "TRD", 18);
        third.mint(vault, 7e18);

        assertEq(factory.tokenFeeBPS(address(third)), 0);

        _rescueAs(stranger, address(third));

        assertEq(third.balanceOf(merchant), 7e18, "no fee is taken from a token the factory is not pricing");
        assertEq(third.balanceOf(address(factory)), 0);
        assertEq(third.balanceOf(vault), 0);
    }

    function test_rescue_aTokenWhoseFeeRoundsToZeroAlsoKeepsTheWholeBalance() public {
        // The inconsistency worth knowing about: `settle` refuses a token whose bps is non-zero but
        // whose computed fee truncates to zero, while `rescue` takes no fee and pays out in full.
        // Neither is exploitable — no fee is lost that could have been charged — but the two entry
        // points disagree about what a misconfigured token means.
        MockERC20 low = new MockERC20("Low", "LOW", 2);
        _configure(address(low), 1);

        assertTrue(factory.tokenFeeBPS(address(low)) > 0, "it is configured");
        assertEq(_fee(address(low)), 0, "but its fee is nothing");

        low.mint(vault, 1_000);

        _rescueAs(stranger, address(low));

        assertEq(low.balanceOf(merchant), 1_000);
        assertEq(low.balanceOf(address(factory)), 0);
    }

    // ---------------------------------------------------------------- boundaries

    function test_rescue_revertsOnAZeroBalance() public {
        vm.expectRevert(IX402Vault.AmountBelowFee.selector);
        _rescueAs(stranger, address(token6));
    }

    function test_rescue_revertsWhenTheBalanceEqualsTheFee() public {
        token6.mint(vault, _fee(address(token6)));

        vm.expectRevert(IX402Vault.AmountBelowFee.selector);
        _rescueAs(stranger, address(token6));
    }

    function test_rescue_revertsWhenTheBalanceIsBelowTheFee() public {
        token6.mint(vault, _fee(address(token6)) - 1);

        vm.expectRevert(IX402Vault.AmountBelowFee.selector);
        _rescueAs(stranger, address(token6));
    }

    function test_rescue_oneUnitAboveTheFeeSucceeds() public {
        uint256 fee = _fee(address(token6));
        token6.mint(vault, fee + 1);

        _rescueAs(stranger, address(token6));

        assertEq(token6.balanceOf(merchant), 1);
        assertEq(token6.balanceOf(address(factory)), fee);
    }

    // ------------------------------------------------------------- access control

    function test_rescue_isPermissionless() public {
        token6.mint(vault, 100e6);

        // Documented as implemented: there is no access control at all. Safe only because the
        // destination is fixed and the signature check lives in the token, not in the vault.
        _rescueAs(stranger, address(token6));
        assertEq(token6.balanceOf(vault), 0);
    }

    function test_rescue_canBeCalledRepeatedlyButOnlyTheFirstDoesAnything() public {
        token6.mint(vault, 100e6);

        _rescueAs(stranger, address(token6));

        vm.expectRevert(IX402Vault.AmountBelowFee.selector);
        _rescueAs(owner, address(token6));
    }

    // -------------------------------------------------------------------- events

    function test_rescue_emitsSettleWithAZeroPayer() public {
        uint256 fee = _fee(address(token6));
        token6.mint(vault, 100e6);

        // There is no payer: nobody was authorised, the tokens simply arrived. The event still
        // claims the `Settle` shape, which is why the payer topic is zero here.
        vm.expectEmit(true, true, true, true, vault);
        emit IX402Vault.Settle(merchant, address(token6), address(0), 100e6 - fee, fee);

        _rescueAs(stranger, address(token6));
    }

    // -------------------------------------------------------------- vault state

    function test_rescue_leavesThePayoutAndNonceAlone() public {
        token6.mint(vault, 100e6);
        uint256 slot0Before = uint256(vm.load(vault, bytes32(uint256(0))));

        _rescueAs(stranger, address(token6));

        assertEq(uint256(vm.load(vault, bytes32(uint256(0)))), slot0Before);
        assertEq(X402Vault(vault).payout(), merchant);
        assertEq(X402Vault(vault).nonce(), 0);
    }

    function test_rescue_doesNotInterfereWithALaterSettlement() public {
        token6.mint(vault, 100e6);
        _rescueAs(stranger, address(token6));

        // The vault is back to a clean slate and the ordinary path still works.
        token6.mint(payer, 100e6);
        _pay3009(payerPk, vault, address(token6), 50e6, keccak256("after-rescue"));

        uint256 fee = _fee(address(token6));
        assertEq(token6.balanceOf(merchant), 100e6 - fee + 50e6 - fee);
        assertEq(token6.balanceOf(vault), 0);
    }

    // ---------------------------------------------------------------------- fuzz

    /// forge-config: default.fuzz.runs = 256
    function testFuzz_rescue_conservesValue(uint96 amount) public {
        uint256 fee = _fee(address(token6));
        amount = uint96(bound(amount, fee + 1, 1_000e6));

        token6.mint(vault, amount);
        _rescueAs(stranger, address(token6));

        assertEq(token6.balanceOf(merchant) + token6.balanceOf(address(factory)), amount);
        assertEq(token6.balanceOf(address(factory)), fee);
        assertEq(token6.balanceOf(vault), 0);
    }
}
