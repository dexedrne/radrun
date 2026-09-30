// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {GameVault} from "../src/GameVault.sol";
import {TestSpiderTag} from "../src/TestSpiderTag.sol";

/// The deploy script: a test network gets the test token plus a vault with the given settings; a mainnet chain id is
/// refused without the explicit go-ahead, and never gets a test token. Only one test touches the process environment
/// (tests run in parallel); the others pass a Config.
contract DeployScriptTest is Test {
    // anvil dev key #0 (public; local tests only)
    uint256 internal constant DEV_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address internal house = makeAddr("house");
    address internal referee = makeAddr("referee");
    address internal owner = makeAddr("owner");
    address internal faucet = makeAddr("faucet");

    function _config() internal view returns (Deploy.Config memory) {
        return Deploy.Config({
            deployerKey: DEV_KEY,
            token: address(0),
            testTokenHolder: faucet,
            house: house,
            referee: referee,
            owner: owner,
            feeBps: 300,
            holderFeeBps: 150,
            maxStake: 10_000e18,
            maxBalance: 1_000_000e18,
            settleWindow: 1 days,
            allowMainnet: false
        });
    }

    function test_env_readsEveryVariable() public {
        vm.setEnv("DEPLOYER_KEY", vm.toString(bytes32(DEV_KEY)));
        vm.setEnv("VAULT_TOKEN", vm.toString(address(0)));
        vm.setEnv("TEST_TOKEN_HOLDER", vm.toString(faucet));
        vm.setEnv("VAULT_HOUSE", vm.toString(house));
        vm.setEnv("VAULT_REFEREE", vm.toString(referee));
        vm.setEnv("VAULT_OWNER", vm.toString(owner));
        vm.setEnv("VAULT_FEE_BPS", "250");
        vm.setEnv("VAULT_HOLDER_FEE_BPS", "125");
        vm.setEnv("VAULT_MAX_STAKE", "10000000000000000000000");
        vm.setEnv("VAULT_MAX_BALANCE", "1000000000000000000000000");
        vm.setEnv("VAULT_SETTLE_WINDOW", "7200");
        vm.setEnv("ALLOW_MAINNET", "false");
        Deploy.Config memory c = new Deploy().configFromEnv();
        assertEq(c.deployerKey, DEV_KEY);
        assertEq(c.testTokenHolder, faucet);
        assertEq(c.house, house);
        assertEq(c.referee, referee);
        assertEq(c.owner, owner);
        assertEq(c.feeBps, 250);
        assertEq(c.holderFeeBps, 125);
        assertEq(c.maxStake, 10_000e18);
        assertEq(c.maxBalance, 1_000_000e18);
        assertEq(c.settleWindow, 7200);
        assertFalse(c.allowMainnet);
    }

    function test_testnet_deploysTokenAndVault() public {
        vm.chainId(46630);
        (address token, address vault) = new Deploy().deploy(_config());
        GameVault v = GameVault(vault);
        assertEq(v.token(), token);
        assertEq(TestSpiderTag(token).balanceOf(faucet), 1_000_000_000e18);
        assertEq(v.house(), house);
        assertEq(v.referee(), referee);
        assertEq(v.owner(), owner);
        assertEq(v.houseFeeBps(), 300);
        assertEq(v.holderFeeBps(), 150);
        assertEq(v.maxStake(), 10_000e18);
        assertEq(v.maxBalance(), 1_000_000e18);
        assertEq(v.settleWindow(), 1 days);
    }

    function test_existingToken_noTestToken() public {
        TestSpiderTag t = new TestSpiderTag(address(this));
        Deploy.Config memory c = _config();
        c.token = address(t);
        (address token, address vault) = new Deploy().deploy(c);
        assertEq(token, address(t));
        assertEq(GameVault(vault).token(), address(t));
    }

    function test_mainnet_refusedWithoutGoAhead() public {
        Deploy d = new Deploy();
        Deploy.Config memory c = _config();
        c.token = address(new TestSpiderTag(address(this)));
        vm.chainId(4663);
        vm.expectRevert(bytes("mainnet needs the owner's explicit go-ahead"));
        d.deploy(c);
        vm.chainId(1);
        vm.expectRevert(bytes("mainnet needs the owner's explicit go-ahead"));
        d.deploy(c);
        // With the go-ahead, the owner's token gets its vault.
        c.allowMainnet = true;
        (, address vault) = d.deploy(c);
        assertEq(GameVault(vault).token(), c.token);
    }

    function test_mainnet_neverATestToken() public {
        Deploy d = new Deploy();
        Deploy.Config memory c = _config();
        c.allowMainnet = true;
        vm.chainId(4663);
        vm.expectRevert(bytes("the test token is for test networks only"));
        d.deploy(c);
    }
}
