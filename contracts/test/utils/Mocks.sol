// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "solady/tokens/ERC20.sol";
import {ECDSA} from "solady/utils/ECDSA.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {IERC3009} from "../../src/interfaces/IERC3009.sol";
import {IPermit2} from "../../src/interfaces/IPermit2.sol";

/// @dev Well-behaved ERC20 that also implements EIP-3009.
///
/// One token serves both settlement paths: EIP-3009 uses `transferWithAuthorization`, and the
/// Permit2 path merely needs a normal `transferFrom`. Inheriting {IERC3009} rather than
/// hand-copying the signature keeps this ABI identical to the one the vault calls.
contract MockERC20 is ERC20, IERC3009 {
    bytes32 internal constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// @dev EIP-3009 nonces that have been used. Public so it satisfies {IERC3009}.
    mapping(address authorizer => mapping(bytes32 nonce => bool used)) public authorizationState;

    function name() public pure override returns (string memory) {
        return "Mock";
    }

    function symbol() public pure override returns (string memory) {
        return "MCK";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev The EIP-712 domain a payer signs over.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name())),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

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
    ) external {
        // The validity window is the thing under test, so comparing against the clock is the point
        // here — this mirrors the real token's behaviour, it does not guard value.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= validAfter) revert("authorization not yet valid");
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= validBefore) revert("authorization expired");
        if (authorizationState[from][nonce]) revert("authorization already used");

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                domainSeparator(),
                keccak256(
                    abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
                )
            )
        );

        if (ECDSA.recover(digest, v, r, s) != from) revert("invalid authorization signature");

        authorizationState[from][nonce] = true;

        _transfer(from, to, value);
    }
}

/// @dev Pulls correctly — EIP-3009 goes through `_transfer` — but refuses to pay out, so it is the
/// split leg that fails, not the collection. A settlement that has already collected must revert
/// entirely rather than half-apply.
contract FalsePayoutToken is MockERC20 {
    function transfer(address, uint256) public pure override returns (bool) {
        return false;
    }
}

/// @dev As {FalsePayoutToken}, but reverts instead of returning false.
contract RevertingPayoutToken is MockERC20 {
    function transfer(address, uint256) public pure override returns (bool) {
        revert("no payouts today");
    }
}

/// @dev Few enough decimals that a small `tokenFeeBPS` computes a fee of zero — the case the
/// vault's second fee check exists for.
contract LowDecimalToken is MockERC20 {
    function decimals() public pure override returns (uint8) {
        return 2;
    }
}

/// @dev Skims 1% on every move, so the vault receives less than the amount the authorization
/// named. The split then cannot cover the amount it owes and must revert the whole settlement.
///
/// `transfer` is overridden alongside `_transfer` on purpose: Solady's public `transfer` writes
/// balances with inline assembly and never reaches `_transfer`, so a mock that only overrode
/// `_transfer` would skim the EIP-3009 collection and nothing else — which is exactly the
/// misleading shape this mock exists to avoid. `transferFrom` is left alone because no test routes
/// this token through Permit2.
contract FeeOnTransferToken is MockERC20 {
    address public constant SINK = address(0xFEE);

    function transfer(address to, uint256 amount) public override returns (bool) {
        _skim(msg.sender, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        _skim(from, to, amount);
    }

    /// @dev Sends 1% to {SINK} and the rest to `to`, so `to` receives less than `amount`.
    function _skim(address from, address to, uint256 amount) internal {
        uint256 cut = amount / 100;
        if (cut != 0) super._transfer(from, SINK, cut);
        super._transfer(from, to, amount - cut);
    }
}

/// @dev ERC20 that re-enters the vault during a payout leg, with a caller-supplied payload.
/// `transfer` is the hook that matters: the vault pays out with the public `transfer`, while its
/// EIP-3009 collection goes through `_transfer`.
///
/// It fires exactly **once** and never rearms on its own. A settlement makes two payout legs, so a
/// latch that reset itself would re-enter again on the fee leg — with the same payload, whose
/// authorization has by then been consumed — and revert the settlement for the wrong reason.
contract ReentrantToken is MockERC20 {
    address public target;
    bytes public payload;
    bool internal fired;

    function arm(address t, bytes calldata data) external {
        target = t;
        payload = data;
        fired = false;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (target != address(0) && !fired) {
            fired = true;
            (bool ok, bytes memory ret) = target.call(payload);

            // Bubble the inner failure up, so a test that expects the re-entry to succeed fails
            // with the inner reason rather than a bare revert.
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }

        return super.transfer(to, amount);
    }
}

/// @dev USDT-style token: `transfer` returns nothing.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount; // underflow reverts
        balanceOf[to] += amount;
    }
}

/// @dev Token whose `transfer` returns false instead of reverting.
contract FalseReturnToken {
    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @dev Token whose `transfer` always reverts.
contract RevertingToken {
    function transfer(address, uint256) external pure returns (bool) {
        revert("nope");
    }
}

/// @dev A stand-in for the canonical Permit2 singleton, installed at the real address with
/// `vm.etch`, so the vault's hardcoded `SafeTransferLib.PERMIT2` resolves to it.
///
/// It mirrors the real SignatureTransfer closely enough for these tests to mean something: the
/// same struct ABI (via {IPermit2}), the same EIP-712 domain and typehashes, one-shot nonces, a
/// deadline, and — the part that matters most — `msg.sender` bound into the digest as the spender,
/// so the payer's signature genuinely authorises one vault and not another.
contract MockPermit2 is IPermit2 {
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");

    bytes32 internal constant PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );

    mapping(address owner => mapping(uint256 nonce => bool used)) public nonceUsed;

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Permit2"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function permitTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external {
        // As with the EIP-3009 mock, the deadline is the behaviour under test.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > permit.deadline) {
            revert("signature expired");
        }
        if (nonceUsed[owner][permit.nonce]) revert("nonce already used");
        if (transferDetails.requestedAmount > permit.permitted.amount) {
            revert("amount exceeds permitted");
        }

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                domainSeparator(),
                keccak256(
                    abi.encode(
                        PERMIT_TRANSFER_FROM_TYPEHASH,
                        keccak256(
                            abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted.token, permit.permitted.amount)
                        ),
                        msg.sender,
                        permit.nonce,
                        permit.deadline
                    )
                )
            )
        );

        if (ECDSA.recover(digest, signature) != owner) revert("invalid permit signature");

        nonceUsed[owner][permit.nonce] = true;

        // Pulls with the token's own `transferFrom`, so `owner` must have approved Permit2 —
        // exactly the one-time approval the real singleton requires.
        SafeTransferLib.safeTransferFrom(
            permit.permitted.token, owner, transferDetails.to, transferDetails.requestedAmount
        );
    }
}

/// @dev ERC-1271 wallet that approves exactly one hash.
contract Mock1271Wallet {
    bytes32 public approvedHash;
    bytes4 public magic = 0x1626ba7e;

    function approve(bytes32 h) external {
        approvedHash = h;
    }

    function setMagic(bytes4 m) external {
        magic = m;
    }

    function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4) {
        return hash == approvedHash ? magic : bytes4(0xffffffff);
    }
}

/// @dev ERC-1271 wallet whose validation always reverts.
contract Reverting1271Wallet {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        revert("boom");
    }
}
