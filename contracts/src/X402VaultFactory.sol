// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {X402Vault} from "./X402Vault.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @title X402VaultFactory
/// @author emmo00 (https://github.com/emmo00)
/// @notice Factory contract for creating X402Vault instances for merchants. Each merchant can have one vault, which can be created by the merchant or an operator. The vault address is deterministic and can be predicted using the `vaultOf` function.
contract X402VaultFactory is Ownable {
    address public immutable implementation;
    address public operator;

    error InvalidAddress();
    error VaultExists();

    event VaultCreated(address indexed merchant, address indexed vault, address payout);
    event OperatorChanged(address indexed previousOperator, address indexed newOperator);

    constructor(address _owner, address _operator) {
        _initializeOwner(_owner);
        implementation = address(new X402Vault(address(this)));
        operator = _operator;
    }

    /// @dev Creates a new vault for the given merchant, with the given payout address.
    /// @param merchant The merchant address for which the vault is created.
    /// @param payout The payout address for the vault. If equal to the merchant, the merchant address will be used as the payout address.
    /// @return vault The address of the newly created vault.
    /// @notice The vault address is deterministic and can be predicted using the `vaultOf` function. The vault is created using the CREATE2 opcode, which allows for deterministic contract addresses. If a vault already exists for the given merchant, the function will revert with a `VaultExists` error. The function can only be called by the merchant or the operator.
    function createVault(address merchant, address payout) external returns (address vault) {
        if (merchant == address(0) || payout == address(0)) {
            revert InvalidAddress();
        }
        if (msg.sender != merchant && msg.sender != operator) {
            revert Unauthorized();
        }

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

    /// @dev Withdraw fees collected from vaults to the fee recipient.
    function withdrawFees(address[] calldata tokens, address feeRecipient) external onlyOwner {
        if (feeRecipient == address(0)) revert InvalidAddress();

        for (uint256 i; i < tokens.length;) {
            SafeTransferLib.safeTransfer(tokens[i], feeRecipient, SafeTransferLib.balanceOf(tokens[i], address(this)));
            unchecked {
                ++i;
            }
        }
    }

    /// @dev Rotates the operator (the x402Go server wallet). The owner is the recovery path if
    /// the operator key is lost or compromised: rotating it immediately moves every vault's
    /// withdrawal rights to the new address.
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert InvalidAddress();

        emit OperatorChanged(operator, newOperator);
        operator = newOperator;
    }

    function _salt(address merchant) private pure returns (bytes32) {
        return bytes32(uint256(uint160(merchant)));
    }
}
