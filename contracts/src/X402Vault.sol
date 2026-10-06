// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IX402VaultFactory} from "./interfaces/IX402VaultFactory.sol";
import {EIP712} from "solady/utils/EIP712.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";

/// @title X402Vault
/// @author emmo00 (https://github.com/emmo00)
/// @notice A vault for managing payments for a specific merchant.
contract X402Vault is EIP712 {
    bytes32 private constant CHANGE_PAYOUT_TYPEHASH =
        keccak256("ChangePayout(address newPayout,uint256 nonce,uint256 deadline)");

    address private immutable FACTORY;

    // Packed into one slot: payout override + replay nonce
    address private _payout;
    uint96 public nonce;

    error Unauthorized();
    error InvalidAddress();
    error LengthMismatch();
    error InvalidSignature();
    error AlreadyInitialized();

    event PayoutChanged(address indexed merchant, address indexed newPayout);
    event Withdrawn(address indexed merchant, address indexed token, uint256 merchantAmount, uint256 feeAmount);

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

    /// @dev One-shot: the factory may set the initial payout exactly once, at creation.
    /// A zero address is rejected so the slot cannot be left "uninitialised" (which would
    /// keep the one-shot guard open and let the payout be set again later).
    function initPayout(address p) external {
        if (msg.sender != FACTORY) revert Unauthorized();
        if (p == address(0)) revert InvalidAddress();
        if (_payout != address(0)) revert AlreadyInitialized(); // one-shot
        _payout = p;
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

    /// @dev Withdraws tokens from the vault: merchant funds to the merchant's payout address,
    /// accumulated fees to the immutable fee recipient (the factory). Both legs are executed
    /// in the same transaction, so a failure anywhere reverts the whole withdrawal. Can only
    /// be called by the operator of the factory.
    /// The event records the *merchant* (the vault's identity) and the scheduled amounts. The
    /// destination is not duplicated in the log: it is `payout()` as of this block, and the
    /// emitting contract is the vault itself, so an indexer can resolve both.
    /// @param tokens The list of token addresses to withdraw.
    /// @param merchantAmounts The list of amounts to withdraw to the merchant payout address.
    /// @param feeAmounts The list of amounts to withdraw to the fee recipient (the factory).
    function withdraw(address[] calldata tokens, uint256[] calldata merchantAmounts, uint256[] calldata feeAmounts)
        external
    {
        if (msg.sender != IX402VaultFactory(FACTORY).operator()) revert Unauthorized();

        uint256 len = tokens.length;
        if (len != merchantAmounts.length || len != feeAmounts.length) revert LengthMismatch();

        address to = payout(); // read once
        address m = merchant(); // read once; the event's identity field, not the destination

        for (uint256 i; i < len; ++i) {
            address token = tokens[i];
            uint256 mAmount = merchantAmounts[i];
            uint256 f = feeAmounts[i];
            if (mAmount != 0) SafeTransferLib.safeTransfer(token, to, mAmount);
            if (f != 0) SafeTransferLib.safeTransfer(token, FACTORY, f);
            emit Withdrawn(m, token, mAmount, f);
        }
    }

    function tokenBalance(address token) external view returns (uint256) {
        return SafeTransferLib.balanceOf(token, address(this));
    }

    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("X402Vault", "1");
    }
}
