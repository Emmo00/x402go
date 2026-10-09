// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {X402Base} from "./utils/X402Base.sol";
import {X402Vault} from "../src/X402Vault.sol";
import {IX402VaultFactory} from "../src/interfaces/IX402VaultFactory.sol";

/// @dev Suite C — vault creation, deterministic addressing and the payout override.
contract VaultCreationTest is X402Base {
    address internal merchant2 = makeAddr("merchant2");
    address internal merchant3 = makeAddr("merchant3");

    function test_vaultOfPredictsTheAddressBeforeAndAfterDeployment() public {
        address predicted = factory.vaultOf(merchant);
        assertEq(predicted.code.length, 0, "nothing should be deployed yet");

        address vault = _deploy(merchant, merchant);

        assertEq(vault, predicted);
        assertEq(factory.vaultOf(merchant), predicted);
        assertTrue(vault.code.length > 0);
    }

    function test_cloneArgCarriesTheMerchant() public {
        address vault = _deploy(merchant, merchant);
        assertEq(X402Vault(vault).merchant(), merchant);
    }

    function test_secondCreateForTheSameMerchantReverts() public {
        _deploy(merchant, merchant);

        vm.expectRevert(IX402VaultFactory.VaultExists.selector);
        vm.prank(operator);
        factory.createVault(merchant, merchant);
    }

    function test_secondCreateRevertsEvenFromADifferentAuthorisedParty() public {
        _deploy(merchant, merchant);

        vm.prank(owner);
        factory.grantRoles(operator2, operatorRole);

        vm.expectRevert(IX402VaultFactory.VaultExists.selector);
        vm.prank(operator2);
        factory.createVault(merchant, payoutAddr);
    }

    function test_secondCreateRevertsEvenForTheMerchantThemselves() public {
        _deploy(merchant, merchant);

        vm.expectRevert(IX402VaultFactory.VaultExists.selector);
        vm.prank(merchant);
        factory.createVault(merchant, merchant);
    }

    function test_collisionIsDetectedBeforeTheCloneIsAttempted() public {
        // A CREATE2 collision burns all forwarded gas, so the factory predicts first. Deploying
        // directly to the predicted address proves the check is what rejects it, not the EVM.
        address predicted = factory.vaultOf(merchant);
        vm.etch(predicted, hex"00");

        vm.expectRevert(IX402VaultFactory.VaultExists.selector);
        vm.prank(operator);
        factory.createVault(merchant, merchant);
    }

    function test_payoutOverrideIsInstalled() public {
        address vault = _deploy(merchant, payoutAddr);

        assertEq(X402Vault(vault).payout(), payoutAddr);
        assertEq(X402Vault(vault).merchant(), merchant);
    }

    function test_payoutEqualToMerchantLeavesTheSlotUnset() public {
        address vault = _deploy(merchant, merchant);

        assertEq(X402Vault(vault).payout(), merchant);
        // Not merely "payout() returns the merchant": the override slot really is untouched, which
        // is what lets `payout()` fall through to `merchant()`.
        assertEq(uint256(vm.load(vault, bytes32(uint256(0)))), 0);
    }

    function test_vaultCreatedEventCarriesTheFinalsPayout() public {
        address predicted = factory.vaultOf(merchant);

        vm.expectEmit(true, true, false, true, address(factory));
        emit IX402VaultFactory.VaultCreated(merchant, predicted, payoutAddr);

        vm.prank(operator);
        factory.createVault(merchant, payoutAddr);
    }

    function test_differentMerchantsGetDistinctVaults() public {
        address a = _deploy(merchant, merchant);
        address b = _deploy(merchant2, merchant2);
        address c = _deploy(merchant3, merchant3);

        assertTrue(a != b && b != c && a != c);
    }

    function test_vaultAddressDoesNotDependOnWhoCreatedIt() public {
        // The salt is the merchant and the implementation is fixed, so the creator is not an input.
        address predicted3 = factory.vaultOf(merchant3);

        vm.prank(merchant3);
        address selfMade = factory.createVault(merchant3, merchant3);

        assertEq(selfMade, predicted3);

        address predicted2 = factory.vaultOf(merchant2);
        address operatorMade = _deployAs(operator, merchant2, merchant2);

        assertEq(operatorMade, predicted2);
    }

    function test_tokensSentToThePredictedAddressSurviveDeployment() public {
        address predicted = factory.vaultOf(merchant);
        token6.mint(predicted, 1_000e6);

        address vault = _deploy(merchant, merchant);

        assertEq(vault, predicted);
        assertEq(token6.balanceOf(vault), 1_000e6);
    }
}
