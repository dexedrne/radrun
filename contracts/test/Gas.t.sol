// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity 0.8.37;

import {Vm} from "forge-std/Vm.sol";
import {IGameVault, OUTCOME_WIN} from "../src/interfaces/IGameVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";

/// Gas targets (docs/WAGER.md §3.10) for the calls the relayer and players send, measured as whole transactions:
/// the call's execution with cold storage (vm.cool), plus the 21,000 base and the calldata cost (EIP-7623 floor
/// included), minus the capped refund. The values are also written to snapshots/GameVault.json (`forge snapshot`
/// compatible; FORGE_SNAPSHOT_CHECK=true fails on drift). On Robinhood Chain the L1 data fee comes on top, in gas
/// units that follow the L1 price; tools/wager-deploy.ts records real receipts.
contract GasTest is VaultTestBase {
    uint256 internal constant LOCK_TARGET = 220_000;
    uint256 internal constant SETTLE_TARGET = 90_000;
    uint256 internal constant OPEN_SESSION_TARGET = 90_000;
    uint256 internal constant DEPOSIT_TARGET = 90_000;

    bytes32 internal constant M1 = keccak256("gas-1");
    bytes32 internal constant M2 = keccak256("gas-2");

    function setUp() public override {
        super.setUp();
        // The vault already holds someone's tokens (its own balance slot is warm-able but nonzero, as in production).
        _deposit(carol, 1e18);
    }

    /// Whether forge runs each top-level call as its own transaction (`isolate`, the default in current forge): then
    /// lastCallGas already includes the base cost and the calldata. Measured, so the targets hold either way.
    function _isolated() internal returns (bool) {
        Noop n = new Noop();
        n.f();
        return vm.lastCallGas().gasTotalUsed >= 21_000;
    }

    /// Whole-transaction gas of the last call to the vault, given its calldata.
    function _txGas(bytes memory data) internal returns (uint256 total) {
        Vm.Gas memory g = vm.lastCallGas();
        uint256 zeros;
        for (uint256 i = 0; i < data.length; i++) {
            if (data[i] == 0) zeros++;
        }
        uint256 tokens = zeros + 4 * (data.length - zeros);
        uint256 standard = _isolated() ? g.gasTotalUsed : 21_000 + 4 * tokens + g.gasTotalUsed;
        uint256 refund = g.gasRefunded > 0 ? uint256(int256(g.gasRefunded)) : 0;
        if (refund > standard / 5) refund = standard / 5;
        total = standard - refund;
        uint256 floor = 21_000 + 10 * tokens;
        if (floor > total) total = floor;
    }

    function _cool() internal {
        vm.cool(address(vault));
        vm.cool(address(token));
    }

    function test_gas_deposit_firstForPlayer() public {
        _fund(alice, 500e18);
        _cool();
        vm.prank(alice);
        vault.deposit(500e18);
        uint256 used = _txGas(abi.encodeCall(vault.deposit, (500e18)));
        vm.snapshotValue("GameVault", "deposit (first for the player)", used);
        assertLe(used, DEPOSIT_TARGET, "deposit");
    }

    function test_gas_deposit_topUp() public {
        _deposit(alice, 500e18);
        _fund(alice, 500e18);
        _cool();
        vm.prank(alice);
        vault.deposit(500e18);
        uint256 used = _txGas(abi.encodeCall(vault.deposit, (500e18)));
        vm.snapshotValue("GameVault", "deposit (top-up)", used);
        assertLe(used, DEPOSIT_TARGET, "deposit");
    }

    function test_gas_openSession_first() public {
        IGameVault.SessionAuth memory a = _auth(alice, aliceKey, 100e18, 1_000e18, uint64(block.timestamp + 3 days));
        bytes memory sig = _sign(alicePk, _hashAuth(a));
        _cool();
        vm.prank(relayer);
        vault.openSession(a, sig);
        uint256 used = _txGas(abi.encodeCall(vault.openSession, (a, sig)));
        vm.snapshotValue("GameVault", "openSession (first)", used);
        assertLe(used, OPEN_SESSION_TARGET, "openSession");
    }

    function test_gas_openSession_replace() public {
        _ready(1_000e18);
        _lock(M1, 10e18); // the old session has `used` set
        IGameVault.SessionAuth memory a = _auth(alice, aliceKey, 100e18, 1_000e18, uint64(block.timestamp + 3 days));
        bytes memory sig = _sign(alicePk, _hashAuth(a));
        _cool();
        vm.prank(relayer);
        vault.openSession(a, sig);
        uint256 used = _txGas(abi.encodeCall(vault.openSession, (a, sig)));
        vm.snapshotValue("GameVault", "openSession (replace)", used);
        assertLe(used, OPEN_SESSION_TARGET, "openSession");
    }

    function test_gas_lock_sessionKeys_firstOfSession() public {
        _ready(1_000e18);
        IGameVault.Entry memory a = _entry(M1, alice, address(0), 100e18);
        IGameVault.Entry memory b = _entry(M1, bob, alice, 100e18);
        bytes memory sigA = _signEntry(aliceKeyPk, a);
        bytes memory sigB = _signEntry(bobKeyPk, b);
        _cool();
        vm.prank(relayer);
        vault.lock(a, sigA, b, sigB);
        uint256 used = _txGas(abi.encodeCall(vault.lock, (a, sigA, b, sigB)));
        vm.snapshotValue("GameVault", "lock (session keys, first of the session)", used);
        assertLe(used, LOCK_TARGET, "lock");
    }

    function test_gas_lock_sessionKeys_later() public {
        _ready(1_000e18);
        _lock(M2, 10e18);
        IGameVault.Entry memory a = _entry(M1, alice, address(0), 100e18);
        IGameVault.Entry memory b = _entry(M1, bob, alice, 100e18);
        bytes memory sigA = _signEntry(aliceKeyPk, a);
        bytes memory sigB = _signEntry(bobKeyPk, b);
        _cool();
        vm.prank(relayer);
        vault.lock(a, sigA, b, sigB);
        uint256 used = _txGas(abi.encodeCall(vault.lock, (a, sigA, b, sigB)));
        vm.snapshotValue("GameVault", "lock (session keys)", used);
        assertLe(used, LOCK_TARGET, "lock");
    }

    function test_gas_lock_wallets() public {
        _deposit(alice, 1_000e18);
        _deposit(bob, 1_000e18);
        IGameVault.Entry memory a = _entry(M1, alice, address(0), 100e18);
        IGameVault.Entry memory b = _entry(M1, bob, alice, 100e18);
        bytes memory sigA = _signEntry(alicePk, a);
        bytes memory sigB = _signEntry(bobPk, b);
        _cool();
        vm.prank(relayer);
        vault.lock(a, sigA, b, sigB);
        uint256 used = _txGas(abi.encodeCall(vault.lock, (a, sigA, b, sigB)));
        vm.snapshotValue("GameVault", "lock (wallet signatures)", used);
        assertLe(used, LOCK_TARGET, "lock");
    }

    function test_gas_settle_firstFee() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        IGameVault.Result memory r = _result(M1, OUTCOME_WIN, alice, FEE);
        bytes memory sig = _signResult(refereePk, r);
        _cool();
        vm.prank(relayer);
        vault.settle(r, sig);
        uint256 used = _txGas(abi.encodeCall(vault.settle, (r, sig)));
        vm.snapshotValue("GameVault", "settle (win, first house fee)", used);
        assertLe(used, SETTLE_TARGET, "settle");
    }

    function test_gas_settle_win() public {
        _ready(1_000e18);
        _lock(M2, 10e18);
        _settle(M2, bob, FEE);
        _lock(M1, 100e18);
        IGameVault.Result memory r = _result(M1, OUTCOME_WIN, alice, FEE);
        bytes memory sig = _signResult(refereePk, r);
        _cool();
        vm.prank(relayer);
        vault.settle(r, sig);
        uint256 used = _txGas(abi.encodeCall(vault.settle, (r, sig)));
        vm.snapshotValue("GameVault", "settle (win)", used);
        assertLe(used, SETTLE_TARGET, "settle");
    }

    function test_gas_withdraw_all() public {
        _deposit(alice, 500e18);
        _cool();
        vm.prank(alice);
        vault.withdraw(500e18);
        vm.snapshotValue("GameVault", "withdraw (all)", _txGas(abi.encodeCall(vault.withdraw, (500e18))));
    }

    function test_gas_refundExpired() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        vm.warp(block.timestamp + WINDOW + 1);
        _cool();
        vault.refundExpired(M1);
        vm.snapshotValue("GameVault", "refundExpired", _txGas(abi.encodeCall(vault.refundExpired, (M1))));
    }
}

contract Noop {
    function f() external {}
}
