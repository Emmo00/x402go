// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPermit2} from "./IPermit2.sol";
import {IX402ExactPermit2Proxy} from "./IX402ExactPermit2Proxy.sol";

interface IX402Vault {
    /// @dev An EIP-3009 `TransferWithAuthorization` payload, signed by the payer.
    struct Eip3009Authorization {
        address from;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    error Unauthorized();
    error AmountBelowFee();
    error InvalidAddress();
    error SignatureExpired();
    error InvalidSignature();
    error InvalidRecipient();
    error TokenNotSupported();
    error AmountNotReceived();
    error AlreadyInitialized();

    event PayoutChanged(address indexed merchant, address indexed newPayout);
    event Settle(
        address indexed payout, address indexed token, address indexed payer, uint256 merchantAmount, uint256 feeAmount
    );

    function merchant() external view returns (address);

    function payout() external view returns (address);

    function nonce() external view returns (uint96);

    function initPayout(address p) external;

    function settle(address token, Eip3009Authorization calldata auth) external;

    function settleWithPermit2(
        IPermit2.PermitTransferFrom calldata permit,
        address from,
        IX402ExactPermit2Proxy.Witness calldata witness,
        bytes calldata signature
    ) external;

    function changePayout(address newPayout, uint256 deadline, bytes calldata signature) external;
}
