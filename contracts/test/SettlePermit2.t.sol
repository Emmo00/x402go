// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {X402Base} from "./utils/X402Base.sol";
import {X402Vault} from "../src/X402Vault.sol";
import {IX402Vault} from "../src/interfaces/IX402Vault.sol";
import {IPermit2} from "../src/interfaces/IPermit2.sol";
import {IX402ExactPermit2Proxy} from "../src/interfaces/IX402ExactPermit2Proxy.sol";
import {
    LyingProxy,
    MockPermit2,
    PERMIT2_ADDR,
    PERMIT2_DOMAIN_TYPEHASH,
    PERMIT2_WITNESS_TYPEHASH,
    UsdtStyleToken,
    WITNESS_TYPE_STRING,
    X402_PROXY_ADDR
} from "./utils/Mocks.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

/// @dev Suite H — `settleWithPermit2`.
///
/// The vault is a thin adapter here: it validates the recipient, then delegates both the signature
/// check and the transfer to the x402 proxy sitting on top of Permit2. The suite therefore spends
/// most of its assertions on the two things the vault *does* own — `witness.to` and the
/// balance-delta check — and on proving the adapter wires the canonical ABI correctly.
contract SettlePermit2Test is X402Base {
    address internal vault;

    function setUp() public override {
        super.setUp();
        vault = _openVault();
        _configure(address(token6), DEFAULT_BPS);
        token6.mint(payer, 1_000e6);
        _installPermit2();
        _approvePermit2(address(token6), payer);
    }

    function _settleAs(
        address caller,
        IPermit2.PermitTransferFrom memory permit,
        IX402ExactPermit2Proxy.Witness memory wit,
        bytes memory sig
    ) internal {
        vm.prank(caller);
        X402Vault(vault).settleWithPermit2(permit, payer, wit, sig);
    }

    /// @dev The three payload pieces, signed by `payerPk` for `recipient`, naming `tokenContract`.
    /// `bytes32` nonces because every call site builds them with `keccak256`.
    function _argsFor(address recipient, address tokenContract, uint256 value, bytes32 permitNonce)
        internal
        view
        returns (IPermit2.PermitTransferFrom memory, IX402ExactPermit2Proxy.Witness memory, bytes memory)
    {
        return _permit2Args(payerPk, recipient, tokenContract, value, uint256(permitNonce));
    }

    /// @dev The same, aimed at the vault this suite settles on, paying in `token6`.
    function _args(uint256 value, bytes32 permitNonce)
        internal
        view
        returns (IPermit2.PermitTransferFrom memory, IX402ExactPermit2Proxy.Witness memory, bytes memory)
    {
        return _argsFor(vault, address(token6), value, permitNonce);
    }

    // -------------------------------------------------------------- happy path

    function test_settleWithPermit2_splitsBetweenTheMerchantAndTheFactory() public {
        uint256 value = 100e6;
        uint256 fee = _fee(address(token6));

        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
            _args(value, keccak256("p"));

        _settleAs(stranger, permit, wit, sig);

        assertEq(token6.balanceOf(merchant), value - fee);
        assertEq(token6.balanceOf(address(factory)), fee);
        assertEq(token6.balanceOf(vault), 0, "the vault keeps nothing");
        assertEq(token6.balanceOf(payer), 1_000e6 - value);
    }

    function test_settleWithPermit2_emitsTheSplit() public {
        uint256 value = 100e6;
        uint256 fee = _fee(address(token6));

        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
            _args(value, keccak256("p"));

        vm.expectEmit(true, true, true, true, vault);
        emit IX402Vault.Settle(merchant, address(token6), payer, value - fee, fee);

        _settleAs(stranger, permit, wit, sig);
    }

    function test_settleWithPermit2_isPermissionless() public {
        uint256 value = 10e6;
        address[4] memory callers = [stranger, merchant, owner, operator];

        for (uint256 i; i < callers.length; ++i) {
            (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
                _args(value, keccak256(abi.encode("relay", i)));
            _settleAs(callers[i], permit, wit, sig);
        }

        assertEq(token6.balanceOf(merchant), (value - _fee(address(token6))) * 4);
    }

    function test_settleWithPermit2_paysTheOverridePayout() public {
        address merchant2 = makeAddr("merchant2");
        address overrideVault = _deploy(merchant2, payoutAddr);

        uint256 value = 100e6;
        uint256 fee = _fee(address(token6));

        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
            _argsFor(overrideVault, address(token6), value, keccak256("override"));

        vm.prank(stranger);
        X402Vault(overrideVault).settleWithPermit2(permit, payer, wit, sig);

        assertEq(token6.balanceOf(payoutAddr), value - fee);
        assertEq(token6.balanceOf(address(factory)), fee);
    }

    function test_settleWithPermit2_aSecondPaymentWithADifferentNonceWorks() public {
        (IPermit2.PermitTransferFrom memory p1, IX402ExactPermit2Proxy.Witness memory w1, bytes memory s1) =
            _args(10e6, keccak256("one"));
        _settleAs(stranger, p1, w1, s1);

        (IPermit2.PermitTransferFrom memory p2, IX402ExactPermit2Proxy.Witness memory w2, bytes memory s2) =
            _args(20e6, keccak256("two"));
        _settleAs(stranger, p2, w2, s2);

        uint256 fee = _fee(address(token6));
        assertEq(token6.balanceOf(address(factory)), fee * 2);
        assertEq(token6.balanceOf(merchant), 30e6 - fee * 2);
    }

    // -------------------------------------------------------- the recipient check

    function test_settleWithPermit2_rejectsAWitnessNamingAnotherRecipient() public {
        // The signature is genuinely valid — for a transfer to the merchant. The vault is the one
        // that says no, because otherwise the proxy would pay the merchant and the vault would then
        // split its *own* balance to cover a payment it never received.
        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
            _argsFor(merchant, address(token6), 100e6, keccak256("elsewhere"));

        assertEq(wit.to, merchant, "the signature really does name the merchant");

        vm.expectRevert(IX402Vault.InvalidRecipient.selector);
        _settleAs(stranger, permit, wit, sig);

        assertEq(token6.balanceOf(vault), 0);
        assertEq(token6.balanceOf(merchant), 0);
    }

    function test_settleWithPermit2_rejectsASelfDirectedWitness() public {
        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
            _argsFor(payer, address(token6), 100e6, keccak256("self"));

        vm.expectRevert(IX402Vault.InvalidRecipient.selector);
        _settleAs(stranger, permit, wit, sig);
    }

    function test_settleWithPermit2_theRecipientCheckRunsBeforeAnyPermit2Work() public {
        // A witness naming the merchant, paired with a *bogus* signature: the vault's own error must
        // win, proving the check is not merely the last thing that happens to fail.
        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit,) =
            _argsFor(merchant, address(token6), 100e6, keccak256("bogus"));

        vm.expectRevert(IX402Vault.InvalidRecipient.selector);
        _settleAs(stranger, permit, wit, hex"deadbeef");
    }

    // --------------------------------------------------------------- fee bounds

    function test_settleWithPermit2_valueEqualToFeeReverts() public {
        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
            _args(_fee(address(token6)), keccak256("at-fee"));

        vm.expectRevert(IX402Vault.AmountBelowFee.selector);
        _settleAs(stranger, permit, wit, sig);
    }

    function test_settleWithPermit2_valueBelowFeeReverts() public {
        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
            _args(1, keccak256("below-fee"));

        vm.expectRevert(IX402Vault.AmountBelowFee.selector);
        _settleAs(stranger, permit, wit, sig);
    }

    // ------------------------------------------------------- per-payload failures

    function test_settleWithPermit2_missingAllowanceReverts() public {
        // Needs a standalone token with an ordinary allowance mapping: solady's ERC20 cannot express
        // this case at all, which is what the test below records.
        UsdtStyleToken t = new UsdtStyleToken("Tether", "USDT", 6);
        _configure(address(t), DEFAULT_BPS);
        t.mint(payer, 1_000e6);

        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
            _argsFor(vault, address(t), 100e6, keccak256("no-allowance"));

        assertEq(t.allowance(payer, PERMIT2_ADDR), 0);

        vm.expectRevert();
        _settleAs(stranger, permit, wit, sig);
    }

    function test_settleWithPermit2_soladyTokensGivePermit2AnUnconditionalAllowance() public {
        // Not a vault behaviour, but it constrains what the Permit2 path can be tested with: solady's
        // ERC20 treats Permit2 as a permanent infinite spender, so `token6` has no representable
        // "unapproved" state and an approval to Permit2 can only ever be `type(uint256).max`.
        assertEq(token6.allowance(payer, PERMIT2_ADDR), type(uint256).max);

        vm.expectRevert(ERC20.Permit2AllowanceIsFixedAtInfinity.selector);
        vm.prank(payer);
        token6.approve(PERMIT2_ADDR, 0);
    }

    function test_settleWithPermit2_futureValidAfterReverts() public {
        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit,) =
            _args(100e6, keccak256("early"));

        // forge-lint: disable-next-line(block-timestamp)
        wit.validAfter = block.timestamp + 1;
        bytes memory sig = _signPermit2(payerPk, PERMIT2_ADDR, X402_PROXY_ADDR, permit, wit);

        vm.expectRevert(bytes("Too early"));
        _settleAs(stranger, permit, wit, sig);
    }

    function test_settleWithPermit2_expiredDeadlineReverts() public {
        IPermit2.PermitTransferFrom memory permit =
            _permit(address(token6), 100e6, uint256(keccak256("expired")), block.timestamp - 1);
        IX402ExactPermit2Proxy.Witness memory wit = _witness(vault, 0);
        bytes memory sig = _signPermit2(payerPk, PERMIT2_ADDR, X402_PROXY_ADDR, permit, wit);

        vm.expectRevert(bytes("signature expired"));
        _settleAs(stranger, permit, wit, sig);
    }

    function test_settleWithPermit2_deadlineEqualNowPasses() public {
        // The mock mirrors Permit2's `>`: a deadline of exactly now is still live.
        IPermit2.PermitTransferFrom memory permit =
            _permit(address(token6), 100e6, uint256(keccak256("now")), block.timestamp);
        IX402ExactPermit2Proxy.Witness memory wit = _witness(vault, 0);
        bytes memory sig = _signPermit2(payerPk, PERMIT2_ADDR, X402_PROXY_ADDR, permit, wit);

        _settleAs(stranger, permit, wit, sig);

        assertEq(token6.balanceOf(vault), 0);
    }

    function test_settleWithPermit2_reusedNonceReverts() public {
        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
            _args(100e6, keccak256("replay"));

        _settleAs(stranger, permit, wit, sig);

        vm.expectRevert(bytes("nonce already used"));
        _settleAs(stranger, permit, wit, sig);
    }

    function test_settleWithPermit2_wrongSignerReverts() public {
        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
            _args(100e6, keccak256("wrong-signer"));

        // `from` names someone else than the key that signed.
        vm.expectRevert(bytes("invalid permit signature"));
        vm.prank(stranger);
        X402Vault(vault).settleWithPermit2(permit, stranger, wit, sig);
    }

    function test_settleWithPermit2_tamperedAmountReverts() public {
        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
            _args(100e6, keccak256("tampered"));

        permit.permitted.amount = 1_000e6; // signed for 100

        vm.expectRevert(bytes("invalid permit signature"));
        _settleAs(stranger, permit, wit, sig);
    }

    function test_settleWithPermit2_tamperedValidAfterReverts() public {
        // A third party cannot edit the witness: its hash is folded into the digest, so the
        // signature no longer recovers to the payer.
        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
            _args(100e6, keccak256("tampered-witness"));

        wit.validAfter = 1;

        vm.expectRevert(bytes("invalid permit signature"));
        _settleAs(stranger, permit, wit, sig);
    }

    function test_settleWithPermit2_tokenMismatchReverts() public {
        // Signed over token18, presented as a token6 permit.
        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
            _argsFor(vault, address(token18), 100e6, keccak256("token-mismatch"));

        permit.permitted.token = address(token6);

        vm.expectRevert(bytes("invalid permit signature"));
        _settleAs(stranger, permit, wit, sig);
    }

    function test_settleWithPermit2_signatureBoundToTheVaultItselfDoesNotWork() public {
        // The payer signed with `spender = vault`, but Permit2 binds `spender = msg.sender`, which is
        // the proxy. This is the whole reason the two addresses are separate.
        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit,) =
            _args(100e6, keccak256("spender-vault"));
        bytes memory sig = _signPermit2(payerPk, PERMIT2_ADDR, vault, permit, wit);

        vm.expectRevert(bytes("invalid permit signature"));
        _settleAs(stranger, permit, wit, sig);
    }

    function test_settleWithPermit2_signatureBoundToAnotherProxyDoesNotWork() public {
        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit,) =
            _args(100e6, keccak256("spender-other"));
        bytes memory sig = _signPermit2(payerPk, PERMIT2_ADDR, makeAddr("otherProxy"), permit, wit);

        vm.expectRevert(bytes("invalid permit signature"));
        _settleAs(stranger, permit, wit, sig);
    }

    // -------------------------------------------------- the balance-delta check

    function test_settleWithPermit2_aProxyThatDeliversNothingIsCaught() public {
        LyingProxy lying = _installLyingProxy();
        lying.setMode(0);

        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
            _args(100e6, keccak256("lying-zero"));

        // The proxy ignores the signature entirely, so a failure here can only be the delta check.
        vm.expectRevert(IX402Vault.AmountNotReceived.selector);
        _settleAs(stranger, permit, wit, sig);
    }

    function test_settleWithPermit2_aProxyThatDeliversHalfIsCaught() public {
        LyingProxy lying = _installLyingProxy();
        lying.setMode(1);

        vm.prank(payer);
        token6.approve(X402_PROXY_ADDR, type(uint256).max);

        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
            _args(100e6, keccak256("lying-half"));

        vm.expectRevert(IX402Vault.AmountNotReceived.selector);
        _settleAs(stranger, permit, wit, sig);

        assertEq(token6.balanceOf(vault), 0, "the partial delivery is rolled back with the revert");
    }

    function test_settleWithPermit2_aStrayBalanceDoesNotMaskAShortDelivery() public {
        // The delta check is a delta, not a total: tokens already sitting in the vault cannot be
        // mistaken for the payment arriving.
        LyingProxy lying = _installLyingProxy();
        lying.setMode(1);

        vm.prank(payer);
        token6.approve(X402_PROXY_ADDR, type(uint256).max);
        token6.mint(vault, 1_000e6);

        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
            _args(100e6, keccak256("stray"));

        vm.expectRevert(IX402Vault.AmountNotReceived.selector);
        _settleAs(stranger, permit, wit, sig);

        assertEq(token6.balanceOf(vault), 1_000e6, "the stray balance is untouched");
    }

    // ---------------------------------------------------------- ABI compatibility

    function test_settleWithPermit2_pinsTheProxySettleSelector() public pure {
        // Pinned from `settle(((address,uint256),uint256,uint256),address,(address,uint256),bytes)`,
        // which is the shape the canonical x402 proxy exposes. A struct reorder would move it.
        bytes4 derived =
            bytes4(keccak256("settle(((address,uint256),uint256,uint256),address,(address,uint256),bytes)"));
        assertEq(derived, bytes4(0x13cd3b53));
        assertEq(IX402ExactPermit2Proxy.settle.selector, derived);
    }

    function test_settleWithPermit2_pinsTheVaultSelector() public pure {
        bytes4 derived =
            bytes4(keccak256("settleWithPermit2(((address,uint256),uint256,uint256),address,(address,uint256),bytes)"));
        assertEq(derived, bytes4(0xebae2b8d));
    }

    function test_settleWithPermit2_theStandInPermit2KeepsTheCanonicalDomain() public view {
        // If the etched singleton's domain drifted, every signature in this suite would be valid for
        // a different deployment than the one the helpers describe.
        assertEq(MockPermit2(PERMIT2_ADDR).domainSeparator(), _permit2Domain(PERMIT2_ADDR));
    }

    function test_settleWithPermit2_pinsPermit2sDomainTypehash() public pure {
        // Pinned as a literal because this is the one value in the Permit2 path that is easy to get
        // wrong in a way the local suite cannot see: a mock rebuilt from the same wrong assumption
        // agrees with itself perfectly.
        //
        // Permit2's domain has **no `version` field**. The four-field form with `version = "1"`
        // (`keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")`
        // = 0x8b73c3c6...) is the shape most other EIP-712 contracts use and is what a first draft
        // of these helpers reached for; it produces signatures the real singleton rejects.
        //
        // The value below is what `DOMAIN_SEPARATOR()` returns on the deployed singleton at
        // 0x000000000022D473030F116dDEE9F6B43aC78BA3 for chainid 11142220, reproduced locally.
        // Suite M checks it against the live contract.
        assertEq(
            PERMIT2_DOMAIN_TYPEHASH,
            bytes32(0x8cad95687ba82c2ce50e74f7b754645e5117c3a5bec8151c0726d5857980a866),
            "Permit2's domain typehash changed shape"
        );

        assertEq(
            keccak256(abi.encode(PERMIT2_DOMAIN_TYPEHASH, keccak256("Permit2"), 11_142_220, PERMIT2_ADDR)),
            bytes32(0xbaf1db64d9a889ab0d72b38a5d51123137e21a45972de65e2f2494c0657a5da4),
            "the separator computed for Celo Sepolia does not match the deployed singleton"
        );
    }

    function test_settleWithPermit2_pinsTheWitnessTypeString() public pure {
        // The second half of the same hazard. Permit2 hashes `PREFIX ++ witnessTypeString` into the
        // primary type, so the string the proxy passes has to be the *tail of a valid EIP-712
        // `encodeType`*: it names the fifth field (`Witness witness`), closes the primary type, and
        // only then appends the referenced structs, alphabetically.
        //
        // An earlier draft wrote a bare `"Witness(address to,uint256 validAfter)"` and had the mock
        // append the `TokenPermissions` definition — which inlines a struct where a field name
        // belongs. Both the mock and the offline signer agreed on it, so the whole local suite was
        // green while every real payment reverted `InvalidSigner()` from the singleton. The string
        // below is copied from the deployed proxy's `settle` call; Suite M runs it for real.
        assertEq(
            WITNESS_TYPE_STRING,
            "Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter)"
        );

        assertEq(
            keccak256(
                abi.encodePacked(
                    "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                    WITNESS_TYPE_STRING
                )
            ),
            PERMIT2_WITNESS_TYPEHASH,
            "the pinned constant is not the type hash of the pinned string"
        );

        assertEq(
            PERMIT2_WITNESS_TYPEHASH,
            bytes32(0xebc156cd23678a74c94df13d772ef5478420637f0c94bd10d509e1dc98f521c7),
            "the witness type hash moved"
        );

        assertEq(MockPermit2(PERMIT2_ADDR).witnessTypehash(), PERMIT2_WITNESS_TYPEHASH);
    }

    // ---------------------------------------------------------------------- fuzz

    /// @dev Each run signs and settles one payment through the full Permit2 path.
    /// forge-config: default.fuzz.runs = 256
    function testFuzz_settleWithPermit2_conservesValue(uint16 bps, uint96 value) public {
        bps = uint16(bound(bps, 1, 10_000));
        uint256 fee = (uint256(bps) * 1e6) / 10_000;

        _configure(address(token6), bps);
        vm.assume(fee != 0);

        value = uint96(bound(value, fee + 1, 1_000e6));
        token6.mint(payer, value);

        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
            _args(value, keccak256(abi.encode(bps, value)));
        _settleAs(stranger, permit, wit, sig);

        uint256 toMerchant = token6.balanceOf(merchant);
        uint256 toFactory = token6.balanceOf(address(factory));

        assertEq(toMerchant + toFactory, value, "nothing created or destroyed");
        assertEq(toFactory, fee);
        assertEq(token6.balanceOf(vault), 0);
    }
}
