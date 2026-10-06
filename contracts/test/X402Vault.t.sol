// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {stdError} from "forge-std/StdError.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {X402Base} from "./utils/X402Base.sol";
import {X402Vault} from "../src/X402Vault.sol";
import {X402VaultFactory} from "../src/X402VaultFactory.sol";
import {MockERC20, NoReturnToken, FalseReturnToken, RevertingToken, ReentrantToken, Mock1271Wallet, Reverting1271Wallet} from "./utils/Mocks.sol";

contract X402VaultTest is X402Base {
    X402Vault internal vault; // payout == merchant (no storage written)
    X402Vault internal customVault; // payout override set at creation

    uint256 internal customPk;
    address internal customMerchant;
    address internal payoutAddr;

    function setUp() public override {
        super.setUp();
        payoutAddr = makeAddr("payout");
        customPk = 0xB0B;
        customMerchant = vm.addr(customPk);

        vault = X402Vault(_deploy(merchant, merchant));
        customVault = X402Vault(_deploy(customMerchant, payoutAddr));
    }

    // -------------------------------------------------------------- local helpers

    function _change(X402Vault v, uint256 pk, address newPayout) internal {
        v.changePayout(newPayout, _sig(pk, address(v), newPayout, v.nonce()));
    }

    function _withdraw(
        X402Vault v,
        address[] memory t,
        uint256[] memory m,
        uint256[] memory f
    ) internal {
        vm.prank(operator);
        v.withdrawAll(t, m, f, feeRecipient);
    }

    function _flip(
        bytes memory sig65
    ) internal pure returns (bytes memory out) {
        // High-s twin of a 65-byte signature: (r, n - s, v ^ 1)
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig65, 0x20))
            s := mload(add(sig65, 0x40))
            v := byte(0, mload(add(sig65, 0x60)))
        }
        s = bytes32(SECP_N - uint256(s));
        v = v == 27 ? 28 : 27;
        out = abi.encodePacked(r, s, v);
    }

    // ============================================================ views / initialisation

    function test_merchant_readFromCloneArgs() public view {
        assertEq(vault.merchant(), merchant);
        assertEq(customVault.merchant(), customMerchant);
    }

    function test_payout_defaultsToMerchant() public view {
        assertEq(vault.payout(), merchant);
    }

    function test_payout_customOverride() public view {
        assertEq(customVault.payout(), payoutAddr);
    }

    function test_storage_defaultVaultSlotIsEmpty() public view {
        assertEq(vm.load(address(vault), bytes32(0)), bytes32(0));
    }

    function test_storage_payoutAndNonceArePackedInSlotZero() public {
        address np = makeAddr("np");
        _change(vault, merchantPk, np);
        // layout: [ nonce:uint96 | payout:address ]
        assertEq(
            vm.load(address(vault), bytes32(0)),
            bytes32((uint256(1) << 160) | uint256(uint160(np)))
        );
    }

    function test_initPayout_onlyFactory() public {
        address[4] memory callers = [stranger, operator, owner, merchant];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(X402Vault.Unauthorized.selector);
            vault.initPayout(payoutAddr);
        }
        vm.prank(address(factory));
        vault.initPayout(payoutAddr);
        assertEq(vault.payout(), payoutAddr);
    }

    function test_initPayout_preservesNonce() public {
        _change(vault, merchantPk, makeAddr("a"));
        assertEq(vault.nonce(), 1);
        vm.prank(address(factory));
        vault.initPayout(payoutAddr);
        assertEq(vault.nonce(), 1);
        assertEq(vault.payout(), payoutAddr);
    }

    function test_initPayout_zeroFallsBackToMerchant() public {
        vm.prank(address(factory));
        customVault.initPayout(address(0));
        assertEq(customVault.payout(), customMerchant);
    }

    function test_implementation_isNotUsableAsVaultForOthers() public {
        // The implementation itself can only be poked by the factory.
        X402Vault impl = X402Vault(factory.implementation());
        vm.expectRevert(X402Vault.Unauthorized.selector);
        impl.initPayout(payoutAddr);
    }

    // ============================================================ EIP-712 domain

    function test_eip712Domain_reportsVaultAsVerifyingContract() public view {
        (
            ,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifying,
            ,

        ) = vault.eip712Domain();
        assertEq(name, "X402Vault");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifying, address(vault));
    }

    function test_domain_signatureNotValidOnOtherVault() public {
        bytes memory sig = _sig(merchantPk, address(vault), payoutAddr, 0);
        // same merchant key, but customVault belongs to another merchant AND has another domain
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        customVault.changePayout(payoutAddr, sig);
    }

    function test_domain_sameMerchantSignatureCannotCrossFactories() public {
        // A second factory/vault for the same merchant has a different address -> different domain.
        X402VaultFactoryLike f2 = new X402VaultFactoryLike();
        address v2 = f2.make(merchant);
        bytes memory sig = _sig(merchantPk, address(vault), payoutAddr, 0);
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        X402Vault(v2).changePayout(payoutAddr, sig);
    }

    function test_domain_chainIdChangeInvalidatesOldSignatureAndAcceptsNew()
        public
    {
        bytes memory oldSig = _sig(merchantPk, address(vault), payoutAddr, 0);
        vm.chainId(block.chainid + 1);

        vm.expectRevert(X402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, oldSig);

        bytes memory newSig = _sig(merchantPk, address(vault), payoutAddr, 0);
        vault.changePayout(payoutAddr, newSig);
        assertEq(vault.payout(), payoutAddr);
    }

    // ============================================================ changePayout: success paths

    function test_changePayout_updatesPayoutAndNonce() public {
        _change(vault, merchantPk, payoutAddr);
        assertEq(vault.payout(), payoutAddr);
        assertEq(vault.nonce(), 1);
    }

    function test_changePayout_worksOnCustomVault() public {
        address np = makeAddr("np");
        _change(customVault, customPk, np);
        assertEq(customVault.payout(), np);
    }

    function test_changePayout_anyoneCanRelayMerchantSignature() public {
        bytes memory sig = _sig(merchantPk, address(vault), payoutAddr, 0);
        vm.prank(stranger);
        vault.changePayout(payoutAddr, sig);
        assertEq(vault.payout(), payoutAddr);
    }

    function test_changePayout_sequentialChangesUseIncreasingNonces() public {
        for (uint256 i; i < 5; ++i) {
            address np = address(uint160(0x1000 + i));
            _change(vault, merchantPk, np);
            assertEq(vault.payout(), np);
            assertEq(vault.nonce(), i + 1);
        }
    }

    function test_changePayout_toCurrentPayoutStillConsumesNonce() public {
        _change(vault, merchantPk, merchant); // payout already effectively merchant
        assertEq(vault.payout(), merchant);
        assertEq(vault.nonce(), 1);
    }

    function test_changePayout_canSwitchBackToMerchantAddress() public {
        _change(vault, merchantPk, payoutAddr);
        _change(vault, merchantPk, merchant);
        assertEq(vault.payout(), merchant);
        assertEq(vault.nonce(), 2);
    }

    function test_changePayout_compactEip2098Signature() public {
        bytes memory sig = _compactSig(
            merchantPk,
            address(vault),
            payoutAddr,
            0
        );
        assertEq(sig.length, 64);
        vault.changePayout(payoutAddr, sig);
        assertEq(vault.payout(), payoutAddr);
    }

    // ============================================================ changePayout: failures

    function test_changePayout_revertsOnZeroPayout() public {
        bytes memory sig = _sig(merchantPk, address(vault), address(0), 0);
        vm.expectRevert(X402Vault.InvalidAddress.selector);
        vault.changePayout(address(0), sig);
    }

    function test_changePayout_zeroCheckRunsBeforeSignatureCheck() public {
        vm.expectRevert(X402Vault.InvalidAddress.selector);
        vault.changePayout(address(0), hex"");
    }

    function test_changePayout_replayReverts() public {
        bytes memory sig = _sig(merchantPk, address(vault), payoutAddr, 0);
        vault.changePayout(payoutAddr, sig);
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, sig);
    }

    function test_changePayout_oldSignatureCannotRevertLaterChange() public {
        // The attack the nonce exists to stop: replay A, change to B, replay A's sig to undo B.
        address a = makeAddr("A");
        address b = makeAddr("B");
        bytes memory sigA = _sig(merchantPk, address(vault), a, 0);
        vault.changePayout(a, sigA);
        _change(vault, merchantPk, b);
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        vault.changePayout(a, sigA);
        assertEq(vault.payout(), b);
    }

    function test_changePayout_futureNonceReverts() public {
        bytes memory sig = _sig(merchantPk, address(vault), payoutAddr, 1);
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, sig);
    }

    function test_changePayout_signedPayoutMismatchReverts() public {
        bytes memory sig = _sig(merchantPk, address(vault), payoutAddr, 0);
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        vault.changePayout(stranger, sig);
    }

    function test_changePayout_wrongSignerReverts() public {
        uint256[3] memory pks = [uint256(0xDEAD), customPk, uint256(0xBEEF)];
        for (uint256 i; i < pks.length; ++i) {
            bytes memory sig = _sig(pks[i], address(vault), payoutAddr, 0);
            vm.expectRevert(X402Vault.InvalidSignature.selector);
            vault.changePayout(payoutAddr, sig);
        }
    }

    function test_changePayout_operatorOrOwnerKeysCannotChangePayout() public {
        // Authority is the merchant only, regardless of who relays or who signs.
        (address someOperator, uint256 opPk) = makeAddrAndKey("opkey");
        vm.prank(owner);
        factory.setOperator(someOperator);
        bytes memory sig = _sig(opPk, address(vault), payoutAddr, 0);
        vm.prank(someOperator);
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, sig);
    }

    function test_changePayout_badSignatureLengths() public {
        uint256[7] memory lens = [uint256(0), 1, 32, 63, 66, 96, 130];
        for (uint256 i; i < lens.length; ++i) {
            vm.expectRevert(X402Vault.InvalidSignature.selector);
            vault.changePayout(payoutAddr, new bytes(lens[i]));
        }
    }

    function test_changePayout_allZeroSignatureReverts() public {
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, new bytes(65));
    }

    function test_changePayout_invalidVValuesRevert() public {
        (, bytes32 r, bytes32 s) = _rsv(
            merchantPk,
            address(vault),
            payoutAddr,
            0
        );
        uint8[4] memory vs = [uint8(0), 1, 26, 29];
        for (uint256 i; i < vs.length; ++i) {
            vm.expectRevert(X402Vault.InvalidSignature.selector);
            vault.changePayout(payoutAddr, abi.encodePacked(r, s, vs[i]));
        }
    }

    function test_changePayout_signatureOverUnrelatedDigestReverts() public {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            merchantPk,
            keccak256("not the typed data")
        );
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, abi.encodePacked(r, s, v));
    }

    function test_changePayout_rawEthSignedMessageIsNotAccepted() public {
        // Signing the bare struct hash (no EIP-712 envelope) must not authorize anything.
        bytes32 structHash = keccak256(
            abi.encode(CHANGE_PAYOUT_TYPEHASH, payoutAddr, uint256(0))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(merchantPk, structHash);
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, abi.encodePacked(r, s, v));
    }

    function test_changePayout_failedAttemptDoesNotBumpNonceOrPayout() public {
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, new bytes(65));
        assertEq(vault.nonce(), 0);
        assertEq(vault.payout(), merchant);
    }

    function test_changePayout_malleableTwinCannotBeUsedToReplay() public {
        bytes memory sig = _sig(merchantPk, address(vault), payoutAddr, 0);
        bytes memory twin = _flip(sig);
        // (r, n-s, v^1) recovers the same signer; it is harmless because the nonce is consumed.
        vault.changePayout(payoutAddr, twin);
        assertEq(vault.nonce(), 1);

        vm.expectRevert(X402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, sig);
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, twin);
    }

    function test_changePayout_nonceOverflowPanics() public {
        // Force nonce to uint96 max (slot 0: nonce in the high 96 bits, payout in the low 160).
        vm.store(
            address(vault),
            bytes32(0),
            bytes32(uint256(type(uint96).max) << 160)
        );
        assertEq(vault.nonce(), type(uint96).max);
        assertEq(
            vault.payout(),
            merchant,
            "payout slot empty -> still merchant"
        );

        bytes memory sig = _sig(
            merchantPk,
            address(vault),
            payoutAddr,
            type(uint96).max
        );
        vm.expectRevert(stdError.arithmeticError);
        vault.changePayout(payoutAddr, sig);
    }

    // ============================================================ changePayout: ERC-1271 merchants

    function _walletVault() internal returns (Mock1271Wallet w, X402Vault v) {
        w = new Mock1271Wallet();
        v = X402Vault(_deploy(address(w), address(w)));
    }

    function test_erc1271_validSignature() public {
        (Mock1271Wallet w, X402Vault v) = _walletVault();
        w.approve(_digest(address(v), payoutAddr, 0));
        v.changePayout(payoutAddr, hex"1234");
        assertEq(v.payout(), payoutAddr);
        assertEq(v.nonce(), 1);
    }

    function test_erc1271_acceptsOpaque65ByteBlob() public {
        (Mock1271Wallet w, X402Vault v) = _walletVault();
        w.approve(_digest(address(v), payoutAddr, 0));
        v.changePayout(payoutAddr, new bytes(65));
        assertEq(v.payout(), payoutAddr);
    }

    function test_erc1271_wrongHashReverts() public {
        (Mock1271Wallet w, X402Vault v) = _walletVault();
        w.approve(_digest(address(v), payoutAddr, 0));
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        v.changePayout(stranger, hex"1234");
    }

    function test_erc1271_replayBlockedByNonce() public {
        (Mock1271Wallet w, X402Vault v) = _walletVault();
        w.approve(_digest(address(v), payoutAddr, 0));
        v.changePayout(payoutAddr, hex"1234");
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        v.changePayout(payoutAddr, hex"1234");
    }

    function test_erc1271_wrongMagicReverts() public {
        (Mock1271Wallet w, X402Vault v) = _walletVault();
        w.approve(_digest(address(v), payoutAddr, 0));
        w.setMagic(0xdeadbeef);
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        v.changePayout(payoutAddr, hex"1234");
    }

    function test_erc1271_revertingWalletReverts() public {
        Reverting1271Wallet w = new Reverting1271Wallet();
        X402Vault v = X402Vault(_deploy(address(w), address(w)));
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        v.changePayout(payoutAddr, hex"1234");
    }

    function test_erc1271_eoaSignatureDoesNotBypassContractMerchant() public {
        (Mock1271Wallet w, X402Vault v) = _walletVault();
        bytes memory sig = _sig(merchantPk, address(v), payoutAddr, 0); // some EOA signs; wallet never approved
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        v.changePayout(payoutAddr, sig);
        w; // silence
    }

    // ============================================================ withdrawAll: auth & validation

    function test_withdrawAll_onlyOperator() public {
        address[5] memory callers = [
            stranger,
            owner,
            merchant,
            customMerchant,
            payoutAddr
        ];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(X402Vault.Unauthorized.selector);
            vault.withdrawAll(
                new address[](0),
                new uint256[](0),
                new uint256[](0),
                feeRecipient
            );
        }
    }

    function test_withdrawAll_operatorRotationTakesEffectOnExistingVaults()
        public
    {
        address newOp = makeAddr("newOp");
        vm.prank(owner);
        factory.setOperator(newOp);

        vm.prank(operator);
        vm.expectRevert(X402Vault.Unauthorized.selector);
        vault.withdrawAll(
            new address[](0),
            new uint256[](0),
            new uint256[](0),
            feeRecipient
        );

        vm.prank(newOp);
        vault.withdrawAll(
            new address[](0),
            new uint256[](0),
            new uint256[](0),
            feeRecipient
        );
    }

    function test_withdrawAll_unsetOperatorBlocksEveryone() public {
        vm.prank(owner);
        factory.setOperator(address(0));
        address[3] memory callers = [operator, merchant, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(X402Vault.Unauthorized.selector);
            vault.withdrawAll(
                new address[](0),
                new uint256[](0),
                new uint256[](0),
                feeRecipient
            );
        }
    }

    function test_withdrawAll_zeroFeeRecipientReverts() public {
        vm.prank(operator);
        vm.expectRevert(X402Vault.InvalidAddress.selector);
        vault.withdrawAll(
            new address[](0),
            new uint256[](0),
            new uint256[](0),
            address(0)
        );
    }

    function test_withdrawAll_authCheckedBeforeFeeRecipient() public {
        vm.prank(stranger);
        vm.expectRevert(X402Vault.Unauthorized.selector);
        vault.withdrawAll(
            new address[](0),
            new uint256[](0),
            new uint256[](0),
            address(0)
        );
    }

    function test_withdrawAll_lengthMismatches() public {
        address[] memory t = _arr(address(token));
        uint256[] memory one = _arr(uint256(1));
        uint256[] memory two = new uint256[](2);
        uint256[] memory none = new uint256[](0);

        vm.startPrank(operator);
        vm.expectRevert(X402Vault.LengthMismatch.selector);
        vault.withdrawAll(t, two, one, feeRecipient); // merchant amounts longer
        vm.expectRevert(X402Vault.LengthMismatch.selector);
        vault.withdrawAll(t, one, two, feeRecipient); // fees longer
        vm.expectRevert(X402Vault.LengthMismatch.selector);
        vault.withdrawAll(t, none, one, feeRecipient);
        vm.expectRevert(X402Vault.LengthMismatch.selector);
        vault.withdrawAll(t, one, none, feeRecipient);
        vm.expectRevert(X402Vault.LengthMismatch.selector);
        vault.withdrawAll(new address[](0), one, one, feeRecipient);
        vm.stopPrank();
    }

    function test_withdrawAll_emptyArraysIsNoOp() public {
        token.mint(address(vault), 100);
        _withdraw(vault, new address[](0), new uint256[](0), new uint256[](0));
        assertEq(token.balanceOf(address(vault)), 100);
    }

    // ============================================================ withdrawAll: transfers

    function test_withdrawAll_splitsBetweenPayoutAndFeeRecipient() public {
        token.mint(address(vault), 1000);
        _withdraw(
            vault,
            _arr(address(token)),
            _arr(uint256(900)),
            _arr(uint256(100))
        );
        assertEq(token.balanceOf(merchant), 900, "default payout is merchant");
        assertEq(token.balanceOf(feeRecipient), 100);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function test_withdrawAll_usesCustomPayout() public {
        token.mint(address(customVault), 500);
        _withdraw(
            customVault,
            _arr(address(token)),
            _arr(uint256(400)),
            _arr(uint256(100))
        );
        assertEq(token.balanceOf(payoutAddr), 400);
        assertEq(token.balanceOf(customMerchant), 0);
        assertEq(token.balanceOf(feeRecipient), 100);
    }

    function test_withdrawAll_usesPayoutAfterChange() public {
        token.mint(address(vault), 100);
        _change(vault, merchantPk, payoutAddr);
        _withdraw(
            vault,
            _arr(address(token)),
            _arr(uint256(100)),
            _arr(uint256(0))
        );
        assertEq(token.balanceOf(payoutAddr), 100);
        assertEq(token.balanceOf(merchant), 0);
    }

    function test_withdrawAll_partialWithdrawalLeavesRemainder() public {
        token.mint(address(vault), 1000);
        _withdraw(
            vault,
            _arr(address(token)),
            _arr(uint256(300)),
            _arr(uint256(50))
        );
        assertEq(token.balanceOf(address(vault)), 650);
        assertEq(vault.tokenBalance(address(token)), 650);
    }

    function test_withdrawAll_zeroAmountsSkipTransferCalls() public {
        token.mint(address(vault), 100);
        vm.expectCall(
            address(token),
            abi.encodeWithSelector(token.transfer.selector),
            0
        );
        _withdraw(
            vault,
            _arr(address(token)),
            _arr(uint256(0)),
            _arr(uint256(0))
        );
        assertEq(token.balanceOf(address(vault)), 100);
    }

    function test_withdrawAll_onlyFeeOrOnlyMerchant() public {
        token.mint(address(vault), 100);
        _withdraw(
            vault,
            _arr(address(token)),
            _arr(uint256(0)),
            _arr(uint256(40))
        );
        assertEq(token.balanceOf(feeRecipient), 40);
        assertEq(token.balanceOf(merchant), 0);

        _withdraw(
            vault,
            _arr(address(token)),
            _arr(uint256(60)),
            _arr(uint256(0))
        );
        assertEq(token.balanceOf(merchant), 60);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function test_withdrawAll_multipleTokens() public {
        MockERC20 t2 = new MockERC20();
        NoReturnToken t3 = new NoReturnToken();
        token.mint(address(vault), 10);
        t2.mint(address(vault), 20);
        t3.mint(address(vault), 30);

        address[] memory t = new address[](3);
        t[0] = address(token);
        t[1] = address(t2);
        t[2] = address(t3);
        uint256[] memory m = new uint256[](3);
        m[0] = 8;
        m[1] = 15;
        m[2] = 25;
        uint256[] memory f = new uint256[](3);
        f[0] = 2;
        f[1] = 5;
        f[2] = 5;

        _withdraw(vault, t, m, f);

        assertEq(token.balanceOf(merchant), 8);
        assertEq(t2.balanceOf(merchant), 15);
        assertEq(t3.balanceOf(merchant), 25);
        assertEq(token.balanceOf(feeRecipient), 2);
        assertEq(t2.balanceOf(feeRecipient), 5);
        assertEq(t3.balanceOf(feeRecipient), 5);
    }

    function test_withdrawAll_sameTokenListedTwice() public {
        token.mint(address(vault), 100);
        address[] memory t = new address[](2);
        t[0] = address(token);
        t[1] = address(token);
        uint256[] memory m = new uint256[](2);
        m[0] = 30;
        m[1] = 30;
        uint256[] memory f = new uint256[](2);
        f[0] = 10;
        f[1] = 10;
        _withdraw(vault, t, m, f);
        assertEq(token.balanceOf(merchant), 60);
        assertEq(token.balanceOf(feeRecipient), 20);
        assertEq(token.balanceOf(address(vault)), 20);
    }

    function test_withdrawAll_feeRecipientEqualToPayout() public {
        token.mint(address(vault), 100);
        vm.prank(operator);
        vault.withdrawAll(
            _arr(address(token)),
            _arr(uint256(60)),
            _arr(uint256(40)),
            merchant
        );
        assertEq(token.balanceOf(merchant), 100);
    }

    function test_withdrawAll_feeRecipientCanBeTheVaultItself() public {
        token.mint(address(vault), 100);
        vm.prank(operator);
        vault.withdrawAll(
            _arr(address(token)),
            _arr(uint256(60)),
            _arr(uint256(40)),
            address(vault)
        );
        assertEq(token.balanceOf(merchant), 60);
        assertEq(token.balanceOf(address(vault)), 40);
    }

    function test_withdrawAll_entireBalanceAtUint256Max() public {
        token.mint(address(vault), type(uint256).max);
        _withdraw(
            vault,
            _arr(address(token)),
            _arr(type(uint256).max),
            _arr(uint256(0))
        );
        assertEq(token.balanceOf(merchant), type(uint256).max);
    }

    // ---- token quirks

    function test_withdrawAll_noReturnTokenWorks() public {
        NoReturnToken usdt = new NoReturnToken();
        usdt.mint(address(vault), 100);
        _withdraw(
            vault,
            _arr(address(usdt)),
            _arr(uint256(70)),
            _arr(uint256(30))
        );
        assertEq(usdt.balanceOf(merchant), 70);
        assertEq(usdt.balanceOf(feeRecipient), 30);
    }

    function test_withdrawAll_falseReturningTokenReverts() public {
        address bad = address(new FalseReturnToken());
        vm.prank(operator);
        vm.expectRevert(SafeTransferLib.TransferFailed.selector);
        vault.withdrawAll(
            _arr(bad),
            _arr(uint256(1)),
            _arr(uint256(0)),
            feeRecipient
        );
    }

    function test_withdrawAll_revertingTokenReverts() public {
        address bad = address(new RevertingToken());
        vm.prank(operator);
        vm.expectRevert(SafeTransferLib.TransferFailed.selector);
        vault.withdrawAll(
            _arr(bad),
            _arr(uint256(1)),
            _arr(uint256(0)),
            feeRecipient
        );
    }

    function test_withdrawAll_insufficientBalanceReverts() public {
        token.mint(address(vault), 99);
        vm.prank(operator);
        vm.expectRevert(SafeTransferLib.TransferFailed.selector);
        vault.withdrawAll(
            _arr(address(token)),
            _arr(uint256(100)),
            _arr(uint256(0)),
            feeRecipient
        );
    }

    function test_withdrawAll_feeLegFailureRollsBackMerchantLeg() public {
        token.mint(address(vault), 100);
        // each leg alone fits, together they exceed the balance
        vm.prank(operator);
        vm.expectRevert(SafeTransferLib.TransferFailed.selector);
        vault.withdrawAll(
            _arr(address(token)),
            _arr(uint256(60)),
            _arr(uint256(60)),
            feeRecipient
        );
        assertEq(token.balanceOf(merchant), 0, "merchant leg rolled back");
        assertEq(token.balanceOf(address(vault)), 100);
    }

    function test_withdrawAll_secondTokenFailureRollsBackFirst() public {
        token.mint(address(vault), 100);
        address[] memory t = new address[](2);
        t[0] = address(token);
        t[1] = address(new RevertingToken());
        uint256[] memory m = new uint256[](2);
        m[0] = 50;
        m[1] = 1;
        uint256[] memory f = new uint256[](2);

        vm.prank(operator);
        vm.expectRevert(SafeTransferLib.TransferFailed.selector);
        vault.withdrawAll(t, m, f, feeRecipient);
        assertEq(token.balanceOf(merchant), 0);
        assertEq(token.balanceOf(address(vault)), 100);
    }

    function test_withdrawAll_tokenAddressWithoutCodeReverts() public {
        // Current Solady safeTransfer checks extcodesize (older releases silently succeeded).
        address notAToken = makeAddr("notAToken");
        vm.prank(operator);
        vm.expectRevert(SafeTransferLib.TransferFailed.selector);
        vault.withdrawAll(
            _arr(notAToken),
            _arr(uint256(1)),
            _arr(uint256(0)),
            feeRecipient
        );
    }

    function test_withdrawAll_reentrancyThroughTokenIsBlocked() public {
        ReentrantToken rt = new ReentrantToken();
        rt.mint(address(vault), 100);
        rt.arm(address(vault));
        vm.prank(operator);
        vm.expectRevert(SafeTransferLib.TransferFailed.selector);
        vault.withdrawAll(
            _arr(address(rt)),
            _arr(uint256(10)),
            _arr(uint256(0)),
            feeRecipient
        );
        assertEq(rt.balanceOf(address(vault)), 100);
    }

    function test_withdrawAll_vaultsDoNotShareFunds() public {
        token.mint(address(vault), 100);
        token.mint(address(customVault), 100);
        _withdraw(
            vault,
            _arr(address(token)),
            _arr(uint256(100)),
            _arr(uint256(0))
        );
        assertEq(token.balanceOf(address(customVault)), 100);
        assertEq(token.balanceOf(payoutAddr), 0);
    }

    // ============================================================ tokenBalance

    function test_tokenBalance_reflectsHoldings() public {
        assertEq(vault.tokenBalance(address(token)), 0);
        token.mint(address(vault), 123);
        assertEq(vault.tokenBalance(address(token)), 123);
    }

    function test_tokenBalance_zeroForNonContractOrNonToken() public {
        assertEq(vault.tokenBalance(makeAddr("eoa")), 0);
        assertEq(vault.tokenBalance(address(factory)), 0); // contract without balanceOf
        assertEq(vault.tokenBalance(address(new RevertingToken())), 0);
    }

    function test_tokenBalance_noReturnTokenBalance() public {
        NoReturnToken usdt = new NoReturnToken();
        usdt.mint(address(vault), 7);
        assertEq(vault.tokenBalance(address(usdt)), 7);
    }

    // ============================================================ funds are safe from payout changes

    function test_payoutChangeDoesNotMoveFunds() public {
        token.mint(address(vault), 100);
        _change(vault, merchantPk, payoutAddr);
        assertEq(token.balanceOf(address(vault)), 100);
        assertEq(token.balanceOf(payoutAddr), 0);
    }

    // ============================================================ fuzz

    function testFuzz_changePayout_validSignature(
        uint256 pk,
        address newPayout,
        bool compact
    ) public {
        pk = _boundPk(pk);
        vm.assume(newPayout != address(0));
        address m = vm.addr(pk);
        vm.assume(m != merchant && m != customMerchant);
        X402Vault v = X402Vault(_deploy(m, m));

        bytes memory sig = compact
            ? _compactSig(pk, address(v), newPayout, 0)
            : _sig(pk, address(v), newPayout, 0);
        vm.prank(stranger);
        v.changePayout(newPayout, sig);

        assertEq(v.payout(), newPayout);
        assertEq(v.nonce(), 1);
        assertEq(v.merchant(), m);
    }

    function testFuzz_changePayout_wrongSignerReverts(
        uint256 pk,
        uint256 otherPk,
        address newPayout
    ) public {
        pk = _boundPk(pk);
        otherPk = _boundPk(otherPk);
        vm.assume(pk != otherPk && newPayout != address(0));
        address m = vm.addr(pk);
        vm.assume(m != merchant && m != customMerchant);
        X402Vault v = X402Vault(_deploy(m, m));

        bytes memory sig = _sig(otherPk, address(v), newPayout, 0);
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        v.changePayout(newPayout, sig);
        assertEq(v.nonce(), 0);
        assertEq(v.payout(), m);
    }

    function testFuzz_changePayout_signedPayoutMismatch(
        address signed,
        address submitted
    ) public {
        vm.assume(signed != submitted && submitted != address(0));
        bytes memory sig = _sig(merchantPk, address(vault), signed, 0);
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        vault.changePayout(submitted, sig);
    }

    function testFuzz_changePayout_wrongNonceReverts(
        uint96 signedNonce,
        address newPayout
    ) public {
        vm.assume(newPayout != address(0) && signedNonce != 0);
        bytes memory sig = _sig(
            merchantPk,
            address(vault),
            newPayout,
            signedNonce
        );
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        vault.changePayout(newPayout, sig);
    }

    function testFuzz_changePayout_sequence(uint8 count, uint256 seed) public {
        uint256 n = bound(count, 1, 12);
        address last;
        for (uint256 i; i < n; ++i) {
            last = address(
                uint160(uint256(keccak256(abi.encode(seed, i))) | 1)
            );
            _change(vault, merchantPk, last);
            assertEq(vault.nonce(), i + 1);
        }
        assertEq(vault.payout(), last);
        // none of the earlier signatures can be replayed
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        vault.changePayout(last, _sig(merchantPk, address(vault), last, n - 1));
    }

    function testFuzz_changePayout_garbageSignatureNeverAuthorizes(
        bytes calldata garbage,
        address newPayout
    ) public {
        vm.assume(newPayout != address(0));
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        vault.changePayout(newPayout, garbage);
        assertEq(vault.nonce(), 0);
    }

    function testFuzz_changePayout_badLengthAlwaysReverts(
        uint256 len,
        address newPayout
    ) public {
        len = bound(len, 0, 300);
        vm.assume(len != 64 && len != 65 && newPayout != address(0));
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        vault.changePayout(newPayout, new bytes(len));
    }

    function testFuzz_changePayout_chainIdBinding(
        uint64 chainA,
        uint64 chainB,
        address newPayout
    ) public {
        vm.assume(
            chainA != 0 &&
                chainB != 0 &&
                chainA != chainB &&
                newPayout != address(0)
        );
        vm.chainId(chainA);
        bytes memory sig = _sig(merchantPk, address(vault), newPayout, 0);
        vm.chainId(chainB);
        vm.expectRevert(X402Vault.InvalidSignature.selector);
        vault.changePayout(newPayout, sig);
        vm.chainId(chainA);
        vault.changePayout(newPayout, sig);
        assertEq(vault.payout(), newPayout);
    }

    function testFuzz_changePayout_isolatedPerVault(
        uint256 pk,
        address newPayout
    ) public {
        pk = _boundPk(pk);
        vm.assume(newPayout != address(0));
        address m = vm.addr(pk);
        vm.assume(m != merchant && m != customMerchant);
        X402Vault v1 = X402Vault(_deploy(m, m));
        // changing v1 must never touch the other fixtures
        v1.changePayout(newPayout, _sig(pk, address(v1), newPayout, 0));
        assertEq(vault.payout(), merchant);
        assertEq(vault.nonce(), 0);
        assertEq(customVault.payout(), payoutAddr);
        assertEq(customVault.nonce(), 0);
    }

    function testFuzz_nonceAndPayoutPackingNeverCorrupt(
        uint96 nonceSeed,
        address p
    ) public {
        vm.assume(p != address(0));
        nonceSeed = uint96(bound(nonceSeed, 0, type(uint96).max - 1));
        vm.store(
            address(vault),
            bytes32(0),
            bytes32((uint256(nonceSeed) << 160) | uint256(uint160(p)))
        );
        assertEq(vault.nonce(), nonceSeed);
        assertEq(vault.payout(), p);

        address np = makeAddr("np");
        vault.changePayout(np, _sig(merchantPk, address(vault), np, nonceSeed));
        assertEq(vault.nonce(), uint256(nonceSeed) + 1);
        assertEq(vault.payout(), np);
    }

    function testFuzz_initPayout_onlyFactory(address caller, address p) public {
        vm.assume(caller != address(factory));
        vm.prank(caller);
        vm.expectRevert(X402Vault.Unauthorized.selector);
        vault.initPayout(p);
    }

    function testFuzz_withdrawAll_onlyOperator(address caller) public {
        vm.assume(caller != operator);
        vm.prank(caller);
        vm.expectRevert(X402Vault.Unauthorized.selector);
        vault.withdrawAll(
            new address[](0),
            new uint256[](0),
            new uint256[](0),
            feeRecipient
        );
    }

    function testFuzz_withdrawAll_conservesTokens(
        uint128 balance,
        uint8 n,
        uint256 seed
    ) public {
        uint256 len = bound(n, 0, 8);
        token.mint(address(vault), balance);

        address[] memory t = new address[](len);
        uint256[] memory m = new uint256[](len);
        uint256[] memory f = new uint256[](len);
        uint256 remaining = balance;
        uint256 sumM;
        uint256 sumF;
        for (uint256 i; i < len; ++i) {
            t[i] = address(token);
            m[i] =
                uint256(keccak256(abi.encode(seed, i, uint8(0)))) %
                (remaining + 1);
            remaining -= m[i];
            f[i] =
                uint256(keccak256(abi.encode(seed, i, uint8(1)))) %
                (remaining + 1);
            remaining -= f[i];
            sumM += m[i];
            sumF += f[i];
        }

        _withdraw(vault, t, m, f);

        assertEq(token.balanceOf(merchant), sumM);
        assertEq(token.balanceOf(feeRecipient), sumF);
        assertEq(token.balanceOf(address(vault)), remaining);
        assertEq(
            token.balanceOf(merchant) +
                token.balanceOf(feeRecipient) +
                token.balanceOf(address(vault)),
            balance
        );
    }

    function testFuzz_withdrawAll_payoutDestination(
        address p,
        uint128 amount,
        uint128 fee
    ) public {
        vm.assume(
            p != address(0) && p != address(customVault) && p != feeRecipient
        );
        uint256 total = uint256(amount) + uint256(fee);
        address cm = makeAddr("fuzzMerchant");
        X402Vault v = X402Vault(_deploy(cm, p));
        token.mint(address(v), total);
        uint256 before = token.balanceOf(p);

        _withdraw(
            v,
            _arr(address(token)),
            _arr(uint256(amount)),
            _arr(uint256(fee))
        );

        if (p == address(v)) {
            assertEq(token.balanceOf(p), total - fee); // payout is the vault itself: only the fee left
        } else {
            assertEq(token.balanceOf(p), before + amount);
        }
        assertEq(token.balanceOf(feeRecipient), fee);
    }

    function testFuzz_withdrawAll_overdrawReverts(
        uint128 balance,
        uint128 extra
    ) public {
        extra = uint128(bound(extra, 1, type(uint128).max));
        token.mint(address(vault), balance);
        vm.prank(operator);
        vm.expectRevert(SafeTransferLib.TransferFailed.selector);
        vault.withdrawAll(
            _arr(address(token)),
            _arr(uint256(balance) + extra),
            _arr(uint256(0)),
            feeRecipient
        );
        assertEq(token.balanceOf(address(vault)), balance);
    }

    function testFuzz_withdrawAll_lengthMismatchReverts(
        uint8 a,
        uint8 b,
        uint8 c
    ) public {
        uint256 la = bound(a, 0, 6);
        uint256 lb = bound(b, 0, 6);
        uint256 lc = bound(c, 0, 6);
        vm.assume(!(la == lb && lb == lc));
        vm.prank(operator);
        vm.expectRevert(X402Vault.LengthMismatch.selector);
        vault.withdrawAll(
            new address[](la),
            new uint256[](lb),
            new uint256[](lc),
            feeRecipient
        );
    }

    function testFuzz_withdrawAll_zeroFeeRecipientAlwaysReverts(
        uint8 len
    ) public {
        uint256 l = bound(len, 0, 5);
        vm.prank(operator);
        vm.expectRevert(X402Vault.InvalidAddress.selector);
        vault.withdrawAll(
            new address[](l),
            new uint256[](l),
            new uint256[](l),
            address(0)
        );
    }

    function testFuzz_tokenBalance(uint128 amount) public {
        token.mint(address(vault), amount);
        assertEq(vault.tokenBalance(address(token)), amount);
    }
}

/// @dev Minimal second factory used to prove cross-factory signature isolation.
contract X402VaultFactoryLike {
    X402VaultFactory internal f;

    constructor() {
        f = new X402VaultFactory(address(this));
        f.setOperator(address(this));
    }

    function make(address merchant) external returns (address) {
        return f.createVault(merchant, merchant);
    }
}
