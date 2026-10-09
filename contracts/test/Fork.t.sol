// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {X402Base} from "./utils/X402Base.sol";
import {X402Vault} from "../src/X402Vault.sol";
import {IX402Vault} from "../src/interfaces/IX402Vault.sol";
import {IPermit2} from "../src/interfaces/IPermit2.sol";
import {IX402ExactPermit2Proxy} from "../src/interfaces/IX402ExactPermit2Proxy.sol";
import {PERMIT2_ADDR, PERMIT2_DOMAIN_TYPEHASH, X402_PROXY_ADDR} from "./utils/Mocks.sol";

/// @dev The parts of a real FiatTokenV2 this suite reads. Deliberately not {IEip3009Token}: Celo's
/// USDC has no `domainSeparator()` getter, which is itself one of the things worth pinning.
interface IForkUsdc {
    function name() external view returns (string memory);
    function version() external view returns (string memory);
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function TRANSFER_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/// @dev Permit2's domain getter. Capitalised because that is the name in the singleton's ABI.
interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @dev Suite M â€” the real deployments.
///
/// Everything else in this repo runs against stand-ins etched at the canonical addresses, which are
/// only as faithful as the assumptions that built them. This suite removes that caveat: it forks a
/// Celo chain and settles through the **actually deployed** Permit2 singleton and x402 proxy, with
/// the real USDC as the asset. A wrong typehash, a wrong domain field, a wrong struct order or a
/// wrong signature binding shows up here as a rejected signature and nowhere else.
///
/// Skipped when neither RPC variable is set, so the ordinary `forge test` stays offline:
///
///     CELO_SEPOLIA_RPC_URL=https://forno.celo-sepolia.celo-testnet.org forge test --match-path test/Fork.t.sol
///
/// Set `CELO_RPC_URL` instead to run the same suite against Celo mainnet.
contract ForkTest is X402Base {
    /// @dev Celo mainnet USDC â€” `eip155:42220`, 6 decimals, EIP-3009.
    address internal constant CELO_USDC = 0xcebA9300f2b948710d2653dD7B07f33A8B32118C;
    /// @dev Celo Sepolia USDC â€” `eip155:11142220`, 6 decimals, EIP-3009. A different contract from
    /// mainnet's with the same ticker, which is why every lookup in this project is keyed by chain.
    address internal constant CELO_SEPOLIA_USDC = 0x01C5C0122039549AD1493B8220cABEdD739BC44E;

    bool internal forked;
    address internal usdc;

    /// @dev Cached in `setUp` because each is an external call, and an external call made while
    /// building a payload would consume a pending `vm.prank` or `vm.expectRevert`.
    bytes32 internal usdcDomain;
    bytes32 internal usdcTypehash;

    function setUp() public override {
        string memory sepolia = vm.envOr("CELO_SEPOLIA_RPC_URL", string(""));
        string memory mainnet = vm.envOr("CELO_RPC_URL", string(""));

        if (bytes(sepolia).length != 0) {
            vm.createSelectFork(sepolia);
            usdc = CELO_SEPOLIA_USDC;
        } else if (bytes(mainnet).length != 0) {
            vm.createSelectFork(mainnet);
            usdc = CELO_USDC;
        } else {
            return;
        }

        forked = true;
        super.setUp();

        usdcDomain = IForkUsdc(usdc).DOMAIN_SEPARATOR();
        usdcTypehash = IForkUsdc(usdc).TRANSFER_WITH_AUTHORIZATION_TYPEHASH();
    }

    // --------------------------------------------------------------- the fixtures

    /// @dev A signed EIP-3009 payload paying `vault`, valid now and for a day, against the real
    /// token's own domain. Built on its own line by every caller: `vm.sign` is a cheatcode call, and
    /// arming an expectation before it would spend the expectation on the cheatcode instead of on
    /// the settlement.
    function _forkAuth(address vault, uint256 value, bytes32 authNonce)
        internal
        view
        returns (IX402Vault.Eip3009Authorization memory)
    {
        return _auth3009WithDomain(payerPk, usdcDomain, usdcTypehash, vault, value, authNonce);
    }

    /// @dev Settles a prebuilt payload, always relayed by `stranger`, so this also proves the vault
    /// path is permissionless against a real token.
    function _forkSettle(address vault, IX402Vault.Eip3009Authorization memory auth) internal {
        vm.prank(stranger);
        X402Vault(vault).settle(usdc, auth);
    }

    /// @dev Funds `who` with real USDC by writing the token's own storage, and asserts it took: a
    /// silently failed `deal` would make every settlement below revert for the wrong reason.
    function _fund(address who, uint256 amount) internal {
        deal(usdc, who, amount);
        assertEq(IForkUsdc(usdc).balanceOf(who), amount, "the fork could not be funded");
    }

    // ------------------------------------------------------------------- fixtures

    function test_fork_theRealDeploymentsArePresent() public {
        if (!forked) vm.skip(true);

        assertGt(PERMIT2_ADDR.code.length, 0, "Permit2 is not deployed on this chain");
        assertGt(X402_PROXY_ADDR.code.length, 0, "the x402 proxy is not deployed on this chain");
        assertGt(usdc.code.length, 0, "USDC is not deployed on this chain");
    }

    function test_fork_realUsdcIsTheTokenTheConfigDescribes() public {
        if (!forked) vm.skip(true);

        assertEq(IForkUsdc(usdc).decimals(), 6, "USDC is not 6 decimals");
        assertEq(IForkUsdc(usdc).name(), "USDC", "the EIP-712 domain name moved");
        assertEq(IForkUsdc(usdc).version(), "2", "the EIP-712 domain version moved");
    }

    function test_fork_realUsdcPinsTheAuthorizationTypehash() public {
        if (!forked) vm.skip(true);

        assertEq(
            usdcTypehash,
            keccak256(
                "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
            ),
            "USDC's TransferWithAuthorization typehash is not the standard one"
        );
    }

    function test_fork_realUsdcDomainMatchesTheLocallyComputedOne() public {
        if (!forked) vm.skip(true);

        // The token's own separator against the one a signer would build from the published
        // (name, version, chainid, address) tuple. This is what makes `_tokenDigestWithDomain`
        // trustworthy for a token that will not hand out its separator.
        bytes32 computed = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("USDC"),
                keccak256("2"),
                block.chainid,
                usdc
            )
        );

