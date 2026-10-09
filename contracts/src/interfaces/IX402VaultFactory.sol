// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IX402VaultFactory {
    error VaultExists();
    error InvalidAddress();
    error LengthMismatch();

    event VaultCreated(address indexed merchant, address indexed vault, address payout);
    event FeeUpdated(address indexed token, uint16 newFee);
    event FeesWithdrawn(address indexed token, address indexed recipient, uint256 amount);

    function tokenFee(address token) external view returns (uint256);

    /// @dev The configured fee for `token`, in basis points. Zero means the token is not
    /// supported, and a vault will refuse to settle it.
    function tokenFeeBPS(address token) external view returns (uint16);
}
