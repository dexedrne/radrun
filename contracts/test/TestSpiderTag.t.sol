// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TestSpiderTag} from "../src/TestSpiderTag.sol";

/// The test token has the launchpad-token shape of docs/WAGER.md §3.8.
contract TestSpiderTagTest is Test {
    TestSpiderTag internal t;
    address internal faucet = makeAddr("faucet");

    function setUp() public {
        t = new TestSpiderTag(faucet);
    }

    function test_shape() public view {
        assertEq(t.name(), "SPIDERTAG Test");
        assertEq(t.symbol(), "tSPIDERTAG");
        assertEq(t.decimals(), 18);
        assertEq(t.totalSupply(), 1_000_000_000e18);
        assertEq(t.balanceOf(faucet), 1_000_000_000e18);
    }

    function test_burnAndBurnFrom() public {
        address a = makeAddr("a");
        vm.prank(faucet);
        require(t.transfer(a, 100e18));
        vm.prank(a);
        t.burn(40e18);
        assertEq(t.totalSupply(), 1_000_000_000e18 - 40e18);
        vm.prank(a);
        t.approve(faucet, 10e18);
        vm.prank(faucet);
        t.burnFrom(a, 10e18);
        assertEq(t.balanceOf(a), 50e18);
    }

    /// No owner, no mint, no permit, no pause: none of those selectors exist.
    function test_noAdminSurface() public {
        bytes[5] memory calls = [
            abi.encodeWithSignature("owner()"),
            abi.encodeWithSignature("mint(address,uint256)", faucet, 1),
            abi.encodeWithSignature("pause()"),
            abi.encodeWithSignature("DOMAIN_SEPARATOR()"),
            abi.encodeWithSignature("nonces(address)", faucet)
        ];
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok,) = address(t).call(calls[i]);
            assertFalse(ok);
        }
    }

    function test_transfersAreExact(address to, uint256 amount) public {
        vm.assume(to != address(0) && to != faucet);
        amount = bound(amount, 0, 1_000_000_000e18);
        vm.prank(faucet);
        require(t.transfer(to, amount));
        assertEq(t.balanceOf(to), amount);
    }

    function test_zeroHolderRejected() public {
        vm.expectRevert();
        new TestSpiderTag(address(0));
    }
}