        assertEq(computed, usdcDomain, "the published USDC domain is not the one the token signs over");
    }

    // ------------------------------------------------------------------ Permit2

    function test_fork_theRealPermit2DomainMatchesOurDigestInputs() public {
        if (!forked) vm.skip(true);

        // The load-bearing assertion of this suite. `_permit2Domain` is what every signature in
        // Suite H is built over; if it disagreed with the singleton, Suite H would still pass â€”
        // its mock agrees with the helper by construction â€” and every real payment would fail.
        assertEq(IPermit2Domain(PERMIT2_ADDR).DOMAIN_SEPARATOR(), _permit2Domain(PERMIT2_ADDR));

        // And the singleton really does use the version-less domain shape.
        assertEq(
            IPermit2Domain(PERMIT2_ADDR).DOMAIN_SEPARATOR(),
            keccak256(abi.encode(PERMIT2_DOMAIN_TYPEHASH, keccak256("Permit2"), block.chainid, PERMIT2_ADDR))
        );
    }

    // ---------------------------------------------------------------- settlement

    function test_fork_settleEip3009AgainstRealUsdc() public {
        if (!forked) vm.skip(true);

        _configure(usdc, DEFAULT_BPS);
        address vault = _openVault();

        uint256 value = 100e6;
        uint256 fee = _fee(usdc);
        _fund(payer, value);

        IX402Vault.Eip3009Authorization memory auth = _forkAuth(vault, value, keccak256("fork-3009"));
        _forkSettle(vault, auth);

        assertEq(IForkUsdc(usdc).balanceOf(merchant), value - fee, "the merchant was not paid");
        assertEq(IForkUsdc(usdc).balanceOf(address(factory)), fee, "the factory did not take its fee");
        assertEq(IForkUsdc(usdc).balanceOf(vault), 0, "the vault kept a balance");
        assertTrue(IForkUsdc(usdc).authorizationState(payer, auth.nonce), "the authorization was not consumed");
    }

    function test_fork_settlePermit2ThroughTheRealSingletonAndProxy() public {
        if (!forked) vm.skip(true);

        _configure(usdc, DEFAULT_BPS);
        address vault = _openVault();

        uint256 value = 100e6;
        uint256 fee = _fee(usdc);
        _fund(payer, value);

        // The one-time approval the real singleton requires. Note this only works because USDC is
        // not a solady `ERC20`: solady grants Permit2 an unconditional infinite allowance and
        // rejects any other `approve`, so a solady token would skip this step entirely.
        vm.prank(payer);
        IForkUsdc(usdc).approve(PERMIT2_ADDR, type(uint256).max);

        (IPermit2.PermitTransferFrom memory permit, IX402ExactPermit2Proxy.Witness memory wit, bytes memory sig) =
            _permit2Args(payerPk, vault, usdc, value, 0);

        // Everything above is built before the call: `_permit2Args` signs, and `vm.sign` would
        // spend a pending expectation.
        vm.prank(stranger);
        X402Vault(vault).settleWithPermit2(permit, payer, wit, sig);

        assertEq(IForkUsdc(usdc).balanceOf(merchant), value - fee, "the merchant was not paid");
        assertEq(IForkUsdc(usdc).balanceOf(address(factory)), fee, "the factory did not take its fee");
        assertEq(IForkUsdc(usdc).balanceOf(vault), 0, "the vault kept a balance");
    }

    // --------------------------------------------------------------- rejections

    function test_fork_theRealTokenRefusesAReplayedAuthorization() public {
        if (!forked) vm.skip(true);

        _configure(usdc, DEFAULT_BPS);
        address vault = _openVault();

        uint256 value = 100e6;
        _fund(payer, value);

        IX402Vault.Eip3009Authorization memory auth = _forkAuth(vault, value, keccak256("fork-replay"));
        _forkSettle(vault, auth);

        uint256 merchantBefore = IForkUsdc(usdc).balanceOf(merchant);

        // The real token, not a mock, is what rejects the second submission.
        vm.expectRevert();
        _forkSettle(vault, auth);

        assertEq(IForkUsdc(usdc).balanceOf(merchant), merchantBefore, "a replay moved funds");
    }

    function test_fork_theRealPermit2RefusesASignatureBoundToTheVault() public {
        if (!forked) vm.skip(true);

        _configure(usdc, DEFAULT_BPS);
        address vault = _openVault();

        uint256 value = 100e6;
        _fund(payer, value);

        vm.prank(payer);
        IForkUsdc(usdc).approve(PERMIT2_ADDR, type(uint256).max);

        // Signed with `spender = vault` instead of `spender = proxy`, which is what a payer would
        // produce if they were talked into authorising the vault directly. The real singleton must
        // bind the spender and refuse it; our own code cannot enforce this, Permit2 does.
        IPermit2.PermitTransferFrom memory permit = _permit(usdc, value, 0, block.timestamp + 1 days);
        IX402ExactPermit2Proxy.Witness memory wit = _witness(vault, 0);
        bytes memory sig = _signPermit2(payerPk, PERMIT2_ADDR, vault, permit, wit);

        vm.expectRevert();
        vm.prank(stranger);
        X402Vault(vault).settleWithPermit2(permit, payer, wit, sig);

        assertEq(IForkUsdc(usdc).balanceOf(merchant), 0, "a misdirected signature moved funds");
    }

    function test_fork_theRealProxyRefusesAWitnessForAnotherRecipient() public {
        if (!forked) vm.skip(true);

        _configure(usdc, DEFAULT_BPS);
        address vault = _openVault();

        uint256 value = 100e6;
        _fund(payer, value);

        vm.prank(payer);
        IForkUsdc(usdc).approve(PERMIT2_ADDR, type(uint256).max);

        // A perfectly valid Permit2 signature naming someone else â€” here the vault's own vault
        // check is what must stop it, before the proxy is ever reached.
        IPermit2.PermitTransferFrom memory permit = _permit(usdc, value, 0, block.timestamp + 1 days);
        IX402ExactPermit2Proxy.Witness memory wit = _witness(stranger, 0);
        bytes memory sig = _signPermit2(payerPk, PERMIT2_ADDR, X402_PROXY_ADDR, permit, wit);

        vm.expectRevert(IX402Vault.InvalidRecipient.selector);
        vm.prank(stranger);
        X402Vault(vault).settleWithPermit2(permit, payer, wit, sig);

        assertEq(IForkUsdc(usdc).balanceOf(stranger), 0, "a misdirected payment moved funds");
    }
}
