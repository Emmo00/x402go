// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IX402Vault} from "../../src/interfaces/IX402Vault.sol";
import {IPermit2} from "../../src/interfaces/IPermit2.sol";
import {IX402ExactPermit2Proxy} from "../../src/interfaces/IX402ExactPermit2Proxy.sol";
import {X402Vault} from "../../src/X402Vault.sol";
import {X402VaultFactory} from "../../src/X402VaultFactory.sol";

import {MockERC20, PERMIT2_ADDR, X402_PROXY_ADDR} from "./Mocks.sol";
import {X402Signing} from "./X402Signing.sol";

/// @dev Shared actors, fixtures and settlements for every suite. Payload construction lives in
/// {X402Signing}, which this extends; the invariant handler extends that directly.
abstract contract X402Base is X402Signing {
    /// @dev 0.10%. Small enough that the 6-decimal token's fee is 1_000 units and the 18-decimal
    /// token's is 1e15, both comfortably non-zero.
    uint16 internal constant DEFAULT_BPS = 10;

    X402VaultFactory internal factory;

    /// @dev Cached because `factory.OPERATOR_ROLE()` is an external call, and an external call in
    /// argument position consumes a pending `vm.prank`/`vm.expectRevert` before the call under test
    /// ever runs. Read once here so every suite can name it without arming a cheatcode by accident.
    uint256 internal operatorRole;

    /// @dev The two EIP-3009 tokens the brief calls for: a 6-decimal dollar-like asset (what a real
    /// settlement pays in) and an 18-decimal one for the non-dollar case.
    MockERC20 internal token6;
    MockERC20 internal token18;

    address internal owner;
    address internal operator;
    address internal operator2;
    address internal feeRecipient;
    address internal stranger;
    address internal payoutAddr;

    uint256 internal merchantPk;
    address internal merchant;

    uint256 internal payerPk;
    address internal payer;

    function setUp() public virtual {
        owner = makeAddr("owner");
        operator = makeAddr("operator");
        operator2 = makeAddr("operator2");
        feeRecipient = makeAddr("feeRecipient");
        stranger = makeAddr("stranger");
        payoutAddr = makeAddr("payout");

        merchantPk = 0xA11CE;
        merchant = vm.addr(merchantPk);
        payerPk = 0xB0B;
        payer = vm.addr(payerPk);

        factory = new X402VaultFactory(owner, operator);
        operatorRole = factory.OPERATOR_ROLE();

        token6 = new MockERC20("USD Coin", "USDC", 6);
        token18 = new MockERC20("Mock", "MCK", 18);
    }

    // ------------------------------------------------------------- actors/fixtures

    /// @dev Creates `m`'s vault the way the platform does: through the operator role, never as the
    /// merchant, so every suite exercises the role path rather than a self-service shortcut.
    function _deploy(address m, address p) internal returns (address v) {
        vm.prank(operator);
        v = factory.createVault(m, p);
    }

    function _deployAs(address caller, address m, address p) internal returns (address v) {
        vm.prank(caller);
        v = factory.createVault(m, p);
    }

    /// @dev `merchant`'s vault, paying the merchant directly.
    function _openVault() internal returns (address) {
        return _deploy(merchant, merchant);
    }

    function _vaultOf(address m) internal view returns (address) {
        return factory.vaultOf(m);
    }

    function _configure(address token, uint16 bps) internal {
        address[] memory tokens = new address[](1);
        uint16[] memory fees = new uint16[](1);
        tokens[0] = token;
        fees[0] = bps;

        vm.prank(owner);
        factory.setTokenFees(tokens, fees);
    }

    function _fee(address token) internal view returns (uint256) {
        return factory.tokenFee(token);
    }

    // ------------------------------------------------------------- settlements

    /// @dev Settles one EIP-3009 payment, always relayed by `stranger`. A test that used a
    /// privileged caller here would stop proving that `settle` is permissionless.
    function _pay3009(uint256 pk, address vaultAddr, address tokenContract, uint256 value, bytes32 authNonce) internal {
        IX402Vault.Eip3009Authorization memory auth = _auth3009(pk, tokenContract, vaultAddr, value, authNonce);

        vm.prank(stranger);
        X402Vault(vaultAddr).settle(tokenContract, auth);
    }

    /// @dev Settles one Permit2 payment through the proxy, also relayed by `stranger`.
    function _payPermit2(uint256 pk, address vaultAddr, address tokenContract, uint256 value, uint256 permitNonce)
        internal
    {
        address payerAddr = vm.addr(pk);
        IPermit2.PermitTransferFrom memory permit = _permit(tokenContract, value, permitNonce, block.timestamp + 1 days);
        IX402ExactPermit2Proxy.Witness memory wit = _witness(vaultAddr, 0);
        bytes memory signature = _signPermit2(pk, PERMIT2_ADDR, X402_PROXY_ADDR, permit, wit);

        vm.prank(stranger);
        X402Vault(vaultAddr).settleWithPermit2(permit, payerAddr, wit, signature);
    }
}
