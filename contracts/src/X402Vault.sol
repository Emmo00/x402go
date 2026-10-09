// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC3009} from "./interfaces/IERC3009.sol";
import {IPermit2} from "./interfaces/IPermit2.sol";
import {IX402Vault} from "./interfaces/IX402Vault.sol";
import {IX402VaultFactory} from "./interfaces/IX402VaultFactory.sol";
import {IX402ExactPermit2Proxy} from "./interfaces/IX402ExactPermit2Proxy.sol";
import {EIP712} from "solady/utils/EIP712.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";

/// @title X402Vault
/// @author emmo00 (https://github.com/emmo00)
/// @notice A vault for managing x402 payment settlement for a merchant.
contract X402Vault is IX402Vault, EIP712 {
    bytes32 private constant CHANGE_PAYOUT_TYPEHASH =
        keccak256("ChangePayout(address newPayout,uint256 nonce,uint256 deadline)");

    address private immutable FACTORY;
    IX402ExactPermit2Proxy private constant X402_PROXY =
        IX402ExactPermit2Proxy(0x402085c248EeA27D92E8b30b2C58ed07f9E20001);

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

    /// @dev Settles one payment authorised with EIP-3009.
    /// @param token The token being paid in. Must be configured in the factory (`tokenFeeBPS > 0`).
    /// @param auth The payer's signed `TransferWithAuthorization`.
    function settle(address token, Eip3009Authorization calldata auth) external {
        uint256 fee = _feeFor(token);

        if (auth.value <= fee) revert AmountBelowFee();

        IERC3009(token)
            .transferWithAuthorization(
                auth.from,
                address(this),
                auth.value,
                auth.validAfter,
                auth.validBefore,
                auth.nonce,
                auth.v,
                auth.r,
                auth.s
            );

        _split(token, auth.from, auth.value, fee);
    }

    /// @dev Settles one payment authorised with Permit2's SignatureTransfer.
    /// @param permit The payer's signed `PermitTransferFrom`.
    /// @param from The payer's address, which must match `permit.permitted.from`.
    /// @param witness The witness data for the Permit2 transfer, which must have `to == address(this)`.
    /// @param signature The payer's signature over the permit and witness.
    function settleWithPermit2(
        IPermit2.PermitTransferFrom calldata permit,
        address from,
        IX402ExactPermit2Proxy.Witness calldata witness,
        bytes calldata signature
    ) external {
        // Required: otherwise the proxy pays someone else and `_split` pays out of whatever the vault already holds.
        if (witness.to != address(this)) revert InvalidRecipient();

        address token = permit.permitted.token;
        uint256 value = permit.permitted.amount;

        uint256 fee = _feeFor(token);
        if (value <= fee) revert AmountBelowFee();

        uint256 balanceBefore = SafeTransferLib.balanceOf(token, address(this));

        X402_PROXY.settle(permit, from, witness, signature);

        if (SafeTransferLib.balanceOf(token, address(this)) < balanceBefore + value) {
            revert AmountNotReceived();
        }

        _split(token, from, value, fee);
    }

    /// @dev Changes the payout address of the vault. Authorised by the merchant
    /// @param newPayout The new payout address.
    /// @param _deadline The deadline for the signature.
    /// @param signature The signature of the merchant.
    function changePayout(address newPayout, uint256 _deadline, bytes calldata signature) external {
        if (newPayout == address(0)) revert InvalidAddress();

        uint96 n = nonce;
        uint256 deadline = _deadline;

        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert SignatureExpired();

        bytes32 digest = _hashTypedData(keccak256(abi.encode(CHANGE_PAYOUT_TYPEHASH, newPayout, uint256(n), deadline)));

        if (!SignatureCheckerLib.isValidSignatureNowCalldata(merchant(), digest, signature)) {
            revert InvalidSignature();
        }

        _payout = newPayout;
        nonce = n + 1;

        emit PayoutChanged(merchant(), newPayout);
    }

    /// @dev Emergency recovery for tokens that reached the vault outside `settle`.
    function rescue(address token) external {
        IX402VaultFactory factory = IX402VaultFactory(FACTORY);
        uint256 bal = SafeTransferLib.balanceOf(token, address(this));
        uint256 fee = factory.tokenFeeBPS(token) == 0 ? 0 : factory.tokenFee(token);

        if (bal <= fee) revert AmountBelowFee();
        _split(token, address(0), bal, fee);
    }

    /// @dev The fee for `token`, refusing any token the factory has not configured.
    function _feeFor(address token) private view returns (uint256 fee) {
        IX402VaultFactory factory = IX402VaultFactory(FACTORY);

        if (factory.tokenFeeBPS(token) == 0) revert TokenNotSupported();

        fee = factory.tokenFee(token);

        if (fee == 0) revert TokenNotSupported();
    }

    /// @dev Splits `value` — the amount just collected from `payer` — between the merchant and the factory
    function _split(address token, address payer, uint256 value, uint256 fee) private {
        uint256 merchantAmount = value - fee;
        address payoutAddress = payout();

        SafeTransferLib.safeTransfer(token, payoutAddress, merchantAmount);
        SafeTransferLib.safeTransfer(token, FACTORY, fee);

        emit Settle(payoutAddress, token, payer, merchantAmount, fee);
    }

    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("X402Vault", "1");
    }
}
