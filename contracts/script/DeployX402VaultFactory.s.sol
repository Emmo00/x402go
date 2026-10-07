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
            return X402VaultFactory(predicted);
        }

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        factory = new X402VaultFactory{salt: SALT}(owner, operator);
        vm.stopBroadcast();

        require(address(factory) == predicted, "address mismatch");

        console2.log("X402VaultFactory: ", address(factory));
        console2.log("X402Vault (impl): ", factory.implementation());
        console2.log("Owner:            ", factory.owner());
        console2.log("Operator:         ", factory.operator());
    }
}
