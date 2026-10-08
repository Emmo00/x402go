// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IX402Vault {
    error Unauthorized();
    error InvalidAddress();
    error LengthMismatch();
    error InvalidSignature();
    error AlreadyInitialized();
    error InsufficientBalance();

    event PayoutChanged(address indexed merchant, address indexed newPayout);
    event Settle(address indexed payout, address indexed token, uint256 merchantAmount, uint256 feeAmount);
}
