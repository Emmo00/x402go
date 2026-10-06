// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {X402Vault} from "../../src/X402Vault.sol";
import {X402VaultFactory} from "../../src/X402VaultFactory.sol";
import {MockERC20} from "./Mocks.sol";

abstract contract X402Base is Test {
    uint256 internal constant SECP_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    bytes32 internal constant CHANGE_PAYOUT_TYPEHASH =
        keccak256("ChangePayout(address newPayout,uint256 nonce)");

    X402VaultFactory internal factory;
    MockERC20 internal token;

    address internal owner;
    address internal operator;
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

        factory = new X402VaultFactory(owner);
        vm.prank(owner);
        factory.setOperator(operator);

        token = new MockERC20();
    }

    // ---------------------------------------------------------------- helpers

    function _boundPk(uint256 pk) internal pure returns (uint256) {
        return bound(pk, 1, SECP_N - 1);
    }

    function _deploy(address m, address p) internal returns (address v) {
        vm.prank(operator);
        v = factory.createVault(m, p);
    }

    function _domainSeparator(address vault_) internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256("X402Vault"),
                    keccak256("1"),
                    block.chainid,
                    vault_
                )
            );
    }

    function _digest(
        address vault_,
        address newPayout,
        uint256 nonce
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(CHANGE_PAYOUT_TYPEHASH, newPayout, nonce)
        );
        return
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    _domainSeparator(vault_),
                    structHash
                )
            );
    }

    function _rsv(
        uint256 pk,
        address vault_,
        address newPayout,
        uint256 nonce
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        (v, r, s) = vm.sign(pk, _digest(vault_, newPayout, nonce));
    }

    function _sig(
        uint256 pk,
        address vault_,
        address newPayout,
        uint256 nonce
    ) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = _rsv(pk, vault_, newPayout, nonce);
        return abi.encodePacked(r, s, v);
    }

    /// @dev EIP-2098 64-byte compact signature.
    function _compactSig(
        uint256 pk,
        address vault_,
        address newPayout,
        uint256 nonce
    ) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = _rsv(pk, vault_, newPayout, nonce);
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
}
