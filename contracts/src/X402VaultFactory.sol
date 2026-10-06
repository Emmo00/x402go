// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "solady/auth/Ownable.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {X402Vault} from "./X402Vault.sol";

contract X402VaultFactory is Ownable {
    address public immutable implementation;
    address public operator;

    error InvalidAddress();
    error VaultExists();

    event VaultCreated(address indexed merchant, address indexed vault, address payout);

    constructor(address _owner) {
        _initializeOwner(_owner);
        implementation = address(new X402Vault(address(this)));
    }

    function createVault(address merchant, address payout) external returns (address vault) {
        if (merchant == address(0) || payout == address(0)) revert InvalidAddress();
        if (msg.sender != merchant && msg.sender != operator) revert Unauthorized();

        bytes memory args = abi.encodePacked(merchant);
        bytes32 salt = _salt(merchant);

        // A CREATE2 collision burns all forwarded gas, so fail cleanly first.
        if (LibClone.predictDeterministicAddress(implementation, args, salt, address(this)).code.length != 0) {
            revert VaultExists();
        }

        vault = LibClone.cloneDeterministic(implementation, args, salt);

        if (payout != merchant) X402Vault(vault).initPayout(payout);

        emit VaultCreated(merchant, vault, payout);
    }

    /// @dev Returns the deterministic address whether or not it has been deployed yet.
    function vaultOf(address merchant) external view returns (address) {
        return LibClone.predictDeterministicAddress(
            implementation, abi.encodePacked(merchant), _salt(merchant), address(this)
        );
    }

    function setOperator(address newOperator) external onlyOwner {
        operator = newOperator;
    }

    function _salt(address merchant) private pure returns (bytes32) {
        return bytes32(uint256(uint160(merchant)));
    }
}