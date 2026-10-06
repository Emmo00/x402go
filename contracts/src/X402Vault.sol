// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LibClone} from "solady/utils/LibClone.sol";
import {EIP712} from "solady/utils/EIP712.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";
import {IX402VaultFactory} from "./interfaces/IX402VaultFactory.sol";

contract X402Vault is EIP712 {
    bytes32 private constant CHANGE_PAYOUT_TYPEHASH = keccak256("ChangePayout(address newPayout,uint256 nonce)");

    address private immutable FACTORY;

    // Packed into one slot: payout override + replay nonce
    address private _payout;
    uint96 public nonce;

    error Unauthorized();
    error InvalidAddress();
    error LengthMismatch();
    error InvalidSignature();

    constructor(address factory_) {
        FACTORY = factory_;
    }

    /// @dev Immutable clone arg, read from the clone's bytecode.
    function merchant() public view returns (address) {
        return address(bytes20(LibClone.argsOnClone(address(this), 0, 20)));
    }

    function payout() public view returns (address p) {
        p = _payout;
        if (p == address(0)) p = merchant();
    }

    function initPayout(address p) external {
        if (msg.sender != FACTORY) revert Unauthorized();
        _payout = p;
    }

    function changePayout(address newPayout, bytes calldata signature) external {
        if (newPayout == address(0)) revert InvalidAddress();

        uint96 n = nonce;
        bytes32 digest = _hashTypedData(keccak256(abi.encode(CHANGE_PAYOUT_TYPEHASH, newPayout, uint256(n))));

        if (!SignatureCheckerLib.isValidSignatureNowCalldata(merchant(), digest, signature)) {
            revert InvalidSignature();
        }

        _payout = newPayout;
        nonce = n + 1;
    }

    function withdrawAll(
        address[] calldata tokens,
        uint256[] calldata merchantAmounts,
        uint256[] calldata feeAmounts,
        address feeRecipient
    ) external {
        if (msg.sender != IX402VaultFactory(FACTORY).operator()) revert Unauthorized();
        if (feeRecipient == address(0)) revert InvalidAddress();

        uint256 len = tokens.length;
        if (len != merchantAmounts.length || len != feeAmounts.length) revert LengthMismatch();

        address to = payout(); // read once

        for (uint256 i; i < len; ++i) {
            address token = tokens[i];
            uint256 m = merchantAmounts[i];
            uint256 f = feeAmounts[i];
            if (m != 0) SafeTransferLib.safeTransfer(token, to, m);
            if (f != 0) SafeTransferLib.safeTransfer(token, feeRecipient, f);
        }
    }

    function tokenBalance(address token) external view returns (uint256) {
        return SafeTransferLib.balanceOf(token, address(this));
    }

    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("X402Vault", "1");
    }
}
