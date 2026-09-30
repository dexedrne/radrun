// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity 0.8.37;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {GameVault} from "../../src/GameVault.sol";
import {IGameVault} from "../../src/interfaces/IGameVault.sol";
import {HostileToken} from "../mocks/Tokens.sol";
import {VaultHandler} from "./VaultHandler.sol";

/// Handler-based invariants (docs/WAGER.md §9.1 I1-I9) on a token whose owner switches on a pause, a blacklist and a
/// sender tax at random: players, their session keys, the owner, rotating referees, the house and a stranger call
/// everything in random order with time warps.
contract VaultInvariantsTest is Test {
    GameVault internal vault;
    HostileToken internal token;
    VaultHandler internal handler;
    address internal owner = makeAddr("owner");
    address internal house = makeAddr("house");

    function setUp() public {
        vm.warp(1_800_000_000);
        uint256 refereePk = uint256(keccak256("referee"));
        token = new HostileToken();
        vault = new GameVault(
            IERC20Metadata(address(token)), house, vm.addr(refereePk), owner, 300, 150, 1_000e18, 200_000e18, 1 days
        );
        handler = new VaultHandler(vault, token, owner, house, refereePk);
        targetContract(address(handler));
        bytes4[] memory skip = new bytes4[](1);
        skip[0] = VaultHandler.doWithdraw.selector;
        excludeSelector(FuzzSelector({addr: address(handler), selectors: skip}));
        excludeSender(address(vault));
    }

    /// I1 + I2: totalLiabilities == Σfree + Σlocked + houseAccrued, and the vault holds exactly that plus the surplus
    /// (direct transfers the owner hasn't credited): solvent whatever the token did.
    function invariant_I1_I2_solventAndBooks() public view {
        uint256 sum = vault.houseAccrued();
        for (uint256 i = 0; i < 4; i++) {
            address p = handler.players(i);
            sum += vault.freeOf(p) + vault.lockedOf(p);
        }
        assertEq(sum, vault.totalLiabilities(), "books");
        assertEq(token.balanceOf(address(vault)), vault.totalLiabilities() + handler.ghostSurplus(), "balance");
    }

    /// I3: a player's locked balance is their stake in every Locked match they haven't reclaimed.
    function invariant_I3_lockedEqualsLiveStakes() public view {
        uint256[4] memory per;
        uint256 n = handler.matchCount();
        for (uint256 k = 0; k < n; k++) {
            bytes32 id = handler.matchIds(k);
            IGameVault.Match memory m = vault.matchOf(id);
            if (m.state != IGameVault.MatchState.Locked) continue;
            uint8 done = handler.ghostReclaimed(id);
            for (uint256 i = 0; i < 4; i++) {
                address p = handler.players(i);
                if (p == m.playerA && done & 1 == 0) per[i] += m.stake;
                if (p == m.playerB && done & 2 == 0) per[i] += m.stake;
            }
        }
        for (uint256 i = 0; i < 4; i++) {
            assertEq(vault.lockedOf(handler.players(i)), per[i], "locked per player");
        }
    }

    /// I4: a free balance only drops by its player's own withdrawal or a lock carrying their signature; no stranger,
    /// replayed signature, borrowed session key or wrong seat gets anything through; every refused call is refused.
    function invariant_I4_noIllegalMoves() public view {
        assertEq(handler.illegalFreeDrops(), 0, "free dropped without the player's own action");
        assertEq(handler.strangerSuccesses(), 0, "a stranger did what needs someone else's key or role");
        assertEq(handler.invalidAccepted(), 0, "a call the spec refuses went through");
    }

    /// I5: fees are the captured ones and payouts follow docs/WAGER.md §3.5; every fee charged is still accrued, was
    /// delivered to the house (or where the house sent it), or paid the token's tax on the way out.
    function invariant_I5_feesAndPayouts() public view {
        assertEq(handler.feeViolations(), 0, "fee outside what the lock captured");
        assertEq(handler.payoutViolations(), 0, "payout maths");
        assertEq(handler.houseMisrouted(), 0, "house fees went somewhere else");
        address cold = handler.HOUSE_COLD();
        assertEq(token.balanceOf(house) + token.balanceOf(cold), handler.houseWithdrawn(), "house got what it withdrew");
        assertEq(
            handler.houseWithdrawn() + handler.houseTaxPaid() + vault.houseAccrued(), handler.feesCharged(), "fees"
        );
    }

    /// I6: nothing the spec says always works was ever refused: settles by the match's referee, refunds and reclaims
    /// after the window, cancels of an unused id, withdrawals the token allows.
    function invariant_I6_liveness() public view {
        assertEq(handler.settleBlocked(), 0, "a valid settle was refused");
        assertEq(handler.refundBlocked(), 0, "an expired match could not be refunded");
        assertEq(handler.reclaimBlocked(), 0, "a player could not reclaim their stake after the window");
        assertEq(handler.cancelBlocked(), 0, "a creator could not cancel an unused id");
        assertEq(handler.withdrawBlocked(), 0, "a withdrawal the token allows was refused");
    }

    /// I7: sessions: the key, the nonce and used (spent at lock, given back by a void while the session is current)
    /// are what the players did, and used never passes the cap.
    function invariant_I7_sessions() public view {
        for (uint256 i = 0; i < 4; i++) {
            address p = handler.players(i);
            IGameVault.Session memory s = vault.sessionOf(p);
            assertEq(s.key, handler.ghostKey(p), "session key");
            assertEq(vault.sessionNonce(p), handler.ghostNonce(p), "session nonce");
            assertEq(s.used, handler.ghostUsed(p), "session used");
            assertLe(s.used, s.cap, "used <= cap");
        }
    }

    /// I8: match states only move forward (terminal states stay), and a Locked match keeps the referee it locked under
    /// through every rotation.
    function invariant_I8_statesAndReferees() public view {
        uint256 n = handler.matchCount();
        for (uint256 k = 0; k < n; k++) {
            bytes32 id = handler.matchIds(k);
            IGameVault.Match memory m = vault.matchOf(id);
            assertEq(uint8(m.state), handler.ghostState(id), "match state");
            if (m.state != IGameVault.MatchState.Cancelled) {
                assertEq(vault.refereeOf(id), handler.ghostReferee(id), "a match's referee");
            }
        }
    }

    /// I9: with the token paused, every player blacklisted and a tax on, every Locked match still refunds after its
    /// window; once the token lets them, every player leaves with their whole balance (a blocked one to another
    /// address), paused vault or not, and the house takes its fees.
    function invariant_I9_exitUnderHostileToken() public {
        uint256 snap = vm.snapshotState();
        token.setPaused(true);
        token.setTax(500);
        for (uint256 i = 0; i < 4; i++) {
            token.setBlacklisted(handler.players(i), true);
        }
        uint256 n = handler.matchCount();
        uint256 latest;
        for (uint256 k = 0; k < n; k++) {
            IGameVault.Match memory m = vault.matchOf(handler.matchIds(k));
            if (m.state == IGameVault.MatchState.Locked && m.settleBy > latest) latest = m.settleBy;
        }
        if (latest != 0) vm.warp(latest + 1);
        for (uint256 k = 0; k < n; k++) {
            bytes32 id = handler.matchIds(k);
            if (vault.matchOf(id).state == IGameVault.MatchState.Locked) vault.refundExpired(id);
        }
        token.setPaused(false);
        token.setTax(0);
        for (uint256 i = 0; i < 4; i++) {
            if (i % 2 == 1) token.setBlacklisted(handler.players(i), false);
        }
        if (!vault.paused()) {
            vm.prank(owner);
            vault.pause();
        }
        address clean = handler.CLEAN();
        address cold = handler.HOUSE_COLD();
        for (uint256 i = 0; i < 4; i++) {
            address p = handler.players(i);
            assertEq(vault.lockedOf(p), 0);
            uint256 f = vault.freeOf(p);
            if (f == 0) continue;
            vm.prank(p);
            if (i % 2 == 0) vault.withdrawTo(f, clean);
            else vault.withdraw(f);
        }
        uint256 fees = vault.houseAccrued();
        if (fees != 0) {
            vm.prank(house);
            vault.withdrawHouseTo(fees, cold);
        }
        assertEq(vault.totalLiabilities(), 0);
        assertEq(token.balanceOf(address(vault)), handler.ghostSurplus(), "only the surplus is left");
        vm.revertToState(snap);
    }

    /// How much of the state space a run reached (forge test -vv).
    function afterInvariant() external view {
        console2.log(
            "locks / session-key sides / defective locks refused",
            handler.locks(),
            handler.sessionLocks(),
            handler.defectiveLocksRefused()
        );
        console2.log("settles / holder fee / mutual", handler.settles(), handler.holderSettles(), handler.mutuals());
        console2.log("voids / refunds / reclaims", handler.voids(), handler.refunds(), handler.reclaims());
        console2.log(
            "cancels / referee rotations / old-referee settles",
            handler.cancels(),
            handler.rotations(),
            handler.oldRefereeSettles()
        );
        console2.log(
            "taxed exits / blacklisted exits / surplus credits",
            handler.taxedExits(),
            handler.blacklistedExits(),
            handler.surplusCredits()
        );
    }
}
