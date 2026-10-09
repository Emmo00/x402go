// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev The EIP-3009 surface a settlement needs. The token contract verifies the
/// signature itself, so a vault never has to: it can only ever move an amount the
/// payer signed for, to the recipient the payer named.
interface IERC3009 {
    /// @dev Moves `value` from `from` to `to` if `signature` authorises it. Reverts if the
    /// signature is invalid, the authorization has already been used, or the window
    /// [`validAfter`, `validBefore`] does not cover the current block.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /// @dev Whether `authorizer`'s authorization with `nonce` has been used or cancelled.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
