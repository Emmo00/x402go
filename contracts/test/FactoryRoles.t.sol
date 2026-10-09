// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {X402Base} from "./utils/X402Base.sol";
import {IX402VaultFactory} from "../src/interfaces/IX402VaultFactory.sol";
import {Ownable} from "solady/auth/Ownable.sol";

/// @dev Suite B — the role model and `createVault` authorisation.
contract FactoryRolesTest is X402Base {
    address internal merchant2 = makeAddr("merchant2");

    function test_merchantCreatesTheirOwnVault() public {
        address vault = _deployAs(merchant, merchant, merchant);
        assertEq(vault, factory.vaultOf(merchant));
    }

    function test_roleHolderCreatesForAnyMerchant() public {
        address vault = _deployAs(operator, merchant2, merchant2);
        assertEq(vault, factory.vaultOf(merchant2));
    }

    function test_strangerIsRejected() public {
        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(stranger);
        factory.createVault(merchant, merchant);
    }

    function test_ownerWithoutTheRoleIsRejected() public {
        assertEq(factory.rolesOf(owner), 0);

        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(owner);
        factory.createVault(merchant, merchant);
    }

    function test_ownerMayCreateTheirOwnVault() public {
        // The merchant branch of the check does not care who the merchant is, so the owner acting
        // as their own merchant is allowed even holding no role.
        address vault = _deployAs(owner, owner, owner);
        assertEq(vault, factory.vaultOf(owner));
    }

    function test_grantingTheRoleLetsAnAddressCreate() public {
        vm.prank(owner);
        factory.grantRoles(operator2, operatorRole);

        address vault = _deployAs(operator2, merchant2, merchant2);
        assertEq(vault, factory.vaultOf(merchant2));
    }

    function test_revokingTheRoleTakesTheAbilityAway() public {
        vm.prank(owner);
        factory.revokeRoles(operator, operatorRole);

        assertEq(factory.rolesOf(operator), 0);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(operator);
        factory.createVault(merchant2, merchant2);
    }

    function test_multipleOperatorsAtOnce() public {
        vm.prank(owner);
        factory.grantRoles(operator2, operatorRole);

        assertTrue(factory.hasAnyRole(operator, operatorRole));
        assertTrue(factory.hasAnyRole(operator2, operatorRole));
    }

    function test_rotation_grantNewRevokeOld() public {
        vm.startPrank(owner);
        factory.grantRoles(operator2, operatorRole);
        factory.revokeRoles(operator, operatorRole);
        vm.stopPrank();

        // The old operator is out...
        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(operator);
        factory.createVault(merchant, merchant);

        // ...and the new one is in.
        address vault = _deployAs(operator2, merchant, merchant);
        assertEq(vault, factory.vaultOf(merchant));
    }

    function test_renouncingTheRoleWorks() public {
        vm.prank(operator);
        factory.renounceRoles(operatorRole);

        assertEq(factory.rolesOf(operator), 0);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(operator);
        factory.createVault(merchant, merchant);
    }

    function test_renouncingAnotherAddresssRoleDoesNothing() public {
        // `renounceRoles` is self-service in solady: it removes the caller's own roles, so a
        // stranger calling it cannot disarm the operator.
        vm.prank(stranger);
        factory.renounceRoles(operatorRole);

        assertTrue(factory.hasAnyRole(operator, operatorRole));
    }

    function test_createVaultRejectsZeroMerchant() public {
        vm.expectRevert(IX402VaultFactory.InvalidAddress.selector);
        vm.prank(operator);
        factory.createVault(address(0), merchant);
    }

    function test_createVaultRejectsZeroPayout() public {
        vm.expectRevert(IX402VaultFactory.InvalidAddress.selector);
        vm.prank(operator);
        factory.createVault(merchant, address(0));
    }

    function test_createVaultRejectsZeroArgumentsBeforeTheAuthorisationCheck() public {
        // The address check runs first, so even an unauthorised caller learns nothing from the
        // revert beyond "those arguments are invalid".
        vm.expectRevert(IX402VaultFactory.InvalidAddress.selector);
        vm.prank(stranger);
        factory.createVault(address(0), address(0));
    }

    function test_grantAndRevokeAreIdempotent() public {
        vm.startPrank(owner);
        factory.grantRoles(operator, operatorRole);
        factory.grantRoles(operator, operatorRole);
        assertEq(factory.rolesOf(operator), operatorRole);

        factory.revokeRoles(operator, operatorRole);
        factory.revokeRoles(operator, operatorRole);
        assertEq(factory.rolesOf(operator), 0);
        vm.stopPrank();
    }
}
