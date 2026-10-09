// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {IX402Vault} from "../../src/interfaces/IX402Vault.sol";
import {IPermit2} from "../../src/interfaces/IPermit2.sol";
import {IX402ExactPermit2Proxy} from "../../src/interfaces/IX402ExactPermit2Proxy.sol";

import {
    EIP712_DOMAIN_TYPEHASH,
    LyingProxy,
    MockERC20,
    MockPermit2,
    MockX402ExactPermit2Proxy,
    PERMIT2_ADDR,
    PERMIT2_DOMAIN_TYPEHASH,
    PERMIT2_WITNESS_TYPEHASH,
    TOKEN_PERMISSIONS_TYPEHASH,
    WITNESS_TYPEHASH,
    X402_PROXY_ADDR
} from "./Mocks.sol";

/// @dev The EIP-3009 surface the signing helpers read off a token, so the same helper serves
/// {MockERC20} and {UsdtStyleToken} without caring which one it was handed.
interface IEip3009Token {
    function domainSeparator() external view returns (bytes32);
    function TRANSFER_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/// @dev Payload construction and signing, with no dependency on any deployed contract.
///
/// Split out from {X402Base} so the invariant handler — which drives its own factory and tokens —
/// can sign the same payloads the suites do, rather than a second copy that could drift.
abstract contract X402Signing is Test {
    uint256 internal constant SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    bytes32 internal constant CHANGE_PAYOUT_TYPEHASH =
        keccak256("ChangePayout(address newPayout,uint256 nonce,uint256 deadline)");

    // ------------------------------------------------------------- changePayout

    /// @dev A signature deadline comfortably in the future.
    function _deadline() internal view returns (uint256) {
        return block.timestamp + 1 days;
    }

    function _domainSeparator(address vault_) internal view returns (bytes32) {
        return
            keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("X402Vault"), keccak256("1"), block.chainid, vault_));
    }

    function _digest(address vault_, address newPayout, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(CHANGE_PAYOUT_TYPEHASH, newPayout, nonce, deadline));
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(vault_), structHash));
    }

    function _rsv(uint256 pk, address vault_, address newPayout, uint256 nonce, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        (v, r, s) = vm.sign(pk, _digest(vault_, newPayout, nonce, deadline));
    }

    function _sig(uint256 pk, address vault_, address newPayout, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = _rsv(pk, vault_, newPayout, nonce, deadline);
        return abi.encodePacked(r, s, v);
    }

    /// @dev EIP-2098 64-byte compact signature.
    function _compactSig(uint256 pk, address vault_, address newPayout, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = _rsv(pk, vault_, newPayout, nonce, deadline);
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));
        return abi.encodePacked(r, vs);
    }

    // ------------------------------------------------------------------- arrays
    //
    // Named rather than overloaded on `_one`: an overload set that differs only by integer width
    // is ambiguous at the call site the moment an argument is a cast expression.

    function _addrs(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function _bps(uint16 a) internal pure returns (uint16[] memory r) {
        r = new uint16[](1);
        r[0] = a;
    }

    function _uints(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    // ------------------------------------------------------------- EIP-3009 payloads

    /// @dev The EIP-712 digest for an authorization, against an explicitly supplied domain.
    ///
    /// The domain is passed in rather than read off the token because not every EIP-3009 token
    /// exposes `domainSeparator()` — Celo's USDC verifies signatures perfectly well without one.
    /// Nothing is lost by this: the token is the verifier, so a wrong domain shows up as a rejected
    /// signature rather than as a test that quietly passes.
    function _tokenDigestWithDomain(
        bytes32 tokenDomainSeparator,
        bytes32 typehash,
        address to,
        IX402Vault.Eip3009Authorization memory auth
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                tokenDomainSeparator,
                keccak256(
                    abi.encode(typehash, auth.from, to, auth.value, auth.validAfter, auth.validBefore, auth.nonce)
                )
            )
        );
    }

    /// @dev Reads the domain and the type hash off the token rather than restating them, so the
    /// helper cannot drift from the token it signs for. A suite pins the token's own type hash
    /// against the standard string, and Suite M pins the domain against a real deployment.
    function _tokenDigest(address tokenContract, address to, IX402Vault.Eip3009Authorization memory auth)
        internal
        view
        returns (bytes32)
    {
        return _tokenDigestWithDomain(
            IEip3009Token(tokenContract).domainSeparator(),
            IEip3009Token(tokenContract).TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
            to,
            auth
        );
    }

    /// @dev Signs an already-populated authorization. Split out from {_auth3009} so a negative case
    /// can vary the window or the recipient without a second helper carrying eight parameters —
    /// the legacy codegen has a sixteen-slot stack and `vm.sign` is expensive in slots.
    function _sign3009(uint256 pk, address tokenContract, address to, IX402Vault.Eip3009Authorization memory auth)
        internal
        view
        returns (IX402Vault.Eip3009Authorization memory)
    {
        {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _tokenDigest(tokenContract, to, auth));

            auth.v = v;
            auth.r = r;
            auth.s = s;
        }

        return auth;
    }

    /// @dev {_sign3009} against an explicit domain, for tokens that do not publish one.
    function _sign3009WithDomain(
        uint256 pk,
        bytes32 tokenDomainSeparator,
        bytes32 typehash,
        address to,
        IX402Vault.Eip3009Authorization memory auth
    ) internal pure returns (IX402Vault.Eip3009Authorization memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _tokenDigestWithDomain(tokenDomainSeparator, typehash, to, auth));

        auth.v = v;
        auth.r = r;
        auth.s = s;

        return auth;
    }

    /// @dev A signed EIP-3009 payload paying `to`, valid now and for a day.
    function _auth3009(uint256 pk, address tokenContract, address to, uint256 value, bytes32 authNonce)
        internal
        view
        returns (IX402Vault.Eip3009Authorization memory auth)
    {
        auth.from = vm.addr(pk);
        auth.value = value;
        auth.validAfter = 0;
        auth.validBefore = block.timestamp + 1 days;
        auth.nonce = authNonce;

        return _sign3009(pk, tokenContract, to, auth);
    }

    /// @dev {_auth3009} against an explicit domain and type hash, for tokens that publish neither.
    function _auth3009WithDomain(
        uint256 pk,
        bytes32 tokenDomainSeparator,
        bytes32 typehash,
        address to,
        uint256 value,
        bytes32 authNonce
    ) internal view returns (IX402Vault.Eip3009Authorization memory auth) {
        auth.from = vm.addr(pk);
        auth.value = value;
        auth.validAfter = 0;
        auth.validBefore = block.timestamp + 1 days;
        auth.nonce = authNonce;

        return _sign3009WithDomain(pk, tokenDomainSeparator, typehash, to, auth);
    }

    // ------------------------------------------------------------- Permit2 payloads

    /// @dev Mirrors the Permit2 singleton's domain. Computed locally rather than read back, so the
    /// self-test comparing it to `domainSeparator()` on the etched singleton is a real check.
    ///
    /// Permit2's domain carries **no `version` field** — it is
    /// `EIP712Domain(string name,uint256 chainId,address verifyingContract)`, not the four-field
    /// form with a version. See {PERMIT2_DOMAIN_TYPEHASH} in Mocks.sol for the on-chain evidence;
    /// getting this wrong produces signatures only a matching mock will accept.
    function _permit2Domain(address permit2Contract) internal view returns (bytes32) {
        return keccak256(abi.encode(PERMIT2_DOMAIN_TYPEHASH, keccak256("Permit2"), block.chainid, permit2Contract));
    }

    function _witness(address to, uint256 validAfter) internal pure returns (IX402ExactPermit2Proxy.Witness memory w) {
        w.to = to;
        w.validAfter = validAfter;
    }

    function _permit(address token, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        pure
        returns (IPermit2.PermitTransferFrom memory permit)
    {
        permit.permitted.token = token;
        permit.permitted.amount = amount;
        permit.nonce = nonce;
        permit.deadline = deadline;
    }

    /// @dev The `PermitWitnessTransferFrom` digest, binding `spender` the way the real singleton
    /// binds it: to whoever calls `permitWitnessTransferFrom`, which is the proxy.
    function _permit2Digest(
        address permit2Contract,
        address spender,
        IPermit2.PermitTransferFrom memory permit,
        IX402ExactPermit2Proxy.Witness memory witness
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                _permit2Domain(permit2Contract),
                keccak256(
                    abi.encode(
                        PERMIT2_WITNESS_TYPEHASH,
                        keccak256(
                            abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted.token, permit.permitted.amount)
                        ),
                        spender,
                        permit.nonce,
                        permit.deadline,
                        keccak256(abi.encode(WITNESS_TYPEHASH, witness.to, witness.validAfter))
                    )
                )
            )
        );
    }

    function _signPermit2(
        uint256 pk,
        address permit2Contract,
        address spender,
        IPermit2.PermitTransferFrom memory permit,
        IX402ExactPermit2Proxy.Witness memory witness
    ) internal view returns (bytes memory signature) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _permit2Digest(permit2Contract, spender, permit, witness));
        signature = abi.encodePacked(r, s, v);
    }

    /// @dev The three pieces a `settleWithPermit2` call needs, so a negative case can swap one of
    /// them out (a different witness, a tampered amount) without rebuilding the rest by hand.
    function _permit2Args(uint256 pk, address vaultAddr, address tokenContract, uint256 value, uint256 permitNonce)
        internal
        view
        returns (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig)
    {
        permit = _permit(tokenContract, value, permitNonce, block.timestamp + 1 days);
        wit = _witness(vaultAddr, 0);
        sig = _signPermit2(pk, PERMIT2_ADDR, X402_PROXY_ADDR, permit, wit);
    }

    // ----------------------------------------------------- Permit2/proxy fixtures

    /// @dev Installs the Permit2 singleton and the x402 proxy stand-ins at their canonical
    /// addresses, so any contract hardcoding those constants resolves to them.
    ///
    /// Handles are read at the *etched* addresses, not the originals: `vm.etch` copies code but not
    /// storage, so any state the tests read (`nonceUsed`) lives at the canonical address alone.
    function _installPermit2() internal returns (MockPermit2 permit2) {
        MockPermit2 permit2Impl = new MockPermit2();
        vm.etch(PERMIT2_ADDR, address(permit2Impl).code);
        permit2 = MockPermit2(PERMIT2_ADDR);

        MockX402ExactPermit2Proxy proxyImpl = new MockX402ExactPermit2Proxy();
        vm.etch(X402_PROXY_ADDR, address(proxyImpl).code);
    }

    /// @dev Replaces the proxy with one that under-delivers, leaving Permit2 itself intact.
    function _installLyingProxy() internal returns (LyingProxy lying) {
        LyingProxy impl = new LyingProxy();
        vm.etch(X402_PROXY_ADDR, address(impl).code);
        lying = LyingProxy(X402_PROXY_ADDR);
    }

    /// @dev Grants Permit2 the one-time token approval the real singleton requires of a payer.
    function _approvePermit2(address tokenContract, address payer_) internal {
        vm.prank(payer_);
        MockERC20(tokenContract).approve(PERMIT2_ADDR, type(uint256).max);
    }
}
