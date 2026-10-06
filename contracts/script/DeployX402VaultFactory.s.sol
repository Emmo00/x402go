// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {X402VaultFactory} from "../src/X402VaultFactory.sol";

/// @notice Deploys X402VaultFactory (which deploys the X402Vault implementation in its constructor).
///
/// Env vars (all optional):
///   OWNER     - factory owner (fee withdrawal + operator rotation). Defaults to the broadcaster.
///   OPERATOR  - the x402Go server wallet: creates vaults on merchants' behalf and is the only
///               caller of `X402Vault.withdraw`. Set here, in the constructor. Defaults to
///               address(0), which leaves every vault unwithdrawable until the owner calls
///               setOperator - so set it explicitly in any real deployment.
///   PRIVATE_KEY - broadcast key.
///
/// Usage:
///   forge script script/DeployX402VaultFactory.s.sol:DeployX402VaultFactory \
///     --rpc-url $RPC_URL --account <keystore-name> --broadcast --verify -vvvv
contract DeployX402VaultFactory is Script {
    function run() external returns (X402VaultFactory factory) {
        uint256 privateKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(privateKey);

        (, address deployer,) = vm.readCallers();

        address owner = vm.envOr("OWNER", deployer);
        address operator = vm.envOr("OPERATOR", address(0));

        factory = new X402VaultFactory(owner, operator);

        vm.stopBroadcast();

        console2.log("Chain ID:            ", block.chainid);
        console2.log("Deployer:            ", deployer);
        console2.log("X402VaultFactory:    ", address(factory));
        console2.log("X402Vault (impl):    ", factory.implementation());
        console2.log("Owner:               ", factory.owner());
        console2.log("Operator:            ", factory.operator());
    }
}
