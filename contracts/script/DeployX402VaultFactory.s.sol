// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {X402VaultFactory} from "../src/X402VaultFactory.sol";

contract DeployX402VaultFactory is Script {
    // Bump the version string only if you intentionally want a new address.
    bytes32 internal constant SALT = keccak256("x402go.X402VaultFactory.v1");

    function run() external returns (X402VaultFactory factory) {
        // Require explicit values: constructor args are part of the address, and a
        // silent default (deployer, address(0)) would give a different address per chain.
        address owner = vm.envAddress("OWNER");
        address operator = vm.envAddress("OPERATOR");

        bytes memory initCode = abi.encodePacked(type(X402VaultFactory).creationCode, abi.encode(owner, operator));
        address predicted = vm.computeCreate2Address(SALT, keccak256(initCode), CREATE2_FACTORY);

        console2.log("Chain ID:         ", block.chainid);
        console2.log("Predicted factory:", predicted);

        // Re-running on a chain where it's already deployed would revert, so skip cleanly.
        if (predicted.code.length != 0) {
            console2.log("Already deployed, skipping.");
            factory = X402VaultFactory(predicted);
        } else {
            vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
            factory = new X402VaultFactory{salt: SALT}(owner, operator);
            vm.stopBroadcast();

            require(address(factory) == predicted, "address mismatch");
        }

        console2.log("X402VaultFactory: ", address(factory));
        console2.log("X402Vault (impl): ", factory.implementation());
        console2.log("Owner:            ", factory.owner());
        // Roles, not a single operator: `setOperator`/`operator()` no longer exist.
        console2.log("Operator roles:   ", factory.rolesOf(operator));
        console2.log("Operator can create:", factory.hasAnyRole(operator, factory.OPERATOR_ROLE()));

        _seedFees(factory);
    }

    /// @dev Seeds `tokenFeeBPS` from `FEE_TOKENS` / `FEE_BPS` — comma-separated env vars, e.g.
    /// `FEE_TOKENS=0xA,0xB FEE_BPS=10,250`.
    ///
    /// This is not cosmetic. A freshly deployed factory has `tokenFeeBPS == 0` for every token, and
    /// `settle`/`settleWithPermit2` deliberately refuse an unconfigured token — so a factory that
    /// ships without this step reverts `TokenNotSupported` on every payment.
    function _seedFees(X402VaultFactory factory) internal {
        address[] memory tokens = vm.envOr("FEE_TOKENS", ",", new address[](0));
        string[] memory bpsStrings = vm.envOr("FEE_BPS", ",", new string[](0));

        if (tokens.length == 0) {
            console2.log(
                "WARNING: FEE_TOKENS is unset, so no token is configured and every settle will revert TokenNotSupported."
            );
            return;
        }

        require(tokens.length == bpsStrings.length, "FEE_TOKENS/FEE_BPS length mismatch");

        uint16[] memory bps = new uint16[](tokens.length);
        for (uint256 i; i < bpsStrings.length; ++i) {
            uint256 value = vm.parseUint(bpsStrings[i]);
            require(value <= type(uint16).max, "FEE_BPS out of range");
            // Safe: the line above rejects anything that would truncate.
            // forge-lint: disable-next-line(unsafe-typecast)
            bps[i] = uint16(value);
        }

        if (factory.owner() != msg.sender) {
            console2.log("WARNING: broadcaster is not the factory owner; skipping setTokenFees. Owner is:");
            console2.logAddress(factory.owner());
            return;
        }

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        factory.setTokenFees(tokens, bps);
        vm.stopBroadcast();

        for (uint256 i; i < tokens.length; ++i) {
            console2.log("Fee seeded:", tokens[i]);
            console2.log("  bps:", bps[i]);
            console2.log("  tokenFee:", factory.tokenFee(tokens[i]));
        }
    }
}
