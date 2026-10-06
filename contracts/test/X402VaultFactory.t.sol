// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "solady/auth/Ownable.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {X402Base} from "./utils/X402Base.sol";
import {X402Vault} from "../src/X402Vault.sol";
import {X402VaultFactory} from "../src/X402VaultFactory.sol";

contract X402VaultFactoryTest is X402Base {
    event VaultCreated(
        address indexed merchant,
        address indexed vault,
        address payout
    );

    address internal payoutAddr;

    function setUp() public override {
        super.setUp();
        payoutAddr = makeAddr("payout");
    }

    // ============================================================ constructor

    function test_constructor_setsOwnerAndImplementation() public view {
        assertEq(factory.owner(), owner);
        assertEq(factory.operator(), operator);
        assertGt(factory.implementation().code.length, 0);
    }

    function test_constructor_operatorStartsUnset() public {
        X402VaultFactory f = new X402VaultFactory(owner);
        assertEq(f.operator(), address(0));
    }

    function test_constructor_eachFactoryGetsItsOwnImplementation() public {
        X402VaultFactory f = new X402VaultFactory(owner);
        assertTrue(f.implementation() != factory.implementation());
    }

    function test_constructor_implementationIsBoundToFactory() public {
        address impl = factory.implementation();
        // Only the factory may call initPayout on the implementation.
        vm.expectRevert(X402Vault.Unauthorized.selector);
        X402Vault(impl).initPayout(payoutAddr);

        vm.prank(address(factory));
        X402Vault(impl).initPayout(payoutAddr); // does not revert
    }

    function test_constructor_zeroOwnerIsAcceptedAndLocksOperator() public {
        // Documents behaviour: Solady's _initializeOwner does not reject address(0).
        X402VaultFactory f = new X402VaultFactory(address(0));
        assertEq(f.owner(), address(0));
        vm.expectRevert(Ownable.Unauthorized.selector);
        f.setOperator(operator);
    }

    // ============================================================ createVault: happy paths

    function test_createVault_bySelf_defaultPayout() public {
        address predicted = factory.vaultOf(merchant);
        assertEq(predicted.code.length, 0, "not deployed yet");

        vm.expectEmit(true, true, false, true, address(factory));
        emit VaultCreated(merchant, predicted, merchant);
        vm.expectCall(
            predicted,
            abi.encodeWithSelector(X402Vault.initPayout.selector),
            0
        );

        vm.prank(merchant);
        address vault = factory.createVault(merchant, merchant);

        assertEq(vault, predicted);
        assertGt(vault.code.length, 0);
        assertEq(X402Vault(vault).merchant(), merchant);
        assertEq(X402Vault(vault).payout(), merchant);
        assertEq(X402Vault(vault).nonce(), 0);
        // payout == merchant needs no storage write at all
        assertEq(vm.load(vault, bytes32(0)), bytes32(0));
    }

    function test_createVault_bySelf_customPayout() public {
        address predicted = factory.vaultOf(merchant);

        vm.expectEmit(true, true, false, true, address(factory));
        emit VaultCreated(merchant, predicted, payoutAddr);
        vm.expectCall(
            predicted,
            abi.encodeCall(X402Vault.initPayout, (payoutAddr)),
            1
        );

        vm.prank(merchant);
        address vault = factory.createVault(merchant, payoutAddr);

        assertEq(vault, predicted);
        assertEq(X402Vault(vault).merchant(), merchant);
        assertEq(X402Vault(vault).payout(), payoutAddr);
        assertEq(X402Vault(vault).nonce(), 0);
        assertEq(
            vm.load(vault, bytes32(0)),
            bytes32(uint256(uint160(payoutAddr)))
        );
    }

    function test_createVault_byOperatorOnBehalfOfMerchant() public {
        vm.prank(operator);
        address vault = factory.createVault(merchant, payoutAddr);
        assertEq(X402Vault(vault).merchant(), merchant);
        assertEq(X402Vault(vault).payout(), payoutAddr);
    }

    function test_createVault_operatorCreatingForItself() public {
        vm.prank(operator);
        address vault = factory.createVault(operator, operator);
        assertEq(X402Vault(vault).merchant(), operator);
    }

    function test_createVault_cloneArgsEncodeMerchant() public {
        address vault = _deploy(merchant, payoutAddr);
        assertEq(LibClone.argsOnClone(vault), abi.encodePacked(merchant));
    }

    function test_createVault_vaultsAreIndependent() public {
        address m2 = makeAddr("m2");
        address v1 = _deploy(merchant, payoutAddr);
        address v2 = _deploy(m2, m2);
        assertTrue(v1 != v2);
        assertEq(X402Vault(v1).merchant(), merchant);
        assertEq(X402Vault(v2).merchant(), m2);
        assertEq(X402Vault(v1).payout(), payoutAddr);
        assertEq(X402Vault(v2).payout(), m2);
    }

    function test_createVault_sameMerchantOnDifferentFactoriesDiffers() public {
        X402VaultFactory f2 = new X402VaultFactory(owner);
        assertTrue(f2.vaultOf(merchant) != factory.vaultOf(merchant));
    }

    function test_createVault_payoutCanBeAContract() public {
        address vault = _deploy(merchant, address(token));
        assertEq(X402Vault(vault).payout(), address(token));
    }

    // ============================================================ createVault: failures

    function test_createVault_revertsOnZeroMerchant() public {
        vm.prank(operator);
        vm.expectRevert(X402VaultFactory.InvalidAddress.selector);
        factory.createVault(address(0), payoutAddr);
    }

    function test_createVault_revertsOnZeroPayout() public {
        vm.prank(merchant);
        vm.expectRevert(X402VaultFactory.InvalidAddress.selector);
        factory.createVault(merchant, address(0));
    }

    function test_createVault_zeroChecksRunBeforeAuthorization() public {
        // A stranger sees InvalidAddress, not Unauthorized: documents check ordering.
        vm.prank(stranger);
        vm.expectRevert(X402VaultFactory.InvalidAddress.selector);
        factory.createVault(address(0), payoutAddr);
    }

    function test_createVault_revertsForStranger() public {
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.createVault(merchant, payoutAddr);
    }

    function test_createVault_ownerIsNotImplicitlyAuthorized() public {
        vm.prank(owner);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.createVault(merchant, payoutAddr);
    }

    function test_createVault_merchantCannotCreateForSomeoneElse() public {
        address other = makeAddr("other");
        vm.prank(merchant);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.createVault(other, other);
    }

    function test_createVault_noStateWrittenOnUnauthorized() public {
        address predicted = factory.vaultOf(merchant);
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.createVault(merchant, payoutAddr);
        assertEq(predicted.code.length, 0);
    }

    function test_createVault_duplicateRevertsCleanly() public {
        vm.prank(merchant);
        address vault = factory.createVault(merchant, payoutAddr);

        uint256 g = gasleft();
        vm.prank(merchant);
        vm.expectRevert(X402VaultFactory.VaultExists.selector);
        factory.createVault(merchant, merchant);
        // A raw CREATE2 collision would burn ~all forwarded gas; the pre-check must not.
        assertLt(g - gasleft(), 100_000);

        // original vault untouched
        assertEq(X402Vault(vault).payout(), payoutAddr);
    }

    function test_createVault_duplicateByOperatorReverts() public {
        _deploy(merchant, merchant);
        vm.prank(operator);
        vm.expectRevert(X402VaultFactory.VaultExists.selector);
        factory.createVault(merchant, payoutAddr);
    }

    function test_createVault_duplicateAfterOperatorRotationStillReverts()
        public
    {
        _deploy(merchant, merchant);
        vm.prank(owner);
        factory.setOperator(stranger);
        vm.prank(merchant);
        vm.expectRevert(X402VaultFactory.VaultExists.selector);
        factory.createVault(merchant, merchant);
    }

    // ============================================================ vaultOf

    function test_vaultOf_stableBeforeAndAfterDeployment() public {
        address before = factory.vaultOf(merchant);
        address vault = _deploy(merchant, payoutAddr);
        assertEq(before, vault);
        assertEq(factory.vaultOf(merchant), vault);
    }

    function test_vaultOf_differsPerMerchant() public view {
        assertTrue(factory.vaultOf(address(1)) != factory.vaultOf(address(2)));
    }

    function test_vaultOf_zeroAddressStillComputes() public view {
        // No revert; it is just a prediction that createVault can never deploy.
        assertTrue(factory.vaultOf(address(0)) != address(0));
    }

    // ============================================================ setOperator

    function test_setOperator_ownerCanSet() public {
        vm.prank(owner);
        factory.setOperator(stranger);
        assertEq(factory.operator(), stranger);
    }

    function test_setOperator_canBeCleared() public {
        vm.prank(owner);
        factory.setOperator(address(0));
        assertEq(factory.operator(), address(0));
    }

    function test_setOperator_revertsForNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.setOperator(stranger);
    }

    function test_setOperator_operatorCannotSelfRotate() public {
        vm.prank(operator);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.setOperator(stranger);
    }

    function test_setOperator_firstTimeSetWorksFromUnset() public {
        // Regression: the original contract required msg.sender == operator, bricking this.
        X402VaultFactory f = new X402VaultFactory(owner);
        vm.prank(owner);
        f.setOperator(operator);
        assertEq(f.operator(), operator);
    }

    function test_setOperator_rotationMovesCreateRights() public {
        address newOp = makeAddr("newOp");
        vm.prank(owner);
        factory.setOperator(newOp);

        vm.prank(operator);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.createVault(merchant, merchant);

        vm.prank(newOp);
        factory.createVault(merchant, merchant);
    }

    function test_setOperator_unsetOperatorMeansStrangersStillBlocked() public {
        vm.prank(owner);
        factory.setOperator(address(0));
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.createVault(merchant, merchant);
    }

    // ============================================================ ownership (Solady Ownable)

    function test_ownership_directTransfer() public {
        vm.prank(owner);
        factory.transferOwnership(stranger);
        assertEq(factory.owner(), stranger);

        vm.prank(owner);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.setOperator(owner);

        vm.prank(stranger);
        factory.setOperator(owner);
        assertEq(factory.operator(), owner);
    }

    function test_ownership_twoStepHandover() public {
        vm.prank(stranger);
        factory.requestOwnershipHandover();

        vm.prank(owner);
        factory.completeOwnershipHandover(stranger);
        assertEq(factory.owner(), stranger);
    }

    function test_ownership_handoverExpires() public {
        vm.prank(stranger);
        factory.requestOwnershipHandover();
        vm.warp(block.timestamp + 2 days + 1);

        vm.prank(owner);
        vm.expectRevert(Ownable.NoHandoverRequest.selector);
        factory.completeOwnershipHandover(stranger);
    }

    function test_ownership_renounceBricksSetOperatorButKeepsOperator() public {
        vm.prank(owner);
        factory.renounceOwnership();
        assertEq(factory.owner(), address(0));

        vm.prank(owner);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.setOperator(stranger);

        // existing operator keeps working
        vm.prank(operator);
        factory.createVault(merchant, merchant);
    }

    function test_ownership_transferToZeroReverts() public {
        vm.prank(owner);
        vm.expectRevert(Ownable.NewOwnerIsZeroAddress.selector);
        factory.transferOwnership(address(0));
    }

    // ============================================================ fuzz

    function testFuzz_createVault_selfService(address m, address p) public {
        vm.assume(m != address(0) && p != address(0));
        address predicted = factory.vaultOf(m);

        vm.prank(m);
        address vault = factory.createVault(m, p);

        assertEq(vault, predicted);
        assertEq(X402Vault(vault).merchant(), m);
        assertEq(X402Vault(vault).payout(), p);
        assertEq(X402Vault(vault).nonce(), 0);
        if (p == m) {
            assertEq(vm.load(vault, bytes32(0)), bytes32(0));
        } else {
            assertEq(vm.load(vault, bytes32(0)), bytes32(uint256(uint160(p))));
        }
    }

    function testFuzz_createVault_byOperator(address m, address p) public {
        vm.assume(m != address(0) && p != address(0));
        address vault = _deploy(m, p);
        assertEq(X402Vault(vault).merchant(), m);
        assertEq(X402Vault(vault).payout(), p);
    }

    function testFuzz_createVault_unauthorizedCaller(
        address caller,
        address m,
        address p
    ) public {
        vm.assume(m != address(0) && p != address(0));
        vm.assume(caller != m && caller != operator);
        address predicted = factory.vaultOf(m);

        vm.prank(caller);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.createVault(m, p);
        assertEq(predicted.code.length, 0);
    }

    function testFuzz_createVault_addressIndependentOfPayout(
        address m,
        address p1,
        address p2
    ) public {
        vm.assume(m != address(0) && p1 != address(0) && p2 != address(0));
        address predicted = factory.vaultOf(m);
        address vault = _deploy(m, p1);
        assertEq(vault, predicted);
        // and a second attempt with any other payout always collides
        vm.prank(operator);
        vm.expectRevert(X402VaultFactory.VaultExists.selector);
        factory.createVault(m, p2);
    }

    function testFuzz_createVault_distinctMerchantsDistinctVaults(
        address a,
        address b
    ) public {
        vm.assume(a != address(0) && b != address(0) && a != b);
        address va = _deploy(a, a);
        address vb = _deploy(b, b);
        assertTrue(va != vb);
        assertEq(X402Vault(va).merchant(), a);
        assertEq(X402Vault(vb).merchant(), b);
    }

    function testFuzz_vaultOf_matchesLibClonePrediction(address m) public view {
        address expected = LibClone.predictDeterministicAddress(
            factory.implementation(),
            abi.encodePacked(m),
            bytes32(uint256(uint160(m))),
            address(factory)
        );
        assertEq(factory.vaultOf(m), expected);
    }

    function testFuzz_setOperator_onlyOwner(
        address caller,
        address newOp
    ) public {
        vm.assume(caller != owner);
        vm.prank(caller);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.setOperator(newOp);
        assertEq(factory.operator(), operator);

        vm.prank(owner);
        factory.setOperator(newOp);
        assertEq(factory.operator(), newOp);
    }

    function testFuzz_operatorRotation_newOperatorGainsAndOldLosesRights(
        address newOp,
        address m
    ) public {
        vm.assume(newOp != address(0) && newOp != operator && newOp != m);
        vm.assume(m != address(0) && m != operator);

        vm.prank(owner);
        factory.setOperator(newOp);

        vm.prank(operator);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.createVault(m, m);

        vm.prank(newOp);
        address vault = factory.createVault(m, m);
        assertEq(X402Vault(vault).merchant(), m);
    }
}
