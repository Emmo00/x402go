// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {X402Base} from "./utils/X402Base.sol";
import {X402VaultFactory} from "../src/X402VaultFactory.sol";
import {IX402Vault} from "../src/interfaces/IX402Vault.sol";
import {Ownable} from "solady/auth/Ownable.sol";

/// @dev Suite A — factory deployment and configuration.
contract FactoryDeploymentTest is X402Base {
    address internal implementation;

    function setUp() public override {
        super.setUp();
        implementation = factory.implementation();
    }

    function test_constructor_deploysTheVaultImplementation() public view {
        assertTrue(implementation.code.length > 0, "implementation has no code");
        assertTrue(implementation != address(0));
    }

    function test_constructor_pointsTheImplementationAtThisFactory() public {
        // Proven behaviourally: the implementation only accepts `initPayout` from its factory, so a
        // call from anywhere else — here, the test — is refused. That is the whole of the
        // implementation/ factory relationship the vault exposes.
        vm.expectRevert(IX402Vault.Unauthorized.selector);
        IX402Vault(implementation).initPayout(payoutAddr);
    }

    function test_constructor_setsTheOwner() public view {
        assertEq(factory.owner(), owner);
    }

    function test_constructor_grantsTheOperatorRole() public view {
        assertEq(operatorRole, 1, "OPERATOR_ROLE should be _ROLE_0");
        assertTrue(factory.hasAnyRole(operator, operatorRole));
        assertEq(factory.rolesOf(operator), operatorRole);
    }

    function test_constructor_doesNotGrantTheOwnerARole() public view {
        // The owner administers roles; it does not thereby hold one. Suite B proves the
        // consequence: the owner cannot create a vault for a third party without the role.
        assertEq(factory.rolesOf(owner), 0);
        assertFalse(factory.hasAnyRole(owner, operatorRole));
    }

    function test_oldOperatorApiIsGone() public {
        // `operator()` and `setOperator(address)` were replaced by the role API. Neither is
        // declared, and the factory has no fallback, so both calls must revert.
        (bool operatorOk,) = address(factory).staticcall(abi.encodeWithSelector(bytes4(keccak256("operator()"))));
        assertFalse(operatorOk, "operator() still responds");

        (bool setterOk,) =
            address(factory).call(abi.encodeWithSelector(bytes4(keccak256("setOperator(address)")), operator2));
        assertFalse(setterOk, "setOperator(address) still responds");
    }

    function test_feeDenominator() public view {
        assertEq(factory.FEE_DENOMINATOR(), 10_000);
    }

    function test_onlyOwnerCanAdministerRoles() public {
        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(stranger);
        factory.grantRoles(stranger, operatorRole);

        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(stranger);
        factory.revokeRoles(operator, operatorRole);
    }

    function test_twoFactoriesHaveDistinctImplementations() public {
        X402VaultFactory other = new X402VaultFactory(owner, operator);
        assertTrue(other.implementation() != implementation);
    }
}
