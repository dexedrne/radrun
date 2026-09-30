// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity 0.8.37;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {GameVault} from "../../src/GameVault.sol";
import {TestSpiderTag} from "../../src/TestSpiderTag.sol";
import {IGameVault} from "../../src/interfaces/IGameVault.sol";
import {VaultHandler} from "./VaultHandler.sol";

/// Handler-based invariants (docs/WAGER.md §9.1 I1-I7): players, their session keys, the owner, the referee, a relayer
/// and a stranger call everything in random order with time warps.
contract VaultInvariantsTest is Test {
    GameVault internal vault;
    TestSpiderTag internal token;
    VaultHandler internal handler;
    address internal owner = makeAddr("owner");
    address internal house = makeAddr("house");

    function setUp() public {
        vm.warp(1_800_000_000);
        uint256 refereePk = uint256(keccak256("referee"));
        address handlerAddr = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        token = new TestSpiderTag(handlerAddr);
        vault = new GameVault(
            IERC20Metadata(address(token)), house, vm.addr(refereePk), owner, 300, 150, 5_000e18, 100_000e18, 1 days
        );
        handler = new VaultHandler(vault, token, owner, house, refereePk);
        require(address(handler) == handlerAddr, "handler address");
        targetContract(address(handler));
    }

    /// I1: the vault always holds at least what it owes.
    function invariant_I1_solvent() public view {
        assertGe(token.balanceOf(address(vault)), vault.totalLiabilities());
    }

    /// I2: totalLiabilities == Σfree + Σlocked + houseAccrued (every balance belongs to one of the handler's players).
    function invariant_I2_books() public view {
        uint256 sum = vault.houseAccrued();
        for (uint256 i = 0; i < 4; i++) {
            address p = handler.players(i);
            sum += vault.freeOf(p) + vault.lockedOf(p);
        }
        assertEq(sum, vault.totalLiabilities());
        // With a plain token nothing else ever reaches the vault: the books match its balance exactly.
        assertEq(token.balanceOf(address(vault)), vault.totalLiabilities());
    }

    /// I3: Σlocked == Σ over Locked matches of 2 x stake, per player too.
    function invariant_I3_lockedMatchesStakes() public view {
        uint256[4] memory perPlayer;
        uint256 total;
        uint256 n = handler.matchCount();
        for (uint256 k = 0; k < n; k++) {
            IGameVault.Match memory m = vault.matchOf(handler.matchIds(k));
            if (m.state != IGameVault.MatchState.Locked) continue;
            total += 2 * uint256(m.stake);
            for (uint256 i = 0; i < 4; i++) {
                address p = handler.players(i);
                if (p == m.playerA || p == m.playerB) perPlayer[i] += m.stake;
            }
        }
        uint256 sumLocked;
        for (uint256 i = 0; i < 4; i++) {
            uint256 l = vault.lockedOf(handler.players(i));
            assertEq(l, perPlayer[i], "per player");
            sumLocked += l;
        }
        assertEq(sumLocked, total);
    }

    /// I4: a player's free balance only drops through their own withdraw or a lock carrying their signature, and no
    /// stranger ever got a call through that needs someone else's key.
    function invariant_I4_onlyOwnActionsSpendFree() public view {
        assertEq(handler.illegalFreeDrops(), 0, "illegal free-balance drops");
        assertEq(handler.strangerSuccesses(), 0, "stranger or session-key call went through");
    }

    /// I5: after settleBy every still-Locked match can be refunded by anyone, paused or not.
    function invariant_I5_expiredAlwaysRefundable() public {
        uint256 snap = vm.snapshotState();
        uint256 n = handler.matchCount();
        uint256 latest;
        for (uint256 k = 0; k < n; k++) {
            IGameVault.Match memory m = vault.matchOf(handler.matchIds(k));
            if (m.state == IGameVault.MatchState.Locked && m.settleBy > latest) latest = m.settleBy;
        }
        if (latest != 0) {
            vm.warp(latest + 1);
            if (!vault.paused()) {
                vm.prank(owner);
                vault.pause();
            }
            for (uint256 k = 0; k < n; k++) {
                bytes32 id = handler.matchIds(k);
                if (vault.matchOf(id).state != IGameVault.MatchState.Locked) continue;
                vm.prank(makeAddr("anyone"));
                vault.refundExpired(id); // reverts the invariant if it can't
            }
            for (uint256 i = 0; i < 4; i++) {
                assertEq(vault.lockedOf(handler.players(i)), 0);
            }
        }
        vm.revertToState(snap);
    }

    /// I6: every player can withdraw their whole free balance, paused or not.
    function invariant_I6_fullWithdrawAlwaysWorks() public {
        uint256 snap = vm.snapshotState();
        if (!vault.paused()) {
            vm.prank(owner);
            vault.pause();
        }
        for (uint256 i = 0; i < 4; i++) {
            address p = handler.players(i);
            uint256 free_ = vault.freeOf(p);
            if (free_ == 0) continue;
            uint256 before = token.balanceOf(p);
            vm.prank(p);
            vault.withdraw(free_);
            assertEq(token.balanceOf(p) - before, free_);
            assertEq(vault.freeOf(p), 0);
        }
        vm.revertToState(snap);
    }

    /// I7: house fees only ever leave to the house, and every fee charged is either accrued or at the house.
    function invariant_I7_houseFeesOnlyToHouse() public view {
        assertEq(token.balanceOf(house), handler.houseWithdrawn());
        assertEq(handler.houseWithdrawn() + vault.houseAccrued(), handler.feesCharged());
    }

    /// Logs how much of the state space a run reached (forge test -vv).
    function afterInvariant() external view {
        console2.log("locks", handler.successfulLocks());
        console2.log("settles", handler.successfulSettles());
        console2.log("refunds", handler.successfulRefunds());
    }
}
