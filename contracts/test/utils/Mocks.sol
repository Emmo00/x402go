// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "solady/tokens/ERC20.sol";
import {ECDSA} from "solady/utils/ECDSA.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {IERC3009} from "../../src/interfaces/IERC3009.sol";
import {IPermit2} from "../../src/interfaces/IPermit2.sol";
import {IX402ExactPermit2Proxy} from "../../src/interfaces/IX402ExactPermit2Proxy.sol";

/// @dev The canonical Permit2 singleton address. Also `SafeTransferLib.PERMIT2`, restated here so
/// the mocks do not have to reach into solady for a constant.
address constant PERMIT2_ADDR = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

/// @dev The canonical x402 `x402ExactPermit2Proxy` address the vault hardcodes.
address constant X402_PROXY_ADDR = 0x402085c248EeA27D92E8b30b2C58ed07f9E20001;

/// @dev A generic EIP-712 domain typehash *with* a version field, which is what the mock tokens
/// below use for their own EIP-3009 domain. Not Permit2's — see {PERMIT2_DOMAIN_TYPEHASH}.
bytes32 constant EIP712_DOMAIN_TYPEHASH =
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

/// @dev Permit2's own EIP-712 domain typehash, which has **no `version` field**:
///
///     EIP712Domain(string name,uint256 chainId,address verifyingContract)
///
/// Verified against the deployed singleton rather than assumed. `DOMAIN_SEPARATOR()` on
/// `0x000000000022D473030F116dDEE9F6B43aC78BA3` on Celo Sepolia (chainid 11142220) returns
/// `0xbaf1db64d9a889ab0d72b38a5d51123137e21a45972de65e2f2494c0657a5da4`, which is
/// `keccak256(abi.encode(THIS_TYPEHASH, keccak256("Permit2"), 11142220, PERMIT2_ADDR))` —
/// `0x8cad95687ba82c2ce50e74f7b754645e5117c3a5bec8151c0726d5857980a866`. The four-field form
/// with `version = "1"` produces a different separator, and every signature built over it is
/// rejected by the real singleton. Suite H pins this; the fork suite checks it against the chain.
bytes32 constant PERMIT2_DOMAIN_TYPEHASH =
    keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");

bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");

bytes32 constant WITNESS_TYPEHASH = keccak256("Witness(address to,uint256 validAfter)");

/// @dev The witness type string the x402 proxy hands to Permit2, verbatim.
///
/// This is the tail of the primary type's EIP-712 `encodeType`, not a struct definition on its own:
/// Permit2 prepends `"PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256
/// nonce,uint256 deadline,"` to whatever it is given and appends nothing. So this string has to
/// declare the fifth *field* by name (`Witness witness`), close the primary type, and only then
/// append the two referenced struct definitions — in the alphabetical order EIP-712 requires.
///
/// Copied from the deployed proxy rather than reasoned out: calling `settle` on
/// `0x402085c248EeA27D92E8b30b2C58ed07f9E20001` at the real Permit2 and reading the trace shows
/// this exact string going across. A first draft wrote `"Witness(address to,uint256 validAfter)"`
/// here and let the mock append `")TokenPermissions(address token,uint256 amount)"`, which is not
/// valid EIP-712 at all — it inlines a struct definition where a field name belongs. The mock
/// happily accepted signatures built over it, so nothing local noticed; the real singleton
/// recovered a different signer and reverted `InvalidSigner()`. Suite H pins the resulting type
/// hash, and Suite M pins the whole thing against the live proxy.
string constant WITNESS_TYPE_STRING =
    "Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter)";

/// @dev The EIP-712 type hash for the primary type, which is `keccak256(PREFIX ++ WITNESS_TYPE_STRING)`
/// — i.e. of the canonical string
///
///     PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256
///     deadline,Witness witness)TokenPermissions(address token,uint256 amount)Witness(address
///     to,uint256 validAfter)
///
/// The hashed form is not what Permit2 takes (it takes the string, so a caller can extend the type
/// with its own witness), but it is the value our offline signing helpers and mocks must agree on,
/// so it is pinned here where both can see it.
bytes32 constant PERMIT2_WITNESS_TYPEHASH = keccak256(
    "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter)"
);

/// @dev Shared EIP-3009 digest. Free function rather than an inherited member because the two
/// tokens below have unrelated storage layouts and only agree on this one computation.
function _eip3009Digest(
    bytes32 domainSeparator,
    bytes32 typehash,
    address from,
    address to,
    uint256 value,
    uint256 validAfter,
    uint256 validBefore,
    bytes32 nonce
) pure returns (bytes32) {
    return keccak256(
        abi.encodePacked(
            "\x19\x01",
            domainSeparator,
            keccak256(abi.encode(typehash, from, to, value, validAfter, validBefore, nonce))
        )
    );
}

