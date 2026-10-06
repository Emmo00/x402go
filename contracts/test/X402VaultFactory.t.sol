// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "solady/auth/Ownable.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {X402Base} from "./utils/X402Base.sol";
import {X402Vault} from "../src/X402Vault.sol";
import {X402VaultFactory} from "../src/X402VaultFactory.sol";
import {MockERC20, NoReturnToken, RevertingToken} from "./utils/Mocks.sol";

contract X402VaultFactoryTest is X402Base {
    event VaultCreated(address indexed merchant, address indexed vault, address payout);
    event OperatorChanged(address indexed previousOperator, address indexed newOperator);

    address internal payoutAddr;

    function setUp() public override {
        super.setUp();
        payoutAddr = makeAddr("payout");
    }

    // ============================================================ constructor

    function test_constructor_setsOwnerOperatorAndImplementation() public view {
        assertEq(factory.owner(), owner);
        assertEq(factory.operator(), operator);
        assertGt(factory.implementation().code.length, 0);
    }

    function test_constructor_operatorIsSetOnDeploy() public {
        // The operator is the x402Go server wallet and must be usable immediately: it is an
        // argument to the constructor, not a separate post-deploy setup step.
        X402VaultFactory f = new X402VaultFactory(owner, stranger);
        assertEq(f.operator(), stranger);
        vm.prank(stranger);
        f.createVault(merchant, merchant);
    }

    function test_constructor_zeroOperatorIsAcceptedButDisablesOperatorActions() public {
        // Documents behaviour: the constructor does not validate, so a zero operator produces a
        // factory whose vaults nobody can withdraw from until the owner repairs it.
        X402VaultFactory f = new X402VaultFactory(owner, address(0));
        assertEq(f.operator(), address(0));
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        f.createVault(merchant, merchant);
    }

    function test_constructor_eachFactoryGetsItsOwnImplementation() public {
        X402VaultFactory f = new X402VaultFactory(owner, operator);
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
        X402VaultFactory f = new X402VaultFactory(address(0), operator);
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
        vm.expectCall(predicted, abi.encodeWithSelector(X402Vault.initPayout.selector), 0);

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
        vm.expectCall(predicted, abi.encodeCall(X402Vault.initPayout, (payoutAddr)), 1);

        vm.prank(merchant);
        address vault = factory.createVault(merchant, payoutAddr);

        assertEq(vault, predicted);
        assertEq(X402Vault(vault).merchant(), merchant);
        assertEq(X402Vault(vault).payout(), payoutAddr);
        assertEq(X402Vault(vault).nonce(), 0);
        assertEq(vm.load(vault, bytes32(0)), bytes32(uint256(uint160(payoutAddr))));
    }

    function test_createVault_payoutIsSetExactlyOnce() public {
        address vault = _deploy(merchant, payoutAddr);
        // The vault's one-shot initialiser is already spent after creation, so neither the
        // factory nor anyone else can move the payout behind the merchant's back.
        vm.prank(address(factory));
        vm.expectRevert(X402Vault.AlreadyInitialized.selector);
        X402Vault(vault).initPayout(stranger);
        assertEq(X402Vault(vault).payout(), payoutAddr);
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
        X402VaultFactory f2 = new X402VaultFactory(owner, operator);
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

    function test_createVault_duplicateAfterOperatorRotationStillReverts() public {
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

    function test_setOperator_ownerCanRotate() public {
        address newOp = makeAddr("newOp");
        vm.prank(owner);
        factory.setOperator(newOp);
        assertEq(factory.operator(), newOp);
    }

    function test_setOperator_emitsOperatorChanged() public {
        address newOp = makeAddr("newOp");
        vm.expectEmit(true, true, false, true, address(factory));
        emit OperatorChanged(operator, newOp);
        vm.prank(owner);
        factory.setOperator(newOp);
    }

    function test_setOperator_emitsPreviousOperatorNotTheNewOneTwice() public {
        address a = makeAddr("opA");
        address b = makeAddr("opB");
        vm.startPrank(owner);
        factory.setOperator(a);

        vm.expectEmit(true, true, false, true, address(factory));
        emit OperatorChanged(a, b);
        factory.setOperator(b);
        vm.stopPrank();
        assertEq(factory.operator(), b);
    }

    function test_setOperator_rejectsZeroAddress() public {
        // Rotation is also the key-loss recovery path, so it must not be possible to
        // "recover" into a state where no one can withdraw.
        vm.prank(owner);
        vm.expectRevert(X402VaultFactory.InvalidAddress.selector);
        factory.setOperator(address(0));
        assertEq(factory.operator(), operator);
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

    function test_setOperator_oldOperatorLosesAndNewOperatorGainsRights() public {
        address newOp = makeAddr("newOp");
        vm.prank(owner);
        factory.setOperator(newOp);

        vm.prank(operator);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.createVault(merchant, merchant);

        vm.prank(newOp);
        address vault = factory.createVault(merchant, merchant);
        assertEq(X402Vault(vault).merchant(), merchant);
    }

    function test_setOperator_rotatingToSameOperatorIsAllowed() public {
        vm.prank(owner);
        factory.setOperator(operator);
        assertEq(factory.operator(), operator);
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

    // ============================================================ withdrawFees

    function test_withdrawFees_onlyOwner() public {
        token.mint(address(factory), 100);
        address[3] memory callers = [stranger, operator, merchant];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(Ownable.Unauthorized.selector);
            factory.withdrawFees(_arr(address(token)), feeRecipient);
        }
        assertEq(token.balanceOf(address(factory)), 100);
    }

    function test_withdrawFees_rejectsZeroRecipient() public {
        token.mint(address(factory), 100);
        vm.prank(owner);
        vm.expectRevert(X402VaultFactory.InvalidAddress.selector);
        factory.withdrawFees(_arr(address(token)), address(0));
        assertEq(token.balanceOf(address(factory)), 100);
    }

    function test_withdrawFees_sendsFullBalanceToRecipient() public {
        token.mint(address(factory), 100);
        vm.prank(owner);
        factory.withdrawFees(_arr(address(token)), feeRecipient);
        assertEq(token.balanceOf(feeRecipient), 100);
        assertEq(token.balanceOf(address(factory)), 0);
    }

    function test_withdrawFees_multiToken() public {
        MockERC20 t2 = new MockERC20();
        NoReturnToken t3 = new NoReturnToken();
        token.mint(address(factory), 10);
        t2.mint(address(factory), 20);
        t3.mint(address(factory), 30);

        address[] memory t = new address[](3);
        t[0] = address(token);
        t[1] = address(t2);
        t[2] = address(t3);

        vm.prank(owner);
        factory.withdrawFees(t, feeRecipient);

        assertEq(token.balanceOf(feeRecipient), 10);
        assertEq(t2.balanceOf(feeRecipient), 20);
        assertEq(t3.balanceOf(feeRecipient), 30);
        assertEq(token.balanceOf(address(factory)), 0);
    }

    function test_withdrawFees_canBeCalledRepeatedly() public {
        token.mint(address(factory), 40);
        vm.startPrank(owner);
        factory.withdrawFees(_arr(address(token)), feeRecipient);
        factory.withdrawFees(_arr(address(token)), feeRecipient); // nothing left, still no revert
        vm.stopPrank();
        assertEq(token.balanceOf(feeRecipient), 40);
    }

    function test_withdrawFees_emptyListIsNoOp() public {
        token.mint(address(factory), 5);
        vm.prank(owner);
        factory.withdrawFees(new address[](0), feeRecipient);
        assertEq(token.balanceOf(address(factory)), 5);
    }

    function test_withdrawFees_revertingTokenRevertsTheWholeCall() public {
        token.mint(address(factory), 10);
        address[] memory t = new address[](2);
        t[0] = address(token);
        t[1] = address(new RevertingToken());

        vm.prank(owner);
        vm.expectRevert(SafeTransferLib.TransferFailed.selector);
        factory.withdrawFees(t, feeRecipient);
        assertEq(token.balanceOf(address(factory)), 10, "first leg rolled back");
    }

    function test_withdrawFees_onlyTouchesListedTokens() public {
        MockERC20 other = new MockERC20();
        token.mint(address(factory), 10);
        other.mint(address(factory), 99);

        vm.prank(owner);
        factory.withdrawFees(_arr(address(token)), feeRecipient);

        assertEq(other.balanceOf(address(factory)), 99);
        assertEq(other.balanceOf(feeRecipient), 0);
    }

    function test_withdrawFees_thenRotationDoesNotAffectPastFees() public {
        // The owner controls both the fee sink and the operator; neither can be reached by the
        // other. Rotating the operator must not move already-collected fees.
        token.mint(address(factory), 30);
        vm.prank(owner);
        factory.setOperator(stranger);
        assertEq(token.balanceOf(address(factory)), 30);

        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.withdrawFees(_arr(address(token)), feeRecipient);
    }

    // ---- fees land in the factory as a direct result of a vault withdrawal

    function test_withdrawFees_sweepsFeesProducedByVaultWithdrawals() public {
        address vault = _deploy(merchant, merchant);
        token.mint(vault, 100);

        vm.prank(operator);
        X402Vault(vault).withdraw(_arr(address(token)), _arr(uint256(90)), _arr(uint256(10)));
        assertEq(token.balanceOf(address(factory)), 10, "vault routed the fee leg to the factory");

        vm.prank(owner);
        factory.withdrawFees(_arr(address(token)), feeRecipient);
        assertEq(token.balanceOf(feeRecipient), 10);
        assertEq(token.balanceOf(address(factory)), 0);
        assertEq(token.balanceOf(merchant), 90, "merchant funds untouched by the fee sweep");
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

    function test_ownership_renounceBricksOwnerActionsButKeepsOperator() public {
        vm.prank(owner);
        factory.renounceOwnership();
        assertEq(factory.owner(), address(0));

        vm.prank(owner);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.setOperator(stranger);

        vm.prank(owner);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.withdrawFees(_arr(address(token)), feeRecipient);

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

    function testFuzz_createVault_unauthorizedCaller(address caller, address m, address p) public {
        vm.assume(m != address(0) && p != address(0));
        vm.assume(caller != m && caller != operator);
        address predicted = factory.vaultOf(m);

        vm.prank(caller);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.createVault(m, p);
        assertEq(predicted.code.length, 0);
    }

    function testFuzz_createVault_addressIndependentOfPayout(address m, address p1, address p2) public {
        vm.assume(m != address(0) && p1 != address(0) && p2 != address(0));
        address predicted = factory.vaultOf(m);
        address vault = _deploy(m, p1);
        assertEq(vault, predicted);
        // and a second attempt with any other payout always collides
        vm.prank(operator);
        vm.expectRevert(X402VaultFactory.VaultExists.selector);
        factory.createVault(m, p2);
    }

    function testFuzz_createVault_distinctMerchantsDistinctVaults(address a, address b) public {
        vm.assume(a != address(0) && b != address(0) && a != b);
        address va = _deploy(a, a);
        address vb = _deploy(b, b);
        assertTrue(va != vb);
        assertEq(X402Vault(va).merchant(), a);
        assertEq(X402Vault(vb).merchant(), b);
    }

    function testFuzz_vaultOf_matchesLibClonePrediction(address m) public view {
        address expected = LibClone.predictDeterministicAddress(
            factory.implementation(), abi.encodePacked(m), bytes32(uint256(uint160(m))), address(factory)
        );
        assertEq(factory.vaultOf(m), expected);
    }

    function testFuzz_setOperator_onlyOwner(address caller, address newOp) public {
        vm.assume(caller != owner);
        vm.assume(newOp != address(0));
        vm.prank(caller);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.setOperator(newOp);
        assertEq(factory.operator(), operator);

        vm.prank(owner);
        factory.setOperator(newOp);
        assertEq(factory.operator(), newOp);
    }

    function testFuzz_setOperator_zeroAlwaysRejected(address caller) public {
        vm.prank(caller);
        if (caller != owner) {
            vm.expectRevert(Ownable.Unauthorized.selector);
        } else {
            vm.expectRevert(X402VaultFactory.InvalidAddress.selector);
        }
        factory.setOperator(address(0));
        assertEq(factory.operator(), operator);
    }

    function testFuzz_setOperator_rotationMovesRights(address newOp, address m) public {
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

    function testFuzz_withdrawFees_onlyOwnerCanSweep(address caller, uint128 amount) public {
        token.mint(address(factory), amount);
        vm.assume(caller != owner);

        vm.prank(caller);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.withdrawFees(_arr(address(token)), feeRecipient);
        assertEq(token.balanceOf(address(factory)), amount);

        vm.prank(owner);
        factory.withdrawFees(_arr(address(token)), feeRecipient);
        assertEq(token.balanceOf(feeRecipient), amount);
    }

    function testFuzz_withdrawFees_fullBalanceNeverPartial(uint128 amount) public {
        token.mint(address(factory), amount);
        vm.prank(owner);
        factory.withdrawFees(_arr(address(token)), feeRecipient);
        assertEq(token.balanceOf(feeRecipient), amount);
        assertEq(token.balanceOf(address(factory)), 0);
    }
}
