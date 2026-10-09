// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IX402Vault} from "../../src/interfaces/IX402Vault.sol";
import {X402Vault} from "../../src/X402Vault.sol";
import {X402VaultFactory} from "../../src/X402VaultFactory.sol";
import {MockERC20, MockPermit2} from "./Mocks.sol";

abstract contract X402Base is Test {
    uint256 internal constant SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    bytes32 internal constant CHANGE_PAYOUT_TYPEHASH =
        keccak256("ChangePayout(address newPayout,uint256 nonce,uint256 deadline)");

    X402VaultFactory internal factory;
    MockERC20 internal token;

    address internal owner;
    address internal operator;
    /// @dev Where the factory owner sends fees once they have accumulated in the factory.
    address internal feeRecipient;
    address internal stranger;

    uint256 internal merchantPk;
    address internal merchant;

    function setUp() public virtual {
        owner = makeAddr("owner");
        operator = makeAddr("operator");
        feeRecipient = makeAddr("feeRecipient");
        stranger = makeAddr("stranger");
        merchantPk = 0xA11CE;
        merchant = vm.addr(merchantPk);

        factory = new X402VaultFactory(owner, operator);

        token = new MockERC20();
    }

    // ---------------------------------------------------------------- helpers

    function _boundPk(uint256 pk) internal pure returns (uint256) {
        return bound(pk, 1, SECP_N - 1);
    }

    /// @dev A signature deadline comfortably in the future.
    function _deadline() internal view returns (uint256) {
        return block.timestamp + 1 days;
    }

    function _deploy(address m, address p) internal returns (address v) {
        vm.prank(operator);
        v = factory.createVault(m, p);
    }

    function _domainSeparator(address vault_) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("X402Vault"),
                keccak256("1"),
                block.chainid,
                vault_
            )
        );
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

    function _arr(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function _arr(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    // ------------------------------------------------ settlement payload helpers

    bytes32 internal constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 internal constant PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );

    /// @dev Mirrors the EIP-712 domain of the mock token ("Mock"/"1").
    function _tokenDomain(address tokenContract) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Mock"),
                keccak256("1"),
                block.chainid,
                tokenContract
            )
        );
    }

    function _tokenDigest(
        address tokenContract,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 authNonce
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                _tokenDomain(tokenContract),
                keccak256(
                    abi.encode(
                        TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, authNonce
                    )
                )
            )
        );
    }

    /// @dev A signed EIP-3009 payload paying `to`, valid now and for a day.
    ///
    /// Written into the return struct a field at a time rather than through locals: the legacy
    /// codegen is used here (`via_ir` is off), and a handful of extra live locals is enough to
    /// push the `vm.sign` call past the 16-slot stack limit.
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

        {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(
                pk, _tokenDigest(tokenContract, auth.from, to, value, auth.validAfter, auth.validBefore, authNonce)
            );

            auth.v = v;
            auth.r = r;
            auth.s = s;
        }
    }

    /// @dev Mirrors the Permit2 singleton's domain.
    function _permit2Domain(address permit2Contract) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Permit2"),
                keccak256("1"),
                block.chainid,
                permit2Contract
            )
        );
    }

    /// @dev The Permit2 SignatureTransfer digest, binding `spender` the way the real singleton
    /// binds it: to whoever calls `permitTransferFrom`, which is the vault.
    function _permit2Digest(
        address permit2Contract,
        address spender,
        address tokenContract,
        uint256 amount,
        uint256 permitNonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                _permit2Domain(permit2Contract),
                keccak256(
                    abi.encode(
                        PERMIT_TRANSFER_FROM_TYPEHASH,
                        keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, tokenContract, amount)),
                        spender,
                        permitNonce,
                        deadline
                    )
                )
            )
        );
    }

    /// @dev A signed Permit2 payload. `spender` must be the vault that will settle it.
    function _permit2Auth(
        uint256 pk,
        address permit2Contract,
        address spender,
        address tokenContract,
        uint256 amount,
        uint256 permitNonce
    ) internal view returns (IX402Vault.Permit2Authorization memory auth, bytes memory signature) {
        auth.from = vm.addr(pk);
        auth.value = amount;
        auth.nonce = permitNonce;
        auth.deadline = block.timestamp + 1 days;

        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, _permit2Digest(permit2Contract, spender, tokenContract, amount, permitNonce, auth.deadline));

        signature = abi.encodePacked(r, s, v);
    }

    /// @dev Installs the Permit2 stand-in at the canonical address, so the vault's hardcoded
    /// `SafeTransferLib.PERMIT2` resolves to it.
    ///
    /// Returns a handle on the *etched* address, not the original deployment: `vm.etch` copies
    /// code but not storage, so any state the tests read (`nonceUsed`) lives at the canonical
    /// address and nowhere else.
    function _installPermit2() internal returns (MockPermit2 permit2) {
        MockPermit2 impl = new MockPermit2();
        vm.etch(SafeTransferLib.PERMIT2, address(impl).code);
        permit2 = MockPermit2(SafeTransferLib.PERMIT2);
    }

    /// @dev Grants Permit2 the one-time token approval the real singleton requires of a payer.
    function _approvePermit2(MockERC20 t, address payer) internal {
        vm.prank(payer);
        t.approve(SafeTransferLib.PERMIT2, type(uint256).max);
    }
}
