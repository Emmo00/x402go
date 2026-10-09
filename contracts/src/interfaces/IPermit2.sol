// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev The slice of the canonical Permit2 singleton (`0x000000000022D473030F116dDEE9F6B43aC78BA3`)
interface IPermit2 {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }
}
