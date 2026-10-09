// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {stdError} from "forge-std/StdError.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {X402Base} from "./utils/X402Base.sol";
import {X402Vault} from "../src/X402Vault.sol";
import {X402VaultFactory} from "../src/X402VaultFactory.sol";
import {IX402Vault} from "../src/interfaces/IX402Vault.sol";
import {
    MockERC20,
    FalsePayoutToken,
    RevertingPayoutToken,
    FeeOnTransferToken,
    LowDecimalToken,
    ReentrantToken,
    MockPermit2,
    Mock1271Wallet,
    Reverting1271Wallet
} from "./utils/Mocks.sol";

contract X402VaultTest is X402Base {
    /// @dev Mirrors the vault's own events so `vm.expectEmit` can match them exactly.
    event PayoutChanged(address indexed merchant, address indexed newPayout);
    event Settle(
        address indexed payout, address indexed token, address indexed payer, uint256 merchantAmount, uint256 feeAmount
    );

    X402Vault internal vault; // payout == merchant (no storage written)
    X402Vault internal customVault; // payout override set at creation

    uint256 internal customPk;
    address internal customMerchant;
    address internal payoutAddr;

    /// @dev 10 bps: the fee used by most settlement tests.
    uint16 internal constant BPS = 10;

    function setUp() public override {
        super.setUp();
        payoutAddr = makeAddr("payout");
        customPk = 0xB0B;
        customMerchant = vm.addr(customPk);

        vault = X402Vault(_deploy(merchant, merchant));
        customVault = X402Vault(_deploy(customMerchant, payoutAddr));
    }

    // -------------------------------------------------------------- local helpers

    /// @dev A payout change is authorised by the vault's *merchant*, not its payout address.
    function _change(X402Vault v, uint256 pk, address newPayout) internal {
        uint256 dl = _deadline();
        v.changePayout(newPayout, dl, _sig(pk, address(v), newPayout, v.nonce(), dl));
    }

    /// @dev Allowlists `t` in the factory at `bps`. A vault refuses to settle anything the factory
    /// has not configured, so nearly every settlement test starts here.
    function _configure(MockERC20 t, uint16 bps) internal {
        address[] memory tokens = new address[](1);
        tokens[0] = address(t);
        uint16[] memory bpsList = new uint16[](1);
        bpsList[0] = bps;

        vm.prank(owner);
        factory.setTokenFees(tokens, bpsList);
    }

    /// @dev The fee the factory charges for `t`, in `t`'s own units.
    function _fee(MockERC20 t) internal view returns (uint256) {
        return factory.tokenFee(address(t));
    }

    /// @dev Relays an EIP-3009 settlement from an unrelated account — `settle` is permissionless,
    /// and every test should prove it rather than accidentally relying on one caller.
    function _pay(uint256 pk, X402Vault v, MockERC20 t, uint256 value, bytes32 authNonce) internal {
        vm.prank(stranger);
        v.settle(address(t), _auth3009(pk, address(t), address(v), value, authNonce));
    }

    /// @dev As {_pay}, for the Permit2 path. `pk` must have approved Permit2 for `t`.
    function _payWithPermit2(uint256 pk, X402Vault v, MockERC20 t, uint256 value, uint256 permitNonce) internal {
        (IX402Vault.Permit2Authorization memory auth, bytes memory signature) =
            _permit2Auth(pk, SafeTransferLib.PERMIT2, address(v), address(t), value, permitNonce);

        vm.prank(stranger);
        v.settleWithPermit2(address(t), auth, signature);
    }

    function _flip(bytes memory sig65) internal pure returns (bytes memory out) {
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
        assertEq(vm.load(address(vault), bytes32(0)), bytes32((uint256(1) << 160) | uint256(uint160(np))));
    }

    // ---- initPayout: factory-gated and strictly one-shot

    function test_initPayout_onlyFactory() public {
        address[4] memory callers = [stranger, operator, owner, merchant];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(IX402Vault.Unauthorized.selector);
            vault.initPayout(payoutAddr);
        }
        vm.prank(address(factory));
        vault.initPayout(payoutAddr);
        assertEq(vault.payout(), payoutAddr);
    }

    function test_initPayout_isOneShot() public {
        vm.prank(address(factory));
        vault.initPayout(payoutAddr);
        assertEq(vault.payout(), payoutAddr);

        // A second call — even by the factory, even to the same address — is refused.
        vm.prank(address(factory));
        vm.expectRevert(IX402Vault.AlreadyInitialized.selector);
        vault.initPayout(stranger);
        assertEq(vault.payout(), payoutAddr, "payout unchanged by the rejected call");
    }

    function test_initPayout_revertsOncePayoutIsSetViaChangePayout() public {
        // A payout change writes the same slot, so it also closes the initialiser.
        _change(vault, merchantPk, payoutAddr);
        vm.prank(address(factory));
        vm.expectRevert(IX402Vault.AlreadyInitialized.selector);
        vault.initPayout(stranger);
        assertEq(vault.payout(), payoutAddr);
    }

    function test_initPayout_rejectsZeroAddress() public {
        // Zero must be refused: the one-shot guard keys off the slot being non-zero, so
        // accepting zero would leave the vault re-initialisable.
        vm.prank(address(factory));
        vm.expectRevert(IX402Vault.InvalidAddress.selector);
        vault.initPayout(address(0));
        assertEq(vault.payout(), merchant, "still the fallback");

        // and the slot is still open, so a genuine initialisation still works
        vm.prank(address(factory));
        vault.initPayout(payoutAddr);
        assertEq(vault.payout(), payoutAddr);
    }

    function test_initPayout_zeroCheckRunsBeforeOneShotGuard() public {
        vm.prank(address(factory));
        vault.initPayout(payoutAddr);
        vm.prank(address(factory));
        vm.expectRevert(IX402Vault.InvalidAddress.selector); // zero wins, not AlreadyInitialized
        vault.initPayout(address(0));
    }

    function test_implementation_isNotUsableAsVaultForOthers() public {
        // The implementation itself can only be poked by the factory.
        X402Vault impl = X402Vault(factory.implementation());
        vm.expectRevert(IX402Vault.Unauthorized.selector);
        impl.initPayout(payoutAddr);
    }

    // ============================================================ EIP-712 domain

    function test_eip712Domain_reportsVaultAsVerifyingContract() public view {
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = vault.eip712Domain();
        assertEq(name, "X402Vault");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifying, address(vault));
    }

    function test_domain_signatureNotValidOnOtherVault() public {
        uint256 dl = _deadline();
        bytes memory sig = _sig(merchantPk, address(vault), payoutAddr, 0, dl);
        // same merchant key, but customVault belongs to another merchant AND has another domain
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        customVault.changePayout(payoutAddr, dl, sig);
    }

    function test_domain_sameMerchantSignatureCannotCrossFactories() public {
        // A second factory/vault for the same merchant has a different address -> different domain.
        X402VaultFactoryLike f2 = new X402VaultFactoryLike();
        address v2 = f2.make(merchant);
        uint256 dl = _deadline();
        bytes memory sig = _sig(merchantPk, address(vault), payoutAddr, 0, dl);
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        X402Vault(v2).changePayout(payoutAddr, dl, sig);
    }

    function test_domain_chainIdChangeInvalidatesOldSignatureAndAcceptsNew() public {
        uint256 dl = _deadline();
        bytes memory oldSig = _sig(merchantPk, address(vault), payoutAddr, 0, dl);
        vm.chainId(block.chainid + 1);

        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, dl, oldSig);

        bytes memory newSig = _sig(merchantPk, address(vault), payoutAddr, 0, dl);
        vault.changePayout(payoutAddr, dl, newSig);
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
        uint256 dl = _deadline();
        bytes memory sig = _sig(merchantPk, address(vault), payoutAddr, 0, dl);
        vm.prank(stranger);
        vault.changePayout(payoutAddr, dl, sig);
        assertEq(vault.payout(), payoutAddr);
    }

    function test_changePayout_sequentialChangesUseIncreasingNonces() public {
        for (uint256 i; i < 5; ++i) {
            address np = makeAddr(string(abi.encodePacked("np", vm.toString(i))));
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
        uint256 dl = _deadline();
        bytes memory sig = _compactSig(merchantPk, address(vault), payoutAddr, 0, dl);
        assertEq(sig.length, 64);
        vault.changePayout(payoutAddr, dl, sig);
        assertEq(vault.payout(), payoutAddr);
    }

    function test_changePayout_emitsPayoutChanged() public {
        uint256 dl = _deadline();
        bytes memory sig = _sig(merchantPk, address(vault), payoutAddr, 0, dl);

        vm.expectEmit(true, true, false, true, address(vault));
        emit PayoutChanged(merchant, payoutAddr);
        vault.changePayout(payoutAddr, dl, sig);
    }

    // ---- authority stays with the merchant, and only the merchant

    function test_changePayout_merchantKeepsAuthorityAfterPayoutMoves() public {
        _change(vault, merchantPk, payoutAddr);
        // The payout address is not the authority; the merchant still is.
        _change(vault, merchantPk, stranger);
        assertEq(vault.payout(), stranger);
        assertEq(vault.nonce(), 2);
    }

    function test_changePayout_payoutAddressKeyCannotAuthorize() public {
        // payoutAddr is only a destination. Even after it becomes the payout, a signature
        // made with a key that happens to control it does not authorise anything.
        _change(vault, merchantPk, payoutAddr);
        uint256 fakePk = 0xF00D;
        address fakeSigner = vm.addr(fakePk);
        uint256 dl = _deadline();
        bytes memory sig = _sig(fakePk, address(vault), stranger, 1, dl);

        vm.prank(fakeSigner);
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(stranger, dl, sig);
        assertEq(vault.payout(), payoutAddr);
        assertEq(vault.nonce(), 1);
    }

    function test_changePayout_operatorCannotAuthorizeEvenWhenItSigns() public {
        // The operator is trusted to move funds, but it can never redirect where they go.
        (address opWithKey, uint256 opPk) = makeAddrAndKey("opWithKey");
        vm.prank(owner);
        factory.setOperator(opWithKey);

        uint256 dl = _deadline();
        bytes memory sig = _sig(opPk, address(vault), payoutAddr, 0, dl);
        vm.prank(opWithKey);
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, dl, sig);
    }

    // ---- deadline

    function test_changePayout_expiredDeadlineReverts() public {
        uint256 dl = block.timestamp - 1;
        bytes memory sig = _sig(merchantPk, address(vault), payoutAddr, 0, dl);
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, dl, sig);
        assertEq(vault.nonce(), 0);
    }

    function test_changePayout_deadlineBoundaryIsInclusive() public {
        uint256 dl = block.timestamp;
        bytes memory sig = _sig(merchantPk, address(vault), payoutAddr, 0, dl);
        vault.changePayout(payoutAddr, dl, sig); // `>` not `>=`, so now is still valid
        assertEq(vault.payout(), payoutAddr);
    }

    function test_changePayout_zeroDeadlineAlwaysReverts() public {
        bytes memory sig = _sig(merchantPk, address(vault), payoutAddr, 0, 0);
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, 0, sig);
    }

    function test_changePayout_expiryBurnsTheSignature() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _sig(merchantPk, address(vault), payoutAddr, 0, dl);
        vm.warp(dl + 1);

        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, dl, sig);

        // The nonce was never consumed, so the merchant can re-sign and proceed.
        uint256 dl2 = block.timestamp + 1 hours;
        vault.changePayout(payoutAddr, dl2, _sig(merchantPk, address(vault), payoutAddr, 0, dl2));
        assertEq(vault.payout(), payoutAddr);
    }

    function test_changePayout_signedDeadlineMustMatchSubmitted() public {
        uint256 dl = _deadline();
        bytes memory sig = _sig(merchantPk, address(vault), payoutAddr, 0, dl);
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, dl + 1, sig);
    }

    // ============================================================ changePayout: failures

    function test_changePayout_revertsOnZeroPayout() public {
        uint256 dl = _deadline();
        bytes memory sig = _sig(merchantPk, address(vault), address(0), 0, dl);
        vm.expectRevert(IX402Vault.InvalidAddress.selector);
        vault.changePayout(address(0), dl, sig);
    }

    function test_changePayout_zeroCheckRunsBeforeSignatureCheck() public {
        vm.expectRevert(IX402Vault.InvalidAddress.selector);
        vault.changePayout(address(0), _deadline(), hex"");
    }

    function test_changePayout_replayReverts() public {
        uint256 dl = _deadline();
        bytes memory sig = _sig(merchantPk, address(vault), payoutAddr, 0, dl);
        vault.changePayout(payoutAddr, dl, sig);
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, dl, sig);
    }

    function test_changePayout_oldSignatureCannotRevertLaterChange() public {
        // The attack the nonce exists to stop: replay A, change to B, replay A's sig to undo B.
        address a = makeAddr("A");
        address b = makeAddr("B");
        uint256 dl = _deadline();
        bytes memory sigA = _sig(merchantPk, address(vault), a, 0, dl);
        vault.changePayout(a, dl, sigA);
        _change(vault, merchantPk, b);
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(a, dl, sigA);
        assertEq(vault.payout(), b);
    }

    function test_changePayout_futureNonceReverts() public {
        uint256 dl = _deadline();
        bytes memory sig = _sig(merchantPk, address(vault), payoutAddr, 1, dl);
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, dl, sig);
    }

    function test_changePayout_signedPayoutMismatchReverts() public {
        uint256 dl = _deadline();
        bytes memory sig = _sig(merchantPk, address(vault), payoutAddr, 0, dl);
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(stranger, dl, sig);
    }

    function test_changePayout_wrongSignerReverts() public {
        uint256 dl = _deadline();
        uint256[3] memory pks = [uint256(0xDEAD), customPk, uint256(0xBEEF)];
        for (uint256 i; i < pks.length; ++i) {
            bytes memory sig = _sig(pks[i], address(vault), payoutAddr, 0, dl);
            vm.expectRevert(IX402Vault.InvalidSignature.selector);
            vault.changePayout(payoutAddr, dl, sig);
        }
    }

    function test_changePayout_operatorOrOwnerKeysCannotChangePayout() public {
        // Authority is the merchant only, regardless of who relays or who signs.
        (address someOperator, uint256 opPk) = makeAddrAndKey("opkey");
        vm.prank(owner);
        factory.setOperator(someOperator);
        uint256 dl = _deadline();
        bytes memory sig = _sig(opPk, address(vault), payoutAddr, 0, dl);
        vm.prank(someOperator);
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, dl, sig);
    }

    function test_changePayout_badSignatureLengths() public {
        uint256 dl = _deadline();
        uint256[7] memory lens = [uint256(0), 1, 32, 63, 66, 96, 130];
        for (uint256 i; i < lens.length; ++i) {
            vm.expectRevert(IX402Vault.InvalidSignature.selector);
            vault.changePayout(payoutAddr, dl, new bytes(lens[i]));
        }
    }

    function test_changePayout_allZeroSignatureReverts() public {
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, _deadline(), new bytes(65));
    }

    function test_changePayout_invalidVValuesRevert() public {
        uint256 dl = _deadline();
        (, bytes32 r, bytes32 s) = _rsv(merchantPk, address(vault), payoutAddr, 0, dl);
        uint8[4] memory vs = [uint8(0), 1, 26, 29];
        for (uint256 i; i < vs.length; ++i) {
            vm.expectRevert(IX402Vault.InvalidSignature.selector);
            vault.changePayout(payoutAddr, dl, abi.encodePacked(r, s, vs[i]));
        }
    }

    function test_changePayout_signatureOverUnrelatedDigestReverts() public {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(merchantPk, keccak256("not the typed data"));
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, _deadline(), abi.encodePacked(r, s, v));
    }

    function test_changePayout_rawEthSignedMessageIsNotAccepted() public {
        // Signing the bare struct hash (no EIP-712 envelope) must not authorize anything.
        uint256 dl = _deadline();
        bytes32 structHash = keccak256(abi.encode(CHANGE_PAYOUT_TYPEHASH, payoutAddr, uint256(0), dl));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(merchantPk, structHash);
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, dl, abi.encodePacked(r, s, v));
    }

    function test_changePayout_failedAttemptDoesNotBumpNonceOrPayout() public {
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, _deadline(), new bytes(65));
        assertEq(vault.nonce(), 0);
        assertEq(vault.payout(), merchant);
    }

    function test_changePayout_malleableTwinNeutralisedByNonce() public {
        uint256 dl = _deadline();
        bytes memory sig = _sig(merchantPk, address(vault), payoutAddr, 0, dl);
        bytes memory twin = _flip(sig);
        // Solady does not enforce low-s, so (r, n-s, v^1) IS accepted. It is harmless only
        // because the nonce is consumed by whichever variant lands first — a signature is
        // therefore not a unique identifier.
        vault.changePayout(payoutAddr, dl, twin);
        assertEq(vault.nonce(), 1);

        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, dl, sig);
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(payoutAddr, dl, twin);
    }

    function test_changePayout_nonceOverflowPanics() public {
        // Force nonce to uint96 max (slot 0: nonce in the high 96 bits, payout in the low 160).
        vm.store(address(vault), bytes32(0), bytes32(uint256(type(uint96).max) << 160));
        assertEq(vault.nonce(), type(uint96).max);
        assertEq(vault.payout(), merchant, "payout slot empty -> still merchant");

        uint256 dl = _deadline();
        bytes memory sig = _sig(merchantPk, address(vault), payoutAddr, type(uint96).max, dl);
        vm.expectRevert(stdError.arithmeticError);
        vault.changePayout(payoutAddr, dl, sig);
    }

    // ============================================================ changePayout: ERC-1271 merchants

    function _walletVault() internal returns (Mock1271Wallet w, X402Vault v) {
        w = new Mock1271Wallet();
        v = X402Vault(_deploy(address(w), address(w)));
    }

    function test_erc1271_validSignature() public {
        (Mock1271Wallet w, X402Vault v) = _walletVault();
        uint256 dl = _deadline();
        w.approve(_digest(address(v), payoutAddr, 0, dl));
        v.changePayout(payoutAddr, dl, hex"1234");
        assertEq(v.payout(), payoutAddr);
        assertEq(v.nonce(), 1);
    }

    function test_erc1271_acceptsOpaque65ByteBlob() public {
        (Mock1271Wallet w, X402Vault v) = _walletVault();
        uint256 dl = _deadline();
        w.approve(_digest(address(v), payoutAddr, 0, dl));
        v.changePayout(payoutAddr, dl, new bytes(65));
        assertEq(v.payout(), payoutAddr);
    }

    function test_erc1271_wrongHashReverts() public {
        (Mock1271Wallet w, X402Vault v) = _walletVault();
        uint256 dl = _deadline();
        w.approve(_digest(address(v), payoutAddr, 0, dl));
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        v.changePayout(stranger, dl, hex"1234");
    }

    function test_erc1271_replayBlockedByNonce() public {
        (Mock1271Wallet w, X402Vault v) = _walletVault();
        uint256 dl = _deadline();
        w.approve(_digest(address(v), payoutAddr, 0, dl));
        v.changePayout(payoutAddr, dl, hex"1234");
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        v.changePayout(payoutAddr, dl, hex"1234");
    }

    function test_erc1271_wrongMagicReverts() public {
        (Mock1271Wallet w, X402Vault v) = _walletVault();
        uint256 dl = _deadline();
        w.approve(_digest(address(v), payoutAddr, 0, dl));
        w.setMagic(0xdeadbeef);
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        v.changePayout(payoutAddr, dl, hex"1234");
    }

    function test_erc1271_revertingWalletReverts() public {
        Reverting1271Wallet w = new Reverting1271Wallet();
        X402Vault v = X402Vault(_deploy(address(w), address(w)));
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        v.changePayout(payoutAddr, _deadline(), hex"1234");
    }

    function test_erc1271_eoaSignatureDoesNotBypassContractMerchant() public {
        (Mock1271Wallet w, X402Vault v) = _walletVault();
        uint256 dl = _deadline();
        bytes memory sig = _sig(merchantPk, address(v), payoutAddr, 0, dl); // some EOA signs; wallet never approved
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        v.changePayout(payoutAddr, dl, sig);
        w; // silence
    }

    // ============================================================ funds are safe from payout changes

    function test_payoutChangeDoesNotMoveFunds() public {
        token.mint(address(vault), 100);
        _change(vault, merchantPk, payoutAddr);
        assertEq(token.balanceOf(address(vault)), 100);
        assertEq(token.balanceOf(payoutAddr), 0);
    }

    // ============================================================ fuzz

    function testFuzz_changePayout_validSignature(uint256 pk, address newPayout, bool compact) public {
        pk = _boundPk(pk);
        vm.assume(newPayout != address(0));
        address m = vm.addr(pk);
        vm.assume(m != merchant && m != customMerchant);
        X402Vault v = X402Vault(_deploy(m, m));
        uint256 dl = _deadline();

        bytes memory sig =
            compact ? _compactSig(pk, address(v), newPayout, 0, dl) : _sig(pk, address(v), newPayout, 0, dl);
        vm.prank(stranger);
        v.changePayout(newPayout, dl, sig);

        assertEq(v.payout(), newPayout);
        assertEq(v.nonce(), 1);
        assertEq(v.merchant(), m);
    }

    function testFuzz_changePayout_wrongSignerReverts(uint256 pk, uint256 otherPk, address newPayout) public {
        pk = _boundPk(pk);
        otherPk = _boundPk(otherPk);
        vm.assume(pk != otherPk && newPayout != address(0));
        address m = vm.addr(pk);
        vm.assume(m != merchant && m != customMerchant);
        X402Vault v = X402Vault(_deploy(m, m));

        bytes memory sig = _sig(otherPk, address(v), newPayout, 0, _deadline());
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        v.changePayout(newPayout, _deadline(), sig);
        assertEq(v.nonce(), 0);
        assertEq(v.payout(), m);
    }

    function testFuzz_changePayout_signedPayoutMismatch(address signed, address submitted) public {
        vm.assume(signed != submitted && submitted != address(0));
        uint256 dl = _deadline();
        bytes memory sig = _sig(merchantPk, address(vault), signed, 0, dl);
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(submitted, dl, sig);
    }

    function testFuzz_changePayout_wrongNonceReverts(uint96 signedNonce, address newPayout) public {
        vm.assume(newPayout != address(0) && signedNonce != 0);
        uint256 dl = _deadline();
        bytes memory sig = _sig(merchantPk, address(vault), newPayout, signedNonce, dl);
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(newPayout, dl, sig);
    }

    function testFuzz_changePayout_sequence(uint8 count, uint256 seed) public {
        uint256 n = bound(count, 1, 12);
        address last;
        for (uint256 i; i < n; ++i) {
            last = address(uint160(uint256(keccak256(abi.encode(seed, i))) | 1));
            _change(vault, merchantPk, last);
            assertEq(vault.nonce(), i + 1);
        }
        assertEq(vault.payout(), last);
        // none of the earlier signatures can be replayed
        uint256 dl = _deadline();
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(last, dl, _sig(merchantPk, address(vault), last, n - 1, dl));
    }

    function testFuzz_changePayout_garbageSignatureNeverAuthorizes(bytes calldata garbage, address newPayout) public {
        vm.assume(newPayout != address(0));
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(newPayout, _deadline(), garbage);
        assertEq(vault.nonce(), 0);
    }

    function testFuzz_changePayout_badLengthAlwaysReverts(uint256 len, address newPayout) public {
        len = bound(len, 0, 300);
        vm.assume(len != 64 && len != 65 && newPayout != address(0));
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(newPayout, _deadline(), new bytes(len));
    }

    function testFuzz_changePayout_deadline(uint256 dlOffset, uint256 elapsed) public {
        vm.warp(1_000_000);
        uint256 dl = block.timestamp + bound(dlOffset, 0, 365 days);
        uint256 at = block.timestamp + bound(elapsed, 0, 730 days);

        address np = makeAddr("np");
        bytes memory sig = _sig(merchantPk, address(vault), np, 0, dl);
        vm.warp(at);

        if (at > dl) {
            vm.expectRevert(IX402Vault.InvalidSignature.selector);
            vault.changePayout(np, dl, sig);
            assertEq(vault.nonce(), 0);
        } else {
            vault.changePayout(np, dl, sig);
            assertEq(vault.payout(), np);
        }
    }

    function testFuzz_changePayout_chainIdBinding(uint64 chainA, uint64 chainB, address newPayout) public {
        vm.assume(chainA != 0 && chainB != 0 && chainA != chainB && newPayout != address(0));
        uint256 dl = _deadline();
        vm.chainId(chainA);
        bytes memory sig = _sig(merchantPk, address(vault), newPayout, 0, dl);
        vm.chainId(chainB);
        vm.expectRevert(IX402Vault.InvalidSignature.selector);
        vault.changePayout(newPayout, dl, sig);
        vm.chainId(chainA);
        vault.changePayout(newPayout, dl, sig);
        assertEq(vault.payout(), newPayout);
    }

    function testFuzz_changePayout_isolatedPerVault(uint256 pk, address newPayout) public {
        pk = _boundPk(pk);
        vm.assume(newPayout != address(0));
        address m = vm.addr(pk);
        vm.assume(m != merchant && m != customMerchant);
        X402Vault v1 = X402Vault(_deploy(m, m));
        uint256 dl = _deadline();
        // changing v1 must never touch the other fixtures
        v1.changePayout(newPayout, dl, _sig(pk, address(v1), newPayout, 0, dl));
        assertEq(vault.payout(), merchant);
        assertEq(vault.nonce(), 0);
        assertEq(customVault.payout(), payoutAddr);
        assertEq(customVault.nonce(), 0);
    }

    function testFuzz_nonceAndPayoutPackingNeverCorrupt(uint96 nonceSeed, address p) public {
        vm.assume(p != address(0));
        nonceSeed = uint96(bound(nonceSeed, 0, type(uint96).max - 1));
        vm.store(address(vault), bytes32(0), bytes32((uint256(nonceSeed) << 160) | uint256(uint160(p))));
        assertEq(vault.nonce(), nonceSeed);
        assertEq(vault.payout(), p);

        address np = makeAddr("np");
        uint256 dl = _deadline();
        vault.changePayout(np, dl, _sig(merchantPk, address(vault), np, nonceSeed, dl));
        assertEq(vault.nonce(), uint256(nonceSeed) + 1);
        assertEq(vault.payout(), np);
    }

    function testFuzz_initPayout_onlyFactory(address caller, address p) public {
        vm.assume(caller != address(factory));
        vm.prank(caller);
        vm.expectRevert(IX402Vault.Unauthorized.selector);
        vault.initPayout(p);
    }

    // ============================================================ settle: EIP-3009

    /// @dev The point of the rework: collection and both split legs are one transaction, and the
    /// two legs sum to exactly what the payer authorised. `_pay` deliberately relays as `stranger`.
    function test_settle_splitsAndEmits() public {
        _configure(token, BPS);

        uint256 fee = _fee(token);
        uint256 value = 1e18;
        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        token.mint(payer, value);

        bytes32 authNonce = keccak256("split");

        vm.expectEmit(true, true, true, true, address(vault));
        emit Settle(merchant, address(token), payer, value - fee, fee);

        _pay(payerPk, vault, token, value, authNonce);

        assertEq(token.balanceOf(merchant), value - fee, "merchant share");
        assertEq(token.balanceOf(address(factory)), fee, "fee share");
        assertEq(token.balanceOf(merchant) + token.balanceOf(address(factory)), value, "conservation");
        assertEq(token.balanceOf(address(vault)), 0, "the vault keeps nothing");
        assertEq(token.balanceOf(payer), 0, "the payer is charged exactly the authorised amount");
        assertTrue(token.authorizationState(payer, authNonce), "authorization consumed");
    }

    /// @dev `settle` is permissionless because the payload authenticates itself: the caller is only
    /// a relay. It is what lets a merchant settle their own payments if the operator ever stops.
    function test_settle_isPermissionless(address caller) public {
        vm.assume(caller != address(0));
        _configure(token, BPS);

        uint256 fee = _fee(token);
        uint256 value = 1e18;
        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        token.mint(payer, value);

        vm.prank(caller);
        vault.settle(address(token), _auth3009(payerPk, address(token), address(vault), value, keccak256("anyone")));

        assertEq(token.balanceOf(merchant), value - fee);
        assertEq(token.balanceOf(address(factory)), fee);
    }

    function test_settle_paysTheVaultsOwnPayoutAddress() public {
        _configure(token, BPS);

        uint256 fee = _fee(token);
        uint256 value = 1e18;
        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        token.mint(payer, value);

        _pay(payerPk, customVault, token, value, keccak256("custom"));

        assertEq(token.balanceOf(payoutAddr), value - fee, "the override payout is paid");
        assertEq(token.balanceOf(customMerchant), 0, "the merchant is not the payout of this vault");
        assertEq(token.balanceOf(address(factory)), fee);
    }

    /// @dev A payout change is authorised by the merchant and must steer *subsequent* settlements.
    function test_settle_followsAPayoutChange() public {
        _configure(token, BPS);

        uint256 fee = _fee(token);
        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        token.mint(payer, 2e18);

        address next = makeAddr("next-payout");
        _change(vault, merchantPk, next);

        _pay(payerPk, vault, token, 1e18, keccak256("after-change"));

        assertEq(token.balanceOf(next), 1e18 - fee);
        assertEq(token.balanceOf(merchant), 0);
    }

    /// @dev The factory's allowlist is the fee switch: an unconfigured token cannot be settled.
    function test_settle_unconfiguredTokenReverts() public {
        uint256 value = 1e18;
        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        token.mint(payer, value);

        assertEq(factory.tokenFeeBPS(address(token)), 0, "not configured");

        vm.prank(stranger);
        vm.expectRevert(IX402Vault.TokenNotSupported.selector);
        vault.settle(address(token), _auth3009(payerPk, address(token), address(vault), value, keccak256("n")));

        assertEq(token.balanceOf(payer), value);
    }

    /// @dev `tokenFeeBPS > 0` does not imply a non-zero fee: `tokenFee` is
    /// `bps * 10**decimals / 10000`, so a low-decimal token rounds to nothing. Settling for free is
    /// a misconfiguration and must fail loudly rather than quietly waive the fee.
    function test_settle_feeThatRoundsToZeroReverts() public {
        LowDecimalToken low = new LowDecimalToken();
        _configure(low, 1);

        assertEq(factory.tokenFeeBPS(address(low)), 1, "configured");
        assertEq(factory.tokenFee(address(low)), 0, "but the computed fee rounds to zero");

        uint256 value = 1e6;
        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        low.mint(payer, value);

        vm.prank(stranger);
        vm.expectRevert(IX402Vault.TokenNotSupported.selector);
        vault.settle(address(low), _auth3009(payerPk, address(low), address(vault), value, keccak256("n")));

        assertEq(low.balanceOf(payer), value);
    }

    /// @dev The fee check runs *before* the pull, so a below-fee payment fails with the
    /// authorization untouched: the payer keeps their funds and can still spend that nonce.
    function test_settle_atOrBelowFeeRevertsAndLeavesAuthorizationUsable() public {
        _configure(token, BPS);

        uint256 fee = _fee(token);
        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        token.mint(payer, 2e18);

        bytes32 authNonce = keccak256("small");

        _expectAmountBelowFee(payerPk, fee, authNonce);
        _expectAmountBelowFee(payerPk, fee - 1, authNonce);

        assertEq(token.balanceOf(payer), 2e18, "nothing moved");
        assertFalse(token.authorizationState(payer, authNonce), "authorization untouched");

        // Still spendable, for a payment that does cover the fee.
        _pay(payerPk, vault, token, 1e18, authNonce);

        assertTrue(token.authorizationState(payer, authNonce));
        assertEq(token.balanceOf(payer), 1e18);
    }

    function _expectAmountBelowFee(uint256 payerPk, uint256 value, bytes32 authNonce) internal {
        vm.prank(stranger);
        vm.expectRevert(IX402Vault.AmountBelowFee.selector);
        vault.settle(address(token), _auth3009(payerPk, address(token), address(vault), value, authNonce));
    }

    function testFuzz_settle_belowFeeAlwaysReverts(uint256 value) public {
        _configure(token, BPS);

        uint256 fee = _fee(token);
        value = bound(value, 0, fee);

        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        token.mint(payer, fee);

        bytes32 authNonce = keccak256("fuzz-small");

        vm.prank(stranger);
        vm.expectRevert(IX402Vault.AmountBelowFee.selector);
        vault.settle(address(token), _auth3009(payerPk, address(token), address(vault), value, authNonce));

        assertEq(token.balanceOf(payer), fee);
        assertFalse(token.authorizationState(payer, authNonce));
    }

    function testFuzz_settle_conservesValue(uint256 value) public {
        _configure(token, BPS);

        uint256 fee = _fee(token);
        value = bound(value, fee + 1, 1e30);

        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        token.mint(payer, value);

        _pay(payerPk, vault, token, value, keccak256("fuzz-conserve"));

        assertEq(token.balanceOf(merchant), value - fee);
        assertEq(token.balanceOf(address(factory)), fee);
        assertEq(token.balanceOf(merchant) + token.balanceOf(address(factory)), value);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(token.balanceOf(payer), 0);
    }

    function test_settle_replayedAuthorizationReverts() public {
        _configure(token, BPS);

        uint256 fee = _fee(token);
        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        token.mint(payer, 2e18);

        bytes32 authNonce = keccak256("once");
        _pay(payerPk, vault, token, 1e18, authNonce);

        vm.prank(stranger);
        vm.expectRevert(bytes("authorization already used"));
        vault.settle(address(token), _auth3009(payerPk, address(token), address(vault), 1e18, authNonce));

        assertEq(token.balanceOf(merchant), 1e18 - fee, "paid exactly once");
        assertEq(token.balanceOf(address(factory)), fee, "fee taken exactly once");
    }

    function test_settle_expiredAuthorizationReverts() public {
        _configure(token, BPS);

        uint256 value = 1e18;
        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        token.mint(payer, value);

        bytes32 authNonce = keccak256("expired");
        uint256 validBefore = block.timestamp; // the token rejects at `>= validBefore`

        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(payerPk, _tokenDigest(address(token), payer, address(vault), value, 0, validBefore, authNonce));

        vm.prank(stranger);
        vm.expectRevert(bytes("authorization expired"));
        vault.settle(
            address(token),
            IX402Vault.Eip3009Authorization({
                from: payer, value: value, validAfter: 0, validBefore: validBefore, nonce: authNonce, v: v, r: r, s: s
            })
        );

        assertEq(token.balanceOf(payer), value);
        assertFalse(token.authorizationState(payer, authNonce));
    }

    /// @dev The vault passes `to = address(this)` to the token, so a payment the payer signed for
    /// any other recipient cannot be redirected here.
    function test_settle_signatureForAnotherRecipientReverts() public {
        _configure(token, BPS);

        uint256 value = 1e18;
        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        token.mint(payer, value);

        IX402Vault.Eip3009Authorization memory auth =
            _auth3009(payerPk, address(token), payoutAddr, value, keccak256("wrong-to"));

        vm.prank(stranger);
        vm.expectRevert(bytes("invalid authorization signature"));
        vault.settle(address(token), auth);

        assertEq(token.balanceOf(payer), value);
    }

    // ------------------------------------------------ settle: token behaviour

    /// @dev A payout leg that fails must take the collection down with it. Nothing is left
    /// half-applied: no tokens moved, and the authorization is still spendable.
    function test_settle_falseReturningPayoutLegRevertsTheWholeSettlement() public {
        FalsePayoutToken t = new FalsePayoutToken();
        _configure(t, BPS);

        uint256 value = 1e18;
        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        t.mint(payer, value);

        bytes32 authNonce = keccak256("false-leg");

        vm.prank(stranger);
        vm.expectRevert(SafeTransferLib.TransferFailed.selector);
        vault.settle(address(t), _auth3009(payerPk, address(t), address(vault), value, authNonce));

        assertEq(t.balanceOf(payer), value, "the collection was rolled back");
        assertEq(t.balanceOf(address(vault)), 0);
        assertFalse(t.authorizationState(payer, authNonce), "the authorization was not consumed");
    }

    function test_settle_revertingPayoutLegRevertsTheWholeSettlement() public {
        RevertingPayoutToken t = new RevertingPayoutToken();
        _configure(t, BPS);

        uint256 value = 1e18;
        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        t.mint(payer, value);

        bytes32 authNonce = keccak256("reverting-leg");

        vm.prank(stranger);
        vm.expectRevert(SafeTransferLib.TransferFailed.selector);
        vault.settle(address(t), _auth3009(payerPk, address(t), address(vault), value, authNonce));

        assertEq(t.balanceOf(payer), value);
        assertEq(t.balanceOf(address(vault)), 0);
        assertFalse(t.authorizationState(payer, authNonce));
    }

    /// @dev The split assumes the vault receives exactly `value`. A fee-on-transfer token breaks
    /// that assumption, so the settlement must revert rather than underpay the merchant.
    function test_settle_feeOnTransferCollectionRevertsTheWholeSettlement() public {
        FeeOnTransferToken t = new FeeOnTransferToken();
        _configure(t, BPS);

        uint256 value = 1e18;
        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        t.mint(payer, value);

        bytes32 authNonce = keccak256("fee-on-transfer");

        vm.prank(stranger);
        vm.expectRevert(SafeTransferLib.TransferFailed.selector);
        vault.settle(address(t), _auth3009(payerPk, address(t), address(vault), value, authNonce));

        assertEq(t.balanceOf(payer), value);
        assertEq(t.balanceOf(address(vault)), 0);
        assertFalse(t.authorizationState(payer, authNonce));
    }

    /// @dev Documentation of a known, accepted limitation rather than a guarantee: a stray balance
    /// already sitting in the vault silently covers a fee-on-transfer shortfall instead of the
    /// call reverting. Reaching this needs a deliberate third-party `transfer` to the vault
    /// address — no protocol function can put a balance there. Keep fee-on-transfer tokens off
    /// `tokenFeeBPS`; the allowlist is the control.
    function test_settle_strayBalanceSilentlyCoversAFeeOnTransferShortfall() public {
        FeeOnTransferToken t = new FeeOnTransferToken();
        _configure(t, BPS);

        uint256 fee = _fee(t);
        uint256 value = 1e18;
        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        t.mint(payer, value);
        t.mint(address(vault), 1e18); // stray

        _pay(payerPk, vault, t, value, keccak256("stray"));

        // Both legs are skimmed on the way out too, so the amounts are 1% shy of the split.
        uint256 merchantLeg = value - fee;
        assertEq(t.balanceOf(merchant), merchantLeg - merchantLeg / 100);
        assertEq(t.balanceOf(address(factory)), fee - fee / 100);

        // The stray balance paid the 1% the collection lost.
        assertEq(t.balanceOf(address(vault)), 1e18 - value / 100);
    }

    /// @dev Re-entering settlement from the token during a payout leg cannot double-spend. The
    /// inner call is an ordinary settlement of a *different*, separately signed authorization, and
    /// the vault holds nothing between transactions, so there is no state to corrupt.
    function test_settle_reentrancyCannotDoubleSpend() public {
        _installPermit2();

        ReentrantToken rt = new ReentrantToken();
        _configure(rt, BPS);

        uint256 fee = _fee(rt);
        uint256 value = 1e18;

        uint256 outerPk = 0xCAFE;
        address outerPayer = vm.addr(outerPk);
        rt.mint(outerPayer, value);

        uint256 innerPk = 0xBEEF;
        address innerPayer = vm.addr(innerPk);
        rt.mint(innerPayer, value);
        _approvePermit2(rt, innerPayer);

        (IX402Vault.Permit2Authorization memory innerAuth, bytes memory innerSig) =
            _permit2Auth(innerPk, SafeTransferLib.PERMIT2, address(vault), address(rt), value, 11);

        rt.arm(address(vault), abi.encodeCall(X402Vault.settleWithPermit2, (address(rt), innerAuth, innerSig)));

        _pay(outerPk, vault, rt, value, keccak256("outer"));

        assertEq(rt.balanceOf(merchant), 2 * (value - fee), "each payment landed exactly once");
        assertEq(rt.balanceOf(address(factory)), 2 * fee);
        assertEq(rt.balanceOf(address(vault)), 0);
        assertEq(rt.balanceOf(outerPayer), 0);
        assertEq(rt.balanceOf(innerPayer), 0);
    }

    // ============================================================ settle: Permit2

    function test_settleWithPermit2_splitsAndEmits() public {
        MockPermit2 permit2 = _installPermit2();
        _configure(token, BPS);

        uint256 fee = _fee(token);
        uint256 value = 1e18;
        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        token.mint(payer, value);
        _approvePermit2(token, payer);

        uint256 permitNonce = 7;

        vm.expectEmit(true, true, true, true, address(vault));
        emit Settle(merchant, address(token), payer, value - fee, fee);

        _payWithPermit2(payerPk, vault, token, value, permitNonce);

        assertEq(token.balanceOf(merchant), value - fee);
        assertEq(token.balanceOf(address(factory)), fee);
        assertEq(token.balanceOf(merchant) + token.balanceOf(address(factory)), value);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(token.balanceOf(payer), 0);
        assertTrue(permit2.nonceUsed(payer, permitNonce), "permit nonce consumed");
    }

    function test_settleWithPermit2_unconfiguredTokenReverts() public {
        _installPermit2();

        uint256 value = 1e18;
        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        token.mint(payer, value);
        _approvePermit2(token, payer);

        (IX402Vault.Permit2Authorization memory auth, bytes memory sig) =
            _permit2Auth(payerPk, SafeTransferLib.PERMIT2, address(vault), address(token), value, 1);

        vm.prank(stranger);
        vm.expectRevert(IX402Vault.TokenNotSupported.selector);
        vault.settleWithPermit2(address(token), auth, sig);

        assertEq(token.balanceOf(payer), value);
    }

    function test_settleWithPermit2_belowFeeRevertsAndLeavesNonceUnused() public {
        MockPermit2 permit2 = _installPermit2();
        _configure(token, BPS);

        uint256 fee = _fee(token);
        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        token.mint(payer, fee);
        _approvePermit2(token, payer);

        uint256 permitNonce = 3;
        (IX402Vault.Permit2Authorization memory auth, bytes memory sig) =
            _permit2Auth(payerPk, SafeTransferLib.PERMIT2, address(vault), address(token), fee, permitNonce);

        vm.prank(stranger);
        vm.expectRevert(IX402Vault.AmountBelowFee.selector);
        vault.settleWithPermit2(address(token), auth, sig);

        assertEq(token.balanceOf(payer), fee, "nothing moved");
        assertFalse(permit2.nonceUsed(payer, permitNonce), "the permit nonce is untouched");
    }

    function test_settleWithPermit2_replayedNonceReverts() public {
        _installPermit2();
        _configure(token, BPS);

        uint256 fee = _fee(token);
        uint256 value = 1e18;
        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        token.mint(payer, 2 * value);
        _approvePermit2(token, payer);

        uint256 permitNonce = 5;
        _payWithPermit2(payerPk, vault, token, value, permitNonce);

        (IX402Vault.Permit2Authorization memory auth, bytes memory sig) =
            _permit2Auth(payerPk, SafeTransferLib.PERMIT2, address(vault), address(token), value, permitNonce);

        vm.prank(stranger);
        vm.expectRevert(bytes("nonce already used"));
        vault.settleWithPermit2(address(token), auth, sig);

        assertEq(token.balanceOf(merchant), value - fee, "settled exactly once");
        assertEq(token.balanceOf(address(factory)), fee);
    }

    /// @dev The binding that makes a permissionless Permit2 settlement safe: Permit2 puts
    /// `msg.sender` — this vault — into the digest it verifies, so a signature the payer gave to
    /// someone else cannot be replayed here to move their funds.
    function test_settleWithPermit2_signatureForAnotherSpenderReverts() public {
        _installPermit2();
        _configure(token, BPS);

        uint256 value = 1e18;
        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        token.mint(payer, value);
        _approvePermit2(token, payer);

        (IX402Vault.Permit2Authorization memory auth, bytes memory sig) =
            _permit2Auth(payerPk, SafeTransferLib.PERMIT2, makeAddr("some-other-spender"), address(token), value, 1);

        vm.prank(stranger);
        vm.expectRevert(bytes("invalid permit signature"));
        vault.settleWithPermit2(address(token), auth, sig);

        assertEq(token.balanceOf(payer), value);
    }

    function test_settleWithPermit2_signatureForSmallerAmountReverts() public {
        _installPermit2();
        _configure(token, BPS);

        uint256 value = 1e18;
        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        token.mint(payer, value);
        _approvePermit2(token, payer);

        uint256 permitNonce = 2;
        uint256 deadline = block.timestamp + 1 days;

        // Signed for half of what the payload claims. The vault builds `permitted.amount` from the
        // payload's `value`, so the digest no longer matches the signature.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            payerPk,
            _permit2Digest(SafeTransferLib.PERMIT2, address(vault), address(token), value / 2, permitNonce, deadline)
        );

        vm.prank(stranger);
        vm.expectRevert(bytes("invalid permit signature"));
        vault.settleWithPermit2(
            address(token),
            IX402Vault.Permit2Authorization({from: payer, value: value, nonce: permitNonce, deadline: deadline}),
            abi.encodePacked(r, s, v)
        );

        assertEq(token.balanceOf(payer), value);
    }

    function test_settleWithPermit2_expiredDeadlineReverts() public {
        _installPermit2();
        _configure(token, BPS);

        uint256 value = 1e18;
        uint256 payerPk = 0xCAFE;
        address payer = vm.addr(payerPk);
        token.mint(payer, value);
        _approvePermit2(token, payer);

        uint256 permitNonce = 4;
        uint256 deadline = block.timestamp;

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            payerPk,
            _permit2Digest(SafeTransferLib.PERMIT2, address(vault), address(token), value, permitNonce, deadline)
        );

        vm.warp(deadline + 1);

        vm.prank(stranger);
        vm.expectRevert(bytes("signature expired"));
        vault.settleWithPermit2(
            address(token),
            IX402Vault.Permit2Authorization({from: payer, value: value, nonce: permitNonce, deadline: deadline}),
            abi.encodePacked(r, s, v)
        );

        assertEq(token.balanceOf(payer), value);
    }
}

/// @dev Minimal second factory used to prove cross-factory signature isolation.
contract X402VaultFactoryLike {
    X402VaultFactory internal f;

    constructor() {
        f = new X402VaultFactory(address(this), address(this));
    }

    function make(address merchant) external returns (address) {
        return f.createVault(merchant, merchant);
    }
}