/// @dev Well-behaved ERC20 that also implements EIP-3009, with configurable decimals.
///
/// One token serves both settlement paths: EIP-3009 uses `transferWithAuthorization`, and the
/// Permit2 path merely needs an ordinary `transferFrom`. Inheriting {IERC3009} rather than
/// hand-copying the signature keeps this ABI identical to the one the vault calls.
contract MockERC20 is ERC20, IERC3009 {
    /// @dev Public so a test can pin it against the constant the signing helper uses, exactly as
    /// the real FiatTokenV2 exposes it.
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// @dev EIP-3009 nonces that have been used. Public so it satisfies {IERC3009}.
    mapping(address authorizer => mapping(bytes32 nonce => bool used)) public authorizationState;

    string private _name;
    string private _symbol;
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        _name = name_;
        _symbol = symbol_;
        _decimals = decimals_;
    }

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev The EIP-712 domain a payer signs over. Recomputed rather than cached so a test that
    /// moves the chain id with `vm.chainId` sees the domain move with it.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256(bytes(_name)), keccak256("1"), block.chainid, address(this))
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

        bytes32 digest = _eip3009Digest(
            domainSeparator(), TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce
        );

        if (ECDSA.recover(digest, v, r, s) != from) revert("invalid authorization signature");

        authorizationState[from][nonce] = true;

        _transfer(from, to, value);
    }
}

/// @dev ERC20 with no EIP-3009 surface at all, for the Permit2-only path and for the
/// "token does not implement what the vault calls" cases.
contract PlainERC20 is ERC20 {
    string private _name;
    string private _symbol;
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        _name = name_;
        _symbol = symbol_;
        _decimals = decimals_;
    }

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev USDT-style token: `transfer`, `transferFrom` and `approve` return nothing.
///
/// Written standalone rather than as a {MockERC20} override because Solidity will not let a
/// `returns (bool)` function be narrowed to no return value. It still implements the full EIP-3009
/// surface — the v,r,s `transferWithAuthorization` overload returns nothing in the standard, so a
/// no-return token is a perfectly settleable one.
contract UsdtStyleToken {
    string private _name;
    string private _symbol;
    uint8 private immutable _decimals;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address authorizer => mapping(bytes32 nonce => bool used)) public authorizationState;

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        _name = name_;
        _symbol = symbol_;
        _decimals = decimals_;
    }

    function name() external view returns (string memory) {
        return _name;
    }

    function symbol() external view returns (string memory) {
        return _symbol;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external {
        _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256(bytes(_name)), keccak256("1"), block.chainid, address(this))
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
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= validAfter) revert("authorization not yet valid");
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= validBefore) revert("authorization expired");
        if (authorizationState[from][nonce]) revert("authorization already used");

        bytes32 digest = _eip3009Digest(
            domainSeparator(), TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce
        );

        if (ECDSA.recover(digest, v, r, s) != from) revert("invalid authorization signature");

        authorizationState[from][nonce] = true;

        _move(from, to, value);
    }

    function _move(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount; // underflow reverts
        balanceOf[to] += amount;
    }
}

