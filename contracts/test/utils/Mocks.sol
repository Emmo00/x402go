// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "solady/tokens/ERC20.sol";
import {X402Vault} from "../../src/X402Vault.sol";

/// @dev Well-behaved ERC20.
contract MockERC20 is ERC20 {
    function name() public pure override returns (string memory) {
        return "Mock";
    }

    function symbol() public pure override returns (string memory) {
        return "MCK";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
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

/// @dev ERC20 that tries to re-enter the vault during `transfer`.
contract ReentrantToken is MockERC20 {
    address public target;

    function arm(address t) external {
        target = t;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (target != address(0)) {
            address[] memory t = new address[](0);
            uint256[] memory a = new uint256[](0);
            // msg.sender is this token, which is not the operator -> reverts Unauthorized
            X402Vault(target).withdraw(t, a, a);
        }
        return super.transfer(to, amount);
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
