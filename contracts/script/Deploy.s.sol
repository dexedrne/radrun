// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {GameVault} from "../src/GameVault.sol";
import {TestSpiderTag} from "../src/TestSpiderTag.sol";

/// Deploys one GameVault (and, on test networks without a token, the TestSpiderTag test token first).
///
/// Driven by tools/wager-deploy.ts, which reads the 0600 env file of the deployment, derives the addresses and passes
/// only these to the script's environment (the deployer's key is the only key the script ever sees; nothing goes on a
/// command line):
///   DEPLOYER_KEY          the deployer's private key (it broadcasts)
///   VAULT_TOKEN           the token's address; unset or 0 deploys TestSpiderTag (refused on a mainnet)
///   TEST_TOKEN_HOLDER     who receives the whole test supply (the faucet wallet)
///   VAULT_HOUSE, VAULT_REFEREE, VAULT_OWNER
///   VAULT_FEE_BPS, VAULT_HOLDER_FEE_BPS, VAULT_MAX_STAKE, VAULT_MAX_BALANCE (base units), VAULT_SETTLE_WINDOW (s)
///   ALLOW_MAINNET         must be true on a mainnet chain id (only after the owner's explicit go-ahead)
///
/// Standalone: `forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast` with the variables above in the env.
contract Deploy is Script {
    /// Ethereum and Robinhood Chain mainnet (src/wager/config.ts MAINNET_CHAIN_IDS).
    function isMainnet(uint256 chainId) public pure returns (bool) {
        return chainId == 1 || chainId == 4663;
    }

    struct Config {
        uint256 deployerKey;
        address token;
        address testTokenHolder;
        address house;
        address referee;
        address owner;
        uint16 feeBps;
        uint16 holderFeeBps;
        uint128 maxStake;
        uint128 maxBalance;
        uint32 settleWindow;
        bool allowMainnet;
    }

    function run() external returns (address token, address vault) {
        return deploy(configFromEnv());
    }

    function configFromEnv() public view returns (Config memory c) {
        c.deployerKey = vm.envUint("DEPLOYER_KEY");
        c.token = vm.envOr("VAULT_TOKEN", address(0));
        c.testTokenHolder = vm.envOr("TEST_TOKEN_HOLDER", address(0));
        c.house = vm.envAddress("VAULT_HOUSE");
        c.referee = vm.envAddress("VAULT_REFEREE");
        c.owner = vm.envAddress("VAULT_OWNER");
        // Every narrowing is checked: a value that doesn't fit is refused, never silently truncated.
        c.feeBps = uint16(_fits(vm.envOr("VAULT_FEE_BPS", uint256(300)), type(uint16).max, "VAULT_FEE_BPS"));
        c.holderFeeBps =
            uint16(_fits(vm.envOr("VAULT_HOLDER_FEE_BPS", uint256(150)), type(uint16).max, "VAULT_HOLDER_FEE_BPS"));
        c.maxStake = uint128(_fits(vm.envUint("VAULT_MAX_STAKE"), type(uint128).max, "VAULT_MAX_STAKE"));
        c.maxBalance = uint128(_fits(vm.envUint("VAULT_MAX_BALANCE"), type(uint128).max, "VAULT_MAX_BALANCE"));
        c.settleWindow =
            uint32(_fits(vm.envOr("VAULT_SETTLE_WINDOW", uint256(1 days)), type(uint32).max, "VAULT_SETTLE_WINDOW"));
        c.allowMainnet = vm.envOr("ALLOW_MAINNET", false);
    }

    function _fits(uint256 value, uint256 max, string memory name) internal pure returns (uint256) {
        require(value <= max, string.concat(name, " is out of range"));
        return value;
    }

    function deploy(Config memory c) public returns (address token, address vault) {
        bool mainnet = isMainnet(block.chainid);
        if (mainnet) require(c.allowMainnet, "mainnet needs the owner's explicit go-ahead");
        token = c.token;
        vm.startBroadcast(c.deployerKey);
        if (token == address(0)) {
            require(!mainnet, "the test token is for test networks only");
            token = address(new TestSpiderTag(c.testTokenHolder));
            console2.log("TestSpiderTag", token);
        }
        vault = address(
            new GameVault(
                IERC20Metadata(token),
                c.house,
                c.referee,
                c.owner,
                c.feeBps,
                c.holderFeeBps,
                c.maxStake,
                c.maxBalance,
                c.settleWindow
            )
        );
        vm.stopBroadcast();
        console2.log("GameVault", vault);
    }
}
