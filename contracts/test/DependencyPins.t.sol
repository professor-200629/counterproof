// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";

/// @notice CounterProofBounties is reviewed and documented against OpenZeppelin v5.6.1 and tested
///         with forge-std v1.17.0. `git submodule update` checks out whatever commit git records
///         for lib/, and a wrong pin (for example OpenZeppelin master, 5.7.0-dev) still compiles
///         and passes the behaviour tests while producing different bytecode. These tests make
///         such a checkout fail `forge test`. The exact commits are checked by
///         script/check-release.sh against foundry.lock.
contract DependencyPinsTest is Test {
    function test_OpenZeppelinIsV5_6_1() public view {
        string memory pkg = vm.readFile("lib/openzeppelin-contracts/package.json");
        assertEq(
            vm.parseJsonString(pkg, ".version"),
            "5.6.1",
            "lib/openzeppelin-contracts is not v5.6.1: run `git -C lib/openzeppelin-contracts checkout v5.6.1`, then `bash script/check-release.sh`"
        );
    }

    function test_ForgeStdIsV1_17_0() public view {
        string memory pkg = vm.readFile("lib/forge-std/package.json");
        assertEq(
            vm.parseJsonString(pkg, ".version"),
            "1.17.0",
            "lib/forge-std is not v1.17.0: run `git -C lib/forge-std checkout v1.17.0`, then `bash script/check-release.sh`"
        );
    }
}
