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

    bytes32 internal M1; // alice's ("gas-1")
    bytes32 internal M2; // alice's ("gas-2")

    function setUp() public override {
        super.setUp();
        M1 = _mid(alice, keccak256("gas-1"));
        M2 = _mid(alice, keccak256("gas-2"));
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
        vm.snapshotValue(
            "Calldata",
            string.concat(vm.toString(abi.encodePacked(bytes4(data))), "-", vm.toString(data.length)),
            data.length
        );

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

    function _compactSig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (bytes32 r, bytes32 vs) = vm.signCompact(pk, digest);
        return abi.encodePacked(r, vs);
    }

    function test_gas_compactOpenSession() public {
        IGameVault.SessionAuth memory a = _auth(alice, aliceKey, 100e18, 1_000e18, uint64(block.timestamp + 3 days));
        _measure(
            "openSession (compact)",
            abi.encodeCall(vault.openSession, (a, _compactSig(alicePk, _hashAuth(a)))),
            relayer,
            true
        );
    }

    function test_gas_compactLock() public {
        _ready(1_000e18);
        IGameVault.Entry memory a = _entry(M1, alice, address(0), 100e18);
        IGameVault.Entry memory b = _entry(M1, bob, alice, 100e18);
        bytes memory sa = _compactSig(aliceKeyPk, _hashEntry(a));
        bytes memory sb = _compactSig(bobKeyPk, _hashEntry(b));
        _measure("lock (compact, first of session)", abi.encodeCall(vault.lock, (a, sa, b, sb)), relayer, true);
    }

    function test_gas_compactSettle() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        IGameVault.Result memory r = _result(M1, OUTCOME_WIN, alice, FEE);
        _measure(
            "settle (compact, first house fee)",
            abi.encodeCall(vault.settle, (r, _compactSig(refereePk, _hashResult(r)))),
            relayer,
            true
        );
    }

    function test_gas_compactMutual() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        IGameVault.Result memory r = _result(M1, OUTCOME_WIN, alice, FEE);
        bytes memory sa = _compactSig(alicePk, _hashResult(r));
        bytes memory sb = _compactSig(bobPk, _hashResult(r));
        _measure("settleMutual (compact)", abi.encodeCall(vault.settleMutual, (r, sa, sb)), relayer, true);
    }

    /// Calldata length is an uncompressed L1-data upper-level comparison, not a Nitro fee quote.
    function _measure(string memory name, bytes memory data, address caller, bool succeeds) internal {
        _cool();
        vm.prank(caller);
        (bool ok,) = address(vault).call(data);
        uint256 used = _txGas(data);
        assertEq(ok, succeeds, name);
        vm.snapshotValue("GameVault", name, used);
        vm.snapshotValue("Calldata", name, data.length);
    }

    function test_gas_depositFor() public {
        _fund(alice, 100e18);
        _measure("depositFor", abi.encodeCall(vault.depositFor, (bob, 100e18)), alice, true);
    }

    function test_gas_withdrawTo() public {
        _deposit(alice, 100e18);
        _measure("withdrawTo", abi.encodeCall(vault.withdrawTo, (50e18, bob)), alice, true);
    }

    function test_gas_revokeSession() public {
        _ready(1_000e18);
        _measure("revokeSession", abi.encodeCall(vault.revokeSession, ()), alice, true);
    }

    function test_gas_cancel() public {
        _measure("cancel", abi.encodeCall(vault.cancel, (M1)), alice, true);
    }

    function test_gas_reclaim() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        vm.warp(block.timestamp + WINDOW + 1);
        _measure("reclaim", abi.encodeCall(vault.reclaim, (M1)), alice, true);
    }

    function test_gas_settleMutual() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        IGameVault.Result memory r = _result(M1, OUTCOME_WIN, alice, FEE);
        bytes memory a = _signResult(alicePk, r);
        bytes memory b = _signResult(bobPk, r);
        _measure("settleMutual", abi.encodeCall(vault.settleMutual, (r, a, b)), relayer, true);
    }

    function test_gas_settleVoid() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        IGameVault.Result memory r = _result(M1, 2, address(0), 0);
        bytes memory sig = _signResult(refereePk, r);
        _measure("settleVoid", abi.encodeCall(vault.settle, (r, sig)), relayer, true);
    }

    function test_gas_withdrawHouse() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        _settle(M1, alice, FEE);
        _measure("withdrawHouse", abi.encodeCall(vault.withdrawHouse, ()), stranger, true);
    }

    function test_gas_withdrawHouseTo() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        _settle(M1, alice, FEE);
        _measure("withdrawHouseTo", abi.encodeCall(vault.withdrawHouseTo, (1e18, carol)), house, true);
    }

    function test_gas_setHouseFees() public {
        _measure("setHouseFees", abi.encodeCall(vault.setHouseFees, (250, 100)), owner, true);
    }

    function test_gas_setCaps() public {
        _measure("setCaps", abi.encodeCall(vault.setCaps, (2_000e18, 200_000e18)), owner, true);
    }

    function test_gas_setReferee() public {
        _measure("setReferee", abi.encodeCall(vault.setReferee, (carol)), owner, true);
    }

    function test_gas_creditSurplus() public {
        token.transfer(address(vault), 100e18);
        _measure("creditSurplus", abi.encodeCall(vault.creditSurplus, (alice, 100e18)), owner, true);
    }

    function test_gas_pause() public {
        _measure("pause", abi.encodeCall(vault.pause, ()), owner, true);
    }

    function test_gas_unpause() public {
        vm.prank(owner);
        vault.pause();
        _measure("unpause", abi.encodeCall(vault.unpause, ()), owner, true);
    }

    function test_gas_ownershipTransfer() public {
        _measure("ownershipTransfer", abi.encodeCall(vault.transferOwnership, (alice)), owner, true);
    }

    function test_gas_ownershipAccept() public {
        vm.prank(owner);
        vault.transferOwnership(alice);
        _measure("ownershipAccept", abi.encodeCall(vault.acceptOwnership, ()), alice, true);
    }

    function test_gas_ownershipRenounce() public {
        _measure("ownershipRenounce", abi.encodeCall(vault.renounceOwnership, ()), owner, false);
    }

    function test_gas_view_MAX_FEE_BPS() public {
        _measure("MAX_FEE_BPS", abi.encodeWithSignature("MAX_FEE_BPS()"), stranger, true);
    }

    function test_gas_view_MAX_SESSION_TTL() public {
        _measure("MAX_SESSION_TTL", abi.encodeWithSignature("MAX_SESSION_TTL()"), stranger, true);
    }

    function test_gas_view_house() public {
        _measure("house", abi.encodeWithSignature("house()"), stranger, true);
    }

    function test_gas_view_settleWindow() public {
        _measure("settleWindow", abi.encodeWithSignature("settleWindow()"), stranger, true);
    }

    function test_gas_view_maxStake() public {
        _measure("maxStake", abi.encodeWithSignature("maxStake()"), stranger, true);
    }

    function test_gas_view_houseFeeBps() public {
        _measure("houseFeeBps", abi.encodeWithSignature("houseFeeBps()"), stranger, true);
    }

    function test_gas_view_holderFeeBps() public {
        _measure("holderFeeBps", abi.encodeWithSignature("holderFeeBps()"), stranger, true);
    }

    function test_gas_view_maxBalance() public {
        _measure("maxBalance", abi.encodeWithSignature("maxBalance()"), stranger, true);
    }

    function test_gas_view_token() public {
        _measure("token", abi.encodeWithSignature("token()"), stranger, true);
    }

    function test_gas_view_referee() public {
        _measure("referee", abi.encodeWithSignature("referee()"), stranger, true);
    }

    function test_gas_view_houseAccrued() public {
        _measure("houseAccrued", abi.encodeWithSignature("houseAccrued()"), stranger, true);
    }

    function test_gas_view_totalLiabilities() public {
        _measure("totalLiabilities", abi.encodeWithSignature("totalLiabilities()"), stranger, true);
    }

    function test_gas_view_owner() public {
        _measure("owner", abi.encodeWithSignature("owner()"), stranger, true);
    }

    function test_gas_view_pendingOwner() public {
        _measure("pendingOwner", abi.encodeWithSignature("pendingOwner()"), stranger, true);
    }

    function test_gas_view_paused() public {
        _measure("paused", abi.encodeWithSignature("paused()"), stranger, true);
    }

    function test_gas_view_eip712Domain() public {
        _measure("eip712Domain", abi.encodeWithSignature("eip712Domain()"), stranger, true);
    }

    function test_gas_view_refereeOf() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        _measure("refereeOf", abi.encodeWithSignature("refereeOf(bytes32)", M1), stranger, true);
    }

    function test_gas_view_matchOf() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        _measure("matchOf", abi.encodeWithSignature("matchOf(bytes32)", M1), stranger, true);
    }

    function test_gas_view_freeOf() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        _measure("freeOf", abi.encodeWithSignature("freeOf(address)", alice), stranger, true);
    }

    function test_gas_view_lockedOf() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        _measure("lockedOf", abi.encodeWithSignature("lockedOf(address)", alice), stranger, true);
    }

    function test_gas_view_sessionOf() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        _measure("sessionOf", abi.encodeWithSignature("sessionOf(address)", alice), stranger, true);
    }

    function test_gas_view_sessionNonce() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        _measure("sessionNonce", abi.encodeWithSignature("sessionNonce(address)", alice), stranger, true);
    }

    function test_gas_view_hashSessionAuth() public {
        IGameVault.SessionAuth memory a = _auth(alice, aliceKey, 100e18, 1_000e18, uint64(block.timestamp + 3 days));
        _measure("hashSessionAuth", abi.encodeCall(vault.hashSessionAuth, (a)), stranger, true);
    }

    function test_gas_view_hashEntry() public {
        IGameVault.Entry memory a = _entry(M1, alice, bob, 100e18);
        _measure("hashEntry", abi.encodeCall(vault.hashEntry, (a)), stranger, true);
    }

    function test_gas_view_hashResult() public {
        IGameVault.Result memory a = _result(M1, OUTCOME_WIN, alice, FEE);
        _measure("hashResult", abi.encodeCall(vault.hashResult, (a)), stranger, true);
    }
}

contract Noop {
    function f() external {}
}
