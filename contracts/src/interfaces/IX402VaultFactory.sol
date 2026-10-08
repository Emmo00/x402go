// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IX402VaultFactory {
    error VaultExists();
    error InvalidAddress();
    error LengthMismatch();

    event VaultCreated(address indexed merchant, address indexed vault, address payout);
    event OperatorChanged(address indexed previousOperator, address indexed newOperator);
    event FeeUpdated(address indexed token, uint16 newFee);

    function operator() external view returns (address);

    function tokenFee(address token) external view returns (uint256);
}
