// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "solady/tokens/ERC20.sol";

contract TestUSDC is ERC20 {
    function name() public pure override returns (string memory) {
        return "Test USD Coin";
    }

    function symbol() public pure override returns (string memory) {
        return "tUSDC";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
