// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity 0.8.37;

import {GameVault} from "../src/GameVault.sol";
import {IGameVault, OUTCOME_WIN, OUTCOME_VOID} from "../src/interfaces/IGameVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";

/// Fuzz tests (docs/WAGER.md §9.1): payout maths, captured fees and session limits for any values.
contract FuzzTest is VaultTestBase {
    bytes32 internal constant M1 = keccak256("fuzz-1");

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        vault.setCaps(type(uint128).max, type(uint128).max);
    }

    /// §3.5: pot = 2 x stake, fee = pot x bps / 10 000 rounded down, winner gets the rest; nothing is created or lost.
    function testFuzz_payout(uint128 stake, uint16 feeBps, bool holderWins, bool aliceWins) public {
        stake = uint128(bound(stake, 1, 400_000_000e18));
        feeBps = uint16(bound(feeBps, 0, 500));
        vm.prank(owner);
        vault.setHouseFees(feeBps, uint16(bound(uint256(feeBps) * 7, 0, 500)) / 2); // captured as min(., fee)
        _ready(stake);
        _lock(M1, stake);
        IGameVault.Match memory m = vault.matchOf(M1);
        uint16 used = holderWins ? m.holderFeeBps : m.feeBps;
        _settle(M1, aliceWins ? alice : bob, used);
        _checkPayout(aliceWins ? alice : bob, aliceWins ? bob : alice, stake, used);
    }

    function _checkPayout(address winner, address loser, uint128 stake, uint16 used) internal view {
        uint256 pot = 2 * uint256(stake);
        uint256 fee = pot * used / 10_000;
        assertEq(vault.freeOf(winner), pot - fee, "winner");
        assertEq(vault.freeOf(loser), 0, "loser");
        assertEq(vault.houseAccrued(), fee, "house");
        assertLe(fee, pot * 500 / 10_000, "fee never above 5%");
        assertEq(vault.lockedOf(winner) + vault.lockedOf(loser), 0);
        assertEq(vault.totalLiabilities(), pot, "settles move buckets only");
        _assertBooks(_players());
    }

    /// Captured fee = min(house, capA, capB); captured holder fee = min(holder, captured fee).
    function testFuzz_capturedFees(uint16 houseFee, uint16 holderFee, uint16 capA, uint16 capB) public {
        houseFee = uint16(bound(houseFee, 0, 500));
        holderFee = uint16(bound(holderFee, 0, 500));
        vm.prank(owner);
        vault.setHouseFees(houseFee, holderFee);
        _ready(10e18);
        IGameVault.Entry memory a = _entry(M1, alice, address(0), 1e18);
        IGameVault.Entry memory b = _entry(M1, bob, alice, 1e18);
        a.feeCapBps = capA;
        b.feeCapBps = capB;
        vault.lock(a, _signEntry(aliceKeyPk, a), b, _signEntry(bobKeyPk, b));
        IGameVault.Match memory m = vault.matchOf(M1);
        uint16 expected = houseFee;
        if (capA < expected) expected = capA;
        if (capB < expected) expected = capB;
        assertEq(m.feeBps, expected);
        assertEq(m.holderFeeBps, holderFee < expected ? holderFee : expected);
        assertLe(m.feeBps, 500);
        assertLe(m.holderFeeBps, m.feeBps);
    }

    /// Any fee the referee signs other than the two captured values is refused.
    function testFuzz_settleOnlyCapturedFees(uint16 feeBps) public {
        _ready(10e18);
        _lock(M1, 1e18);
        IGameVault.Result memory r = _result(M1, OUTCOME_WIN, alice, feeBps);
        bytes memory sig = _signResult(refereePk, r);
        if (feeBps == FEE || feeBps == HOLDER_FEE) {
            vault.settle(r, sig);
        } else {
            vm.expectRevert(IGameVault.BadResult.selector);
            vault.settle(r, sig);
        }
    }

    /// openSession succeeds exactly when 0 < maxStake <= cap, now < expiry <= now + 30 days and the nonce is current.
    function testFuzz_openSessionValidity(uint128 maxStake, uint128 cap, uint64 expiry, uint64 nonce) public {
        nonce = uint64(bound(nonce, 0, 2));
        expiry = uint64(bound(expiry, 0, vm.getBlockTimestamp() + 60 days));
        IGameVault.SessionAuth memory a = IGameVault.SessionAuth({
            player: alice, sessionKey: aliceKey, maxStake: maxStake, cap: cap, expiry: expiry, nonce: nonce
        });
        bytes memory sig = _sign(alicePk, _hashAuth(a));
        bool ok = nonce == 0 && maxStake != 0 && maxStake <= cap && expiry > vm.getBlockTimestamp()
            && expiry <= vm.getBlockTimestamp() + 30 days;
        if (!ok) vm.expectRevert();
        vault.openSession(a, sig);
        if (ok) {
            IGameVault.Session memory s = vault.sessionOf(alice);
            assertEq(s.key, aliceKey);
            assertEq(s.expiry, expiry);
            assertEq(s.maxStake, maxStake);
            assertEq(s.cap, cap);
            assertEq(vault.sessionNonce(alice), 1);
        } else {
            assertEq(vault.sessionNonce(alice), 0);
        }
    }

    /// A session-key Entry locks exactly when the session is live and within maxStake and cap; `used` tracks it.
    function testFuzz_sessionLimits(uint128 maxStake, uint128 cap, uint32 ttl, uint128[3] memory stakes, uint32 dt)
        public
    {
        maxStake = uint128(bound(maxStake, 1, 1_000e18));
        cap = uint128(bound(cap, maxStake, 3_000e18));
        ttl = uint32(bound(ttl, 1, 30 days));
        _deposit(alice, 10_000e18);
        _deposit(bob, 10_000e18);
        IGameVault.SessionAuth memory auth = _auth(alice, aliceKey, maxStake, cap, uint64(vm.getBlockTimestamp() + ttl));
        vault.openSession(auth, _sign(alicePk, _hashAuth(auth)));
        vm.warp(vm.getBlockTimestamp() + bound(dt, 0, 2 * uint256(ttl)));
        uint256 used;
        for (uint256 i = 0; i < 3; i++) {
            used = _tryLock(i, uint128(bound(stakes[i], 1, 1_200e18)), auth, used);
        }
        assertEq(vault.lockedOf(alice), used);
    }

    function _tryLock(uint256 i, uint128 stake, IGameVault.SessionAuth memory auth, uint256 used)
        internal
        returns (uint256)
    {
        bytes32 id = keccak256(abi.encode("fuzz-session", i));
        IGameVault.Entry memory a = _entry(id, alice, address(0), stake);
        IGameVault.Entry memory b = _entry(id, bob, alice, stake);
        bytes memory sigA = _signEntry(aliceKeyPk, a);
        bytes memory sigB = _signEntry(bobPk, b);
        bool ok = vm.getBlockTimestamp() < auth.expiry && stake <= auth.maxStake && used + stake <= auth.cap;
        if (!ok) vm.expectRevert(abi.encodeWithSelector(IGameVault.SessionLimit.selector, alice));
        vault.lock(a, sigA, b, sigB);
        if (ok) used += stake;
        assertEq(vault.sessionOf(alice).used, used);
        assertLe(vault.sessionOf(alice).used, auth.cap);
        return used;
    }

    /// Deposit then withdraw returns exactly what went in; nothing else moves.
    function testFuzz_depositWithdrawRoundTrip(uint128 amount, uint128 out) public {
        amount = uint128(bound(amount, 1, 1_000_000e18));
        out = uint128(bound(out, 1, amount));
        _deposit(alice, amount);
        vm.prank(alice);
        vault.withdraw(out);
        assertEq(vault.freeOf(alice), amount - out);
        assertEq(token.balanceOf(alice), out);
        assertEq(token.balanceOf(address(vault)), vault.totalLiabilities());
    }

    /// A void, by the referee or by timeout, returns both stakes exactly.
    function testFuzz_voidRestores(uint128 stake, bool byTimeout, uint32 late) public {
        stake = uint128(bound(stake, 1, 1_000_000e18));
        _ready(stake);
        _lock(M1, stake);
        if (byTimeout) {
            vm.warp(vault.matchOf(M1).settleBy + 1 + bound(late, 0, 365 days));
            vault.refundExpired(M1);
        } else {
            IGameVault.Result memory r = _result(M1, OUTCOME_VOID, address(0), 0);
            vault.settle(r, _signResult(refereePk, r));
        }
        assertEq(vault.freeOf(alice), stake);
        assertEq(vault.freeOf(bob), stake);
        assertEq(vault.houseAccrued(), 0);
    }
}
