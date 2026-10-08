// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IX402Vault} from "./interfaces/IX402Vault.sol";
import {IX402VaultFactory} from "./interfaces/IX402VaultFactory.sol";
import {EIP712} from "solady/utils/EIP712.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";

/// @title X402Vault
/// @author emmo00 (https://github.com/emmo00)
/// @notice A vault for managing payments for a specific merchant.
contract X402Vault is IX402Vault, EIP712 {
    bytes32 private constant CHANGE_PAYOUT_TYPEHASH =
        keccak256("ChangePayout(address newPayout,uint256 nonce,uint256 deadline)");

    address private immutable FACTORY;

    // Packed into one slot: payout override + replay nonce
    address private _payout;
    uint96 public nonce;

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

    /// @dev Initializes the payout address for the vault. Can only be called once, by the factory.
    function initPayout(address p) external {
        if (msg.sender != FACTORY) revert Unauthorized();
        if (p == address(0)) revert InvalidAddress();
        if (_payout != address(0)) revert AlreadyInitialized(); // one-shot
        _payout = p;
    }

    function settle(address token) external {
        uint256 balance = SafeTransferLib.balanceOf(token, address(this));
        uint256 fee = IX402VaultFactory(FACTORY).tokenFee(token);

        if(balance < fee) revert InsufficientBalance();

        uint256 merchantAmount = balance - fee;
        address payoutAddress = payout();

        SafeTransferLib.safeTransfer(token, payoutAddress, merchantAmount);
        SafeTransferLib.safeTransfer(token, FACTORY, fee);

        emit Settle(payoutAddress, token, merchantAmount, fee);
    }

    /// @dev Changes the payout address of the vault. Authorised by the merchant, not by the
    /// x402Go operator: the operator can never redirect merchant funds, only the merchant can
    /// move where their own payouts land.
    /// @param newPayout The new payout address.
    /// @param _deadline The deadline for the signature.
    /// @param signature The signature of the merchant.
    function changePayout(address newPayout, uint256 _deadline, bytes calldata signature) external {
        if (newPayout == address(0)) revert InvalidAddress();

        uint96 n = nonce;
        uint256 deadline = _deadline;

        // The merchant commits to this deadline in the signature, so a validator nudging the
        // clock by a few seconds only moves the boundary of a window the merchant chose.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert InvalidSignature();

        bytes32 digest = _hashTypedData(keccak256(abi.encode(CHANGE_PAYOUT_TYPEHASH, newPayout, uint256(n), deadline)));

        if (!SignatureCheckerLib.isValidSignatureNowCalldata(merchant(), digest, signature)) {
            revert InvalidSignature();
        }

        _payout = newPayout;
        nonce = n + 1;

        emit PayoutChanged(merchant(), newPayout);
    }

    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("X402Vault", "1");
    }
}
