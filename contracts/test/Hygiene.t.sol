// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {X402Base} from "./utils/X402Base.sol";
import {X402Vault} from "../src/X402Vault.sol";
import {IX402Vault} from "../src/interfaces/IX402Vault.sol";
import {IERC3009} from "../src/interfaces/IERC3009.sol";

/// @dev Suite N — hygiene.
///
/// The assertions that do not belong to any one behaviour: the ABI the contracts are pinned to,
/// what they must *not* expose, and that they still fit in a block.
contract HygieneTest is X402Base {
    /// @dev The EIP-170 runtime-code ceiling.
    uint256 internal constant MAX_CODE_SIZE = 24_576;

    /// @dev Selectors from the ABI this project is pinned to. Written as literals on purpose: a
    /// computed value would just restate the signature and would not notice it changing.
    bytes4 internal constant SELECTOR_TRANSFER_WITH_AUTHORIZATION = 0xe3ee160e;
    bytes4 internal constant SELECTOR_PERMIT_TRANSFER_FROM = 0x30f28b7a;
    bytes4 internal constant SELECTOR_SETTLE = 0x88e88402;
    bytes4 internal constant SELECTOR_SETTLE_PERMIT2 = 0xebae2b8d;
    bytes4 internal constant SELECTOR_RESCUE = 0x839006f2;
    bytes4 internal constant SELECTOR_CHANGE_PAYOUT = 0x6eb53103;
    bytes4 internal constant SELECTOR_CREATE_VAULT = 0xcc92d31c;
    bytes4 internal constant SELECTOR_OPERATOR = 0x570ca735;
    bytes4 internal constant SELECTOR_SET_OPERATOR = 0xb3ab15fb;

    /// @dev Whether `selector` appears anywhere in `target`'s deployed code.
    ///
    /// Deliberately a byte scan rather than a probe call: a 4-byte call with no arguments reverts
    /// for a *present* selector too (the abi decoder runs out of calldata), so a revert proves
    /// nothing. Absence is what this can establish, and it is the direction every caller here uses.
    /// A four-byte collision in ~5 KB of bytecode is a ~1-in-a-million event; if one ever fires the
    /// assertion fails loudly and is easy to check by hand.
    function _codeContains(address target, bytes4 selector) internal view returns (bool) {
        bytes memory code = target.code;

        for (uint256 i; i + 4 <= code.length; ++i) {
            if (
                code[i] == selector[0] && code[i + 1] == selector[1] && code[i + 2] == selector[2]
                    && code[i + 3] == selector[3]
            ) {
                return true;
            }
        }

        return false;
    }

    // ---------------------------------------------------------------- selectors

    function test_ierc3009PinsTheNineArgumentOverload() public pure {
        // The v,r,s form, which is what Celo's USDC (FiatTokenV2) exposes. The two-argument
        // `transferWithAuthorization(bytes)` form is deliberately not part of the interface.
        assertEq(
            IERC3009.transferWithAuthorization.selector,
            SELECTOR_TRANSFER_WITH_AUTHORIZATION,
            "IERC3009.transferWithAuthorization moved"
        );
        assertEq(
            bytes4(
                keccak256(
                    "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)"
                )
            ),
            SELECTOR_TRANSFER_WITH_AUTHORIZATION
        );
    }

    function test_vaultSelectorsArePinned() public pure {
        assertEq(
            bytes4(keccak256("settle(address,(address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32))")),
            SELECTOR_SETTLE
        );
        assertEq(
            bytes4(keccak256("settleWithPermit2(((address,uint256),uint256,uint256),address,(address,uint256),bytes)")),
            SELECTOR_SETTLE_PERMIT2
        );
        assertEq(bytes4(keccak256("changePayout(address,uint256,bytes)")), SELECTOR_CHANGE_PAYOUT);
        assertEq(bytes4(keccak256("rescue(address)")), SELECTOR_RESCUE);

        assertEq(IX402Vault.settle.selector, SELECTOR_SETTLE);
        assertEq(IX402Vault.settleWithPermit2.selector, SELECTOR_SETTLE_PERMIT2);
        assertEq(IX402Vault.changePayout.selector, SELECTOR_CHANGE_PAYOUT);
    }

    function test_factorySelectorsArePinned() public pure {
        assertEq(bytes4(keccak256("createVault(address,address)")), SELECTOR_CREATE_VAULT);
        assertEq(bytes4(keccak256("tokenFee(address)")), bytes4(0xf348f4fc));
    }

    // ------------------------------------------------------ removed entry points

    function test_theOldDirectPermit2PathIsGoneFromTheVault() public view {
        // The removed `permitTransferFrom` entry point took the vault's own `Permit2Authorization`
        // and moved funds with no proxy and no witness. Neither the dispatcher entry nor the
        // `SignatureTransferDetails` decoding it needed is left in the code.
        assertFalse(
            _codeContains(factory.implementation(), SELECTOR_PERMIT_TRANSFER_FROM),
            "the vault still carries the removed direct permitTransferFrom path"
        );
    }

    function test_theOldOperatorApiIsGoneFromTheFactory() public view {
        assertFalse(_codeContains(address(factory), SELECTOR_OPERATOR), "factory.operator() came back");
        assertFalse(_codeContains(address(factory), SELECTOR_SET_OPERATOR), "factory.setOperator() came back");
    }

    function test_theVaultHasNoPrivilegedOrWithdrawalSurface() public view {
        // The vault is deliberately not ownable and has no generic withdrawal: the only ways tokens
        // leave are `settle`, `settleWithPermit2` and `rescue`, and all three pay `payout()`.
        bytes4[5] memory forbidden = [
            bytes4(keccak256("owner()")),
            bytes4(keccak256("withdraw(address)")),
            bytes4(keccak256("withdrawFees(address[],address)")),
            bytes4(keccak256("setTokenFees(address[],uint16[])")),
            bytes4(keccak256("upgradeTo(address)"))
        ];

        for (uint256 i; i < forbidden.length; ++i) {
            assertFalse(_codeContains(factory.implementation(), forbidden[i]), "the vault grew a privileged surface");
        }
    }

    function test_theVaultExposesRescueEvenThoughTheInterfaceDoesNot() public {
        // Worth pinning: `rescue` is implemented and callable, but `IX402Vault` does not declare it,
        // so anything integrating through the interface cannot reach it. Recorded rather than
        // quietly "fixed" — the interface is part of the published ABI.
        address vault = _openVault();

        // An empty, unconfigured vault: the call reaches the body (so the selector is live) and
        // fails on `bal <= fee`.
        vm.expectRevert(IX402Vault.AmountBelowFee.selector);
        X402Vault(vault).rescue(address(token6));

        assertTrue(_codeContains(factory.implementation(), SELECTOR_RESCUE), "rescue is present in the code");
    }

    // ------------------------------------------------------------------ sizing

    function test_deployedBytecodeFitsTheEIP170Limit() public view {
        uint256 factorySize = address(factory).code.length;
        uint256 implementationSize = factory.implementation().code.length;

        assertLt(factorySize, MAX_CODE_SIZE, "the factory does not fit in a block");
        assertLt(implementationSize, MAX_CODE_SIZE, "the vault implementation does not fit in a block");

        // Headroom matters because the implementation is deployed by the factory's constructor: it
        // has to fit in the factory's *creation* transaction too.
        assertLt(implementationSize, 24_000, "the implementation is at the size limit");
    }

    function test_clonesAreMinimalProxySized() public {
        address vault = _openVault();

        // The CWIA clone is a fixed prologue plus the 20-byte merchant argument.
        assertLt(vault.code.length, 128, "the clone is not a minimal proxy");
        assertGt(vault.code.length, 20, "the clone carries its merchant argument");
    }

    // --------------------------------------------------------------------- gas

    function test_settlementGasIsWithinItsBudget() public {
        // A coarse regression guard, not a benchmark: it catches an order-of-magnitude change, which
        // is what a broken code path looks like. The per-test numbers live in `.gas-snapshot`.
        _configure(address(token6), DEFAULT_BPS);
        address vault = _openVault();
        token6.mint(payer, 100e6);

        uint256 before = gasleft();
        _pay3009(payerPk, vault, address(token6), 100e6, keccak256("gas"));
        uint256 used = before - gasleft();

        assertLt(used, 300_000, "settle got dramatically more expensive");
    }

    function test_rescueGasIsWithinItsBudget() public {
        _configure(address(token6), DEFAULT_BPS);
        address vault = _openVault();
        token6.mint(vault, 100e6);

        uint256 before = gasleft();
        vm.prank(stranger);
        X402Vault(vault).rescue(address(token6));
        uint256 used = before - gasleft();

        assertLt(used, 300_000, "rescue got dramatically more expensive");
    }

    function test_payoutChangeGasIsWithinItsBudget() public {
        address vault = _openVault();
        uint256 deadline = _deadline();
        bytes memory sig = _sig(merchantPk, vault, payoutAddr, 0, deadline);

        uint256 before = gasleft();
        vm.prank(stranger);
        X402Vault(vault).changePayout(payoutAddr, deadline, sig);
        uint256 used = before - gasleft();

        assertLt(used, 300_000, "changePayout got dramatically more expensive");
    }

    // ---------------------------------------------------------------- factory

    function test_theFactoryConstructorBakesInTheImplementation() public view {
        // `implementation` is immutable, so a new vault can never be retrofitted into a deployed
        // factory — and every derived vault address depends on this one address.
        assertTrue(factory.implementation().code.length > 0);
    }
}
