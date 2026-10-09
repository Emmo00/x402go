// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IPermit2} from "./IPermit2.sol";

interface IX402ExactPermit2Proxy {
    struct Witness {
        address to;
        uint256 validAfter;
    }

    function settle(
        IPermit2.PermitTransferFrom calldata permit,
        address owner,
        Witness calldata witness,
        bytes calldata signature
    ) external;
}