/// @dev Refuses to move tokens to a blacklisted recipient, on both entry points the vault uses.
///
/// `transfer` is overridden alongside `_transfer` on purpose: Solady's public `transfer` writes
/// balances with inline assembly and never reaches `_transfer`, so a mock that only overrode
/// `_transfer` would blacklist the EIP-3009 collection and nothing else.
contract BlacklistToken is MockERC20 {
    mapping(address => bool) public blacklisted;

    constructor() MockERC20("Blacklist", "BLK", 18) {}

    function setBlacklisted(address account, bool isBlacklisted) external {
        blacklisted[account] = isBlacklisted;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (blacklisted[to]) revert("blacklisted");
        return super.transfer(to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        if (blacklisted[to]) revert("blacklisted");
        super._transfer(from, to, amount);
    }
}

/// @dev Skims 1% on every move, so the vault receives less than the amount the authorization
/// named. The split then cannot cover the amount it owes and must revert the whole settlement.
///
/// Same reason as {BlacklistToken} for overriding both entry points.
contract FeeOnTransferToken is MockERC20 {
    address public constant SINK = address(0xFEE);

    constructor() MockERC20("FeeOnTransfer", "FOT", 18) {}

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

/// @dev ERC20 that re-enters a caller-supplied target during a payout leg, with a caller-supplied
/// payload. `transfer` is the hook that matters: the vault pays out with the public `transfer`,
/// while its EIP-3009 collection goes through `_transfer`.
///
/// It fires exactly **once** and never rearms on its own. A settlement makes two payout legs, so a
/// latch that reset itself would re-enter again on the fee leg — with the same payload, whose
/// authorization has by then been consumed — and revert the settlement for the wrong reason.
contract ReentrantToken is MockERC20 {
    address public target;
    bytes public payload;
    bool internal fired;

    constructor() MockERC20("Reentrant", "RE", 18) {}

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

/// @dev Collects correctly — EIP-3009 goes through `_transfer` — but refuses to pay out, so it is
/// the split leg that fails, not the collection. A settlement that has already collected must
/// revert entirely rather than half-apply.
contract FalsePayoutToken is MockERC20 {
    constructor() MockERC20("FalsePayout", "FLS", 18) {}

    function transfer(address, uint256) public pure override returns (bool) {
        return false;
    }
}

/// @dev As {FalsePayoutToken}, but reverts instead of returning false.
contract RevertingPayoutToken is MockERC20 {
    constructor() MockERC20("RevertingPayout", "REV", 18) {}

    function transfer(address, uint256) public pure override returns (bool) {
        revert("no payouts today");
    }
}

/// @dev The two functions the vault's Permit2 path reaches through the proxy. The repo's {IPermit2}
/// is deliberately minimal — it carries only the structs the vault names — so the witness-transfer
/// entry point lives here, in test code, rather than widening the production interface.
interface IPermit2Full is IPermit2 {
    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitWitnessTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;
}

/// @dev A stand-in for the canonical Permit2 singleton, installed at the real address with
/// `vm.etch` so the proxy's hardcoded Permit2 address resolves to it.
///
/// It mirrors the real SignatureTransfer closely enough for these tests to mean something: the
/// same struct ABI, the same EIP-712 domain, one-shot nonces, a deadline, the witness folded into
/// the type hash the way Permit2 does it — from the type *string*, not from a precomputed constant
/// — and, the part that matters most, `msg.sender` bound into the digest as the spender, so the
/// payer's signature genuinely authorises one proxy and not another.
contract MockPermit2 is IPermit2Full {
    /// @dev Permit2's own construction: a fixed prefix, the caller's witness type string, and
    /// nothing else. The caller's string carries the primary type's closing paren and the referenced
    /// struct definitions. Modelled from the deployed singleton rather than from the EIP-712 spec,
    /// because it is the singleton's behaviour that signatures have to satisfy.
    string internal constant TYPEHASH_PREFIX =
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";

    mapping(address owner => mapping(uint256 nonce => bool used)) public nonceUsed;

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(PERMIT2_DOMAIN_TYPEHASH, keccak256("Permit2"), block.chainid, address(this)));
    }

    /// @dev Exposed so a test can pin it against the constant the signing helper builds its digest
    /// from. The transfer path below derives its own copy from {WITNESS_TYPE_STRING}, so the two
    /// agreeing is a real check and not a tautology.
    function witnessTypehash() external pure returns (bytes32) {
        return PERMIT2_WITNESS_TYPEHASH;
    }

    function permitWitnessTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
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

        bytes32 typehash = keccak256(abi.encodePacked(TYPEHASH_PREFIX, witnessTypeString));

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                domainSeparator(),
                keccak256(
                    abi.encode(
                        typehash,
                        keccak256(
                            abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted.token, permit.permitted.amount)
                        ),
                        msg.sender,
                        permit.nonce,
                        permit.deadline,
                        witness
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

/// @dev A stand-in for the x402 `x402ExactPermit2Proxy`, installed at the canonical address, so the
/// vault's hardcoded `X402_PROXY` resolves to it.
///
/// The two behaviours the vault depends on are reproduced exactly: the proxy is what moves funds
/// to `witness.to` (so a wrong recipient is a wrong recipient even with a valid signature), and it
/// enforces `witness.validAfter`.
contract MockX402ExactPermit2Proxy is IX402ExactPermit2Proxy {
    address public constant PERMIT2 = PERMIT2_ADDR;

    string public constant WITNESS_TYPE_STRING_ = WITNESS_TYPE_STRING;

    function settle(
        IPermit2.PermitTransferFrom calldata permit,
        address owner,
        Witness calldata witness,
        bytes calldata signature
    ) external {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < witness.validAfter) revert("Too early");

        bytes32 witnessHash = keccak256(abi.encode(WITNESS_TYPEHASH, witness.to, witness.validAfter));

        IPermit2Full(PERMIT2)
            .permitWitnessTransferFrom(
                permit,
                IPermit2Full.SignatureTransferDetails({to: witness.to, requestedAmount: permit.permitted.amount}),
                owner,
                witnessHash,
                WITNESS_TYPE_STRING,
                signature
            );
    }
}

/// @dev A proxy that takes a valid signature and then does not deliver what it promised. Used to
/// prove the vault's balance-delta check, not the signature check, is what stops a short payment.
contract LyingProxy is IX402ExactPermit2Proxy {
    address public constant PERMIT2 = PERMIT2_ADDR;

    /// @dev 0 = deliver nothing, 1 = deliver half.
    uint256 public mode;

    function setMode(uint256 m) external {
        mode = m;
    }

    function settle(IPermit2.PermitTransferFrom calldata permit, address owner, Witness calldata, bytes calldata)
        external
    {
        uint256 amount = mode == 0 ? 0 : permit.permitted.amount / 2;
        if (amount == 0) return;

        SafeTransferLib.safeTransferFrom(permit.permitted.token, owner, address(this), amount);
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
