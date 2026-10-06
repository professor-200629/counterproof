// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Script, console2} from "forge-std/Script.sol";
import {CounterProofBounties} from "../src/CounterProofBounties.sol";

/// @notice Deploys CounterProofBounties. The deployer key is read from the DEPLOYER_PRIVATE_KEY
///         environment variable and is never logged; only the derived address is printed.
contract Deploy is Script {
    function run() external returns (CounterProofBounties bounties) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);
        bounties = new CounterProofBounties();
        vm.stopBroadcast();

        console2.log("chain id:", block.chainid);
        console2.log("deployer:", deployer);
        console2.log("CounterProofBounties:", address(bounties));
    }
}
