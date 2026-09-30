// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity 0.8.37;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IGameVault, OUTCOME_WIN, OUTCOME_VOID, VOID_TIMEOUT} from "../src/interfaces/IGameVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";
import {MaxWalletToken, MockERC20, ReflectionToken, SenderTaxToken} from "./mocks/Tokens.sol";

/// Regression tests for the security review of the vault. Each one asserts the property a finding showed broken (or,
/// for the stolen session key, the bound the contract really gives: docs/WAGER.md §2).
contract HardeningTest is VaultTestBase {
    bytes32 internal M1;

    function setUp() public override {
        super.setUp();
        M1 = _mid(alice, keccak256("hardening-1"));
    }

    function _pairEntries(bytes32 id, address a, address b, uint128 stake)
        internal
        view
        returns (IGameVault.Entry memory ea, IGameVault.Entry memory eb)
    {
        ea = _entry(id, a, address(0), stake);
        eb = _entry(id, b, a, stake);
    }

    function _tryLock(IGameVault.Entry memory a, bytes memory sa, IGameVault.Entry memory b, bytes memory sb)
        internal
        returns (bool ok)
    {
        (ok,) = address(vault).call(abi.encodeCall(vault.lock, (a, sa, b, sb)));
    }

    // =================================================================================================================
    // Session keys
    // =================================================================================================================

    /// A thief holding only alice's session key (and his own funded wallet) can pair her against himself and have her
    /// lose (the relay seats the key as her). The vault's bound: never more than what the key's cap has left, and
    /// nothing once she revokes it. The relay has to hold forfeits like this for review (docs/WAGER.md §2, §6.3).
    function test_stolenSessionKey_movesAtMostWhatItsCapHasLeft() public {
        _deposit(alice, 10_000e18);
        _openSession(alicePk, aliceKey, 1_000e18, 3_000e18); // the page's default now: cap = 3 x maxStake
        (address thief, uint256 thiefPk) = makeAddrAndKey("thief");
        _deposit(thief, 10_000e18);
        uint256 i;
        for (; i < 5; i++) {
            bytes32 id = _mid(alice, keccak256(abi.encode("theft", i)));
            IGameVault.Entry memory a = _entry(id, alice, thief, 1_000e18);
            IGameVault.Entry memory t = _entry(id, thief, alice, 1_000e18);
            if (!_tryLock(a, _signEntry(aliceKeyPk, a), t, _signEntry(thiefPk, t))) break;
            _settle(id, thief, FEE);
        }
        assertEq(i, 3, "the fourth lock is past the cap");
        assertEq(vault.freeOf(alice), 7_000e18, "alice lost exactly the cap");
        // No-shows and voided matches don't open a way round the cap: only played matches spend it.
        vm.prank(alice);
        vault.revokeSession();
        bytes32 later = _mid(alice, keccak256("after revoke"));
        IGameVault.Entry memory a2 = _entry(later, alice, thief, 1_000e18);
        IGameVault.Entry memory t2 = _entry(later, thief, alice, 1_000e18);
        bytes memory sa2 = _signEntry(aliceKeyPk, a2);
        bytes memory st2 = _signEntry(thiefPk, t2);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, alice));
        vault.lock(a2, sa2, t2, st2);
    }

    /// Voided matches (no-shows, relay errors, timeouts, mutual voids) give their stake back to the session cap while
    /// that session is still the player's; a griefer who joins and never shows can't use it up.
    function test_voids_giveTheStakeBackToTheSessionCap() public {
        _deposit(alice, 1_000e18);
        _deposit(bob, 1_000e18);
        _openSession(alicePk, aliceKey, 100e18, 300e18);
        _openSession(bobPk, bobKey, 100e18, 1_000e18);
        for (uint256 i = 0; i < 5; i++) {
            bytes32 id = _mid(alice, keccak256(abi.encode("no-show", i)));
            _lock(id, 100e18);
            assertEq(vault.sessionOf(alice).used, 100e18);
            if (i % 3 == 0) {
                _void(id);
            } else if (i % 3 == 1) {
                IGameVault.Result memory v = _result(id, OUTCOME_VOID, address(0), 0);
                vault.settleMutual(v, _signResult(alicePk, v), _signResult(bobPk, v));
            } else {
                vm.warp(vault.matchOf(id).settleBy + 1);
                vault.refundExpired(id);
            }
            assertEq(vault.sessionOf(alice).used, 0, "a void doesn't count against the cap");
        }
        // A played match does count.
        bytes32 played = _mid(alice, keccak256("played"));
        _lock(played, 100e18);
        _settle(played, bob, FEE);
        assertEq(vault.sessionOf(alice).used, 100e18);
        // A void only credits the session that entered it: a replaced session keeps its own count.
        bytes32 old = _mid(alice, keccak256("old session"));
        _lock(old, 100e18);
        _openSession(alicePk, aliceKey, 100e18, 300e18); // a fresh session: used 0
        bytes32 fresh = _mid(alice, keccak256("new session"));
        _lock(fresh, 100e18);
        _void(old);
        assertEq(vault.sessionOf(alice).used, 100e18, "the old session's void leaves the new session's count alone");
        _void(fresh);
        assertEq(vault.sessionOf(alice).used, 0);
    }

    // =================================================================================================================
    // Match ids, open Entries, cancel
    // =================================================================================================================

    /// A match id starts with its creator's address: nobody else can burn a published id by locking it first (with
    /// accounts of their own), and the joiner can't submit the pair the other way round to take seat A.
    function test_matchId_onlyItsCreatorCanBePlayerA() public {
        _ready(1_000e18);
        (address m1, uint256 m1Pk) = makeAddrAndKey("mallory 1");
        (address m2, uint256 m2Pk) = makeAddrAndKey("mallory 2");
        _deposit(m1, 1);
        _deposit(m2, 1);
        (IGameVault.Entry memory s1, IGameVault.Entry memory s2) = _pairEntries(M1, m1, m2, 1);
        bytes memory sig1 = _signEntry(m1Pk, s1);
        bytes memory sig2 = _signEntry(m2Pk, s2);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadMatchId.selector, M1));
        vault.lock(s1, sig1, s2, sig2);

        (IGameVault.Entry memory a, IGameVault.Entry memory b) = _pairEntries(M1, alice, bob, 100e18);
        bytes memory sigA = _signEntry(aliceKeyPk, a);
        bytes memory sigB = _signEntry(bobKeyPk, b);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadMatchId.selector, M1));
        vault.lock(b, sigB, a, sigA); // the joiner in seat A
        vm.prank(relayer);
        vault.lock(a, sigA, b, sigB);
        assertEq(vault.matchOf(M1).playerA, alice);
    }

    /// An open Entry (opponent 0) pairs with anyone who has it: the relay must never hand one out before the lock
    /// (docs/WAGER.md §4.3: the creator re-signs a named Entry for the joiner). A named Entry pairs only with its
    /// opponent, and the creator can kill any Entry of theirs on-chain by cancelling the id.
    function test_openEntry_pairsWithAnyone_namedEntryOnlyItsOpponent_cancelKillsBoth() public {
        _ready(1_000e18);
        _deposit(carol, 1_000e18);
        // A bearer signature: whoever holds alice's open Entry can pair it (here carol).
        IGameVault.Entry memory open = _entry(M1, alice, address(0), 100e18);
        IGameVault.Entry memory byCarol = _entry(M1, carol, alice, 100e18);
        vault.lock(open, _signEntry(alicePk, open), byCarol, _signEntry(carolPk, byCarol));
        assertEq(vault.matchOf(M1).playerB, carol);

        // Named for bob: carol can't pair it.
        bytes32 m2 = _mid(alice, keccak256("named"));
        IGameVault.Entry memory named = _entry(m2, alice, bob, 100e18);
        IGameVault.Entry memory carol2 = _entry(m2, carol, alice, 100e18);
        bytes memory sigNamed = _signEntry(alicePk, named);
        bytes memory sigCarol2 = _signEntry(carolPk, carol2);
        vm.expectRevert(IGameVault.EntryMismatch.selector);
        vault.lock(named, sigNamed, carol2, sigCarol2);

        // The creator cancels the id (wallet-signed or not, session revoked or not): nothing for it locks again.
        vm.expectEmit(true, true, false, false, address(vault));
        emit IGameVault.MatchCancelled(m2, alice);
        vm.prank(alice);
        vault.cancel(m2);
        assertEq(uint8(vault.matchOf(m2).state), uint8(IGameVault.MatchState.Cancelled));
        IGameVault.Entry memory byBob = _entry(m2, bob, alice, 100e18);
        bytes memory sigBob = _signEntry(bobPk, byBob);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.MatchExists.selector, m2));
        vault.lock(named, sigNamed, byBob, sigBob);
    }

    function test_cancel_onlyTheCreatorOnlyUnusedAndNeverPaused() public {
        _ready(1_000e18);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadMatchId.selector, M1));
        vault.cancel(M1);
        vm.prank(owner);
        vault.pause();
        vm.prank(alice);
        vault.cancel(M1); // paused or not
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.MatchExists.selector, M1));
        vault.cancel(M1);
        vm.prank(owner);
        vault.unpause();
        bytes32 id = _mid(alice, keccak256("locked"));
        _lock(id, 10e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.MatchExists.selector, id));
        vault.cancel(id);
        assertEq(vault.lockedOf(alice), 10e18, "a locked match is not cancellable");
    }

    /// A player's fee cap bounds what they pay; it can't sign the house's fee away (lock refuses it).
    function test_feeCap_cannotSignTheHouseFeeAway() public {
        _ready(1_000e18);
        (IGameVault.Entry memory a, IGameVault.Entry memory b) = _pairEntries(M1, alice, bob, 100e18);
        b.feeCapBps = 0;
        bytes memory sigA = _signEntry(aliceKeyPk, a);
        bytes memory sigB = _signEntry(bobKeyPk, b);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.FeeAboveCap.selector, bob, FEE, 0));
        vault.lock(a, sigA, b, sigB);
    }

    // =================================================================================================================
    // Referee and owner
    // =================================================================================================================

    /// A win signed before a referee rotation still pays the winner (it used to fall through to a refund).
    function test_refereeRotation_signedWinStillPays() public {
        _ready(1_000e18);
        _lock(M1, 1_000e18);
        IGameVault.Result memory r = _result(M1, OUTCOME_WIN, alice, FEE);
        bytes memory sig = _signResult(refereePk, r);
        (address next,) = makeAddrAndKey("next referee");
        vm.prank(owner);
        vault.setReferee(next);
        vault.settle(r, sig);
        assertEq(vault.freeOf(alice), 1_940e18);
    }

    /// The owner's key can't decide a live match by appointing a referee of its own, and can't leave the vault without
    /// an owner.
    function test_owner_cannotDecideALiveMatchOrRenounce() public {
        _ready(1_000e18);
        _lock(M1, 1_000e18);
        (address evil, uint256 evilPk) = makeAddrAndKey("owner-appointed referee");
        vm.prank(owner);
        vault.setReferee(evil);
        IGameVault.Result memory r = _result(M1, OUTCOME_WIN, bob, HOLDER_FEE);
        bytes memory sig = _signResult(evilPk, r);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, referee));
        vault.settle(r, sig);
        vm.prank(owner);
        vm.expectRevert(IGameVault.RenounceDisabled.selector);
        vault.renounceOwnership();
        assertEq(vault.owner(), owner);
    }

    // =================================================================================================================
    // Reclaim (a counterparty the chain refuses)
    // =================================================================================================================

    /// After settleBy each player takes back their own stake in a transaction that names only them: a player never
    /// needs a transaction that involves the other (whom the chain's screening or the token may refuse).
    function test_reclaim_eachSideAloneAfterTheWindow() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        uint64 settleBy = vault.matchOf(M1).settleBy;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.SettleWindowOpen.selector, M1, settleBy));
        vault.reclaim(M1);
        vm.warp(settleBy + 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.NothingToReclaim.selector, M1, stranger));
        vault.reclaim(M1);

        vm.recordLogs();
        vm.prank(alice);
        vault.reclaim(M1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], IGameVault.StakeReclaimed.selector);
        assertEq(logs[0].topics[1], M1);
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(alice))));
        assertEq(abi.decode(logs[0].data, (uint256)), 100e18);
        for (uint256 i = 0; i < logs[0].topics.length; i++) {
            assertTrue(logs[0].topics[i] != bytes32(uint256(uint160(bob))), "bob is not in alice's transaction");
        }
        assertEq(vault.freeOf(alice), 1_000e18);
        assertEq(vault.lockedOf(alice), 0);
        assertEq(vault.lockedOf(bob), 100e18, "bob's stake waits for him (or a refund)");
        assertEq(vault.sessionOf(alice).used, 0, "a reclaimed stake is back in the session cap");
        assertEq(uint8(vault.matchOf(M1).state), uint8(IGameVault.MatchState.Locked));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.NothingToReclaim.selector, M1, alice));
        vault.reclaim(M1);

        // The ordinary refund then releases bob's side only.
        vm.expectEmit(true, true, true, true, address(vault));
        emit IGameVault.MatchVoided(M1, alice, bob, VOID_TIMEOUT, bytes32(0));
        vault.refundExpired(M1);
        assertEq(vault.freeOf(alice), 1_000e18);
        assertEq(vault.freeOf(bob), 1_000e18);
        assertEq(uint8(vault.matchOf(M1).state), uint8(IGameVault.MatchState.Voided));
        _assertBooks(_players());
    }

    function test_reclaim_bothSidesCloseTheMatch() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        vm.warp(vault.matchOf(M1).settleBy + 1);
        vm.prank(owner);
        vault.pause(); // never paused
        vm.prank(bob);
        vault.reclaim(M1);
        vm.prank(alice);
        vault.reclaim(M1);
        assertEq(uint8(vault.matchOf(M1).state), uint8(IGameVault.MatchState.Voided));
        vm.expectRevert(abi.encodeWithSelector(IGameVault.NotLocked.selector, M1));
        vault.refundExpired(M1);
        assertEq(vault.freeOf(alice) + vault.freeOf(bob), 2_000e18);
        _assertBooks(_players());
    }

    // =================================================================================================================
    // Odd tokens: taxes and reflections switched on later, transfer limits, direct transfers
    // =================================================================================================================

    function _fundWith(address t, uint256 amount) internal {
        token = IERC20(t);
        vault = _newVault(t);
        address[3] memory ps = [alice, bob, carol];
        for (uint256 i = 0; i < 3; i++) {
            if (amount != 0) MockERC20(t).mint(ps[i], amount);
            vm.prank(ps[i]);
            IERC20(t).approve(address(vault), type(uint256).max);
        }
    }

    /// A sender-side tax the token's owner switches on after deposits (the deploy probe saw none): nobody is trapped.
    /// Each withdrawer pays the tax out of their own balance, the house too, and the vault stays exactly solvent.
    function test_senderTaxSwitchedOnLater_everyoneStillLeaves() public {
        SenderTaxToken t = new SenderTaxToken(0);
        _fundWith(address(t), 1_000e18);
        vm.prank(alice);
        vault.deposit(1_000e18);
        vm.prank(bob);
        vault.deposit(1_000e18);
        _openSession(alicePk, aliceKey, MAX_STAKE, 10 * MAX_STAKE);
        _openSession(bobPk, bobKey, MAX_STAKE, 10 * MAX_STAKE);
        _lock(M1, 100e18);
        _settle(M1, alice, FEE);
        t.setFee(1); // 0.01% on the sender, after the fact

        vm.prank(alice);
        vault.withdraw(900e18);
        assertEq(t.balanceOf(alice), 900e18);
        assertEq(vault.freeOf(alice), 1_094e18 - 900e18 - 0.09e18);
        // Everything but the tax: free / (1 + tax).
        uint256 bobFree = vault.freeOf(bob);
        uint256 most = bobFree * 10_000 / 10_001;
        vm.prank(bob);
        vault.withdrawTo(most, carol);
        assertEq(t.balanceOf(carol), 1_000e18 + most);
        // The house takes its fees in the same way: all of them minus the tax.
        uint256 fees = vault.houseAccrued();
        vm.prank(house);
        vault.withdrawHouseTo(fees * 10_000 / 10_001, house);
        assertLe(vault.houseAccrued(), 1);
        assertEq(t.balanceOf(address(vault)), vault.totalLiabilities(), "solvent to the unit");
    }

    /// A reflection fee switched on after deposits: a payout lowers the vault's balance by less than it pays, so the
    /// vault only gains. Withdrawals keep working, and the owner can credit the surplus out.
    function test_reflectionSwitchedOnLater_withdrawalsStillWork() public {
        ReflectionToken t = new ReflectionToken(address(this));
        token = IERC20(address(t));
        vault = _newVault(address(t));
        require(t.transfer(alice, 2_000e18) && t.transfer(bob, 2_000e18));
        vm.prank(alice);
        t.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        t.approve(address(vault), type(uint256).max);
        vm.prank(alice);
        vault.deposit(1_000e18);
        vm.prank(bob);
        vault.deposit(1_000e18);
        t.setFee(200);
        vm.prank(alice);
        vault.withdraw(100e18);
        assertEq(vault.freeOf(alice), 900e18, "the reflection costs the vault nothing extra");
        vm.prank(bob);
        vault.withdraw(1_000e18);
        uint256 bal = t.balanceOf(address(vault));
        uint256 owed = vault.totalLiabilities();
        assertGe(bal, owed, "solvent");
        // Deposits are refused while the fee is on (the vault takes only exact transfers).
        vm.prank(alice);
        vm.expectRevert();
        vault.deposit(10e18);
        // The surplus the reflections left can go back to a player, never more than it.
        vm.prank(owner);
        vault.creditSurplus(bob, bal - owed);
        assertEq(t.balanceOf(address(vault)), vault.totalLiabilities());
    }

    /// Fees past a token's max-transaction size leave in parts (withdrawHouse sends them all at once and can't).
    function test_houseFeesAboveMaxTx_leaveInParts() public {
        MaxWalletToken t = new MaxWalletToken(500e18, type(uint256).max);
        _fundWith(address(t), 10_000e18);
        for (uint256 i = 0; i < 20; i++) {
            vm.prank(alice);
            vault.deposit(500e18);
            vm.prank(bob);
            vault.deposit(500e18);
        }
        _openSession(alicePk, aliceKey, MAX_STAKE, 100 * MAX_STAKE);
        _openSession(bobPk, bobKey, MAX_STAKE, 100 * MAX_STAKE);
        for (uint256 i = 0; i < 9; i++) {
            bytes32 id = _mid(alice, keccak256(abi.encode("house", i)));
            _lock(id, MAX_STAKE);
            _settle(id, i % 2 == 0 ? alice : bob, FEE);
        }
        assertEq(vault.houseAccrued(), 540e18);
        vm.expectRevert(MaxWalletToken.MaxTx.selector);
        vault.withdrawHouse();
        vm.startPrank(house);
        vault.withdrawHouseTo(500e18, house);
        vault.withdrawHouseTo(40e18, house);
        vm.stopPrank();
        assertEq(t.balanceOf(house), 540e18);
        assertEq(vault.houseAccrued(), 0);
    }

    /// Tokens sent straight to the vault (a wallet's plain send instead of deposit) are owed to nobody; the owner can
    /// credit them to the sender, and never more than the surplus.
    function test_directTransfer_ownerCreditsTheSurplusBack() public {
        _deposit(alice, 100e18);
        _fund(bob, 50e18);
        vm.prank(bob);
        require(token.transfer(address(vault), 50e18));
        assertEq(token.balanceOf(address(vault)), vault.totalLiabilities() + 50e18);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        vault.creditSurplus(bob, 50e18);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.SurplusExceeded.selector, 50e18, 50e18 + 1));
        vault.creditSurplus(bob, 50e18 + 1);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IGameVault.SurplusCredited(bob, 50e18);
        vm.prank(owner);
        vault.creditSurplus(bob, 50e18);
        assertEq(vault.freeOf(bob), 50e18);
        assertEq(token.balanceOf(address(vault)), vault.totalLiabilities());
        // Nothing left: every token in the vault is owed to someone, and the owner can't credit any of it.
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.SurplusExceeded.selector, 0, 1));
        vault.creditSurplus(carol, 1);
        vm.prank(bob);
        vault.withdraw(50e18);
        assertEq(token.balanceOf(bob), 50e18);
    }

    /// The vault never pays itself: a withdrawal to the vault's own address takes nothing from it and is refused.
    function test_withdrawToTheVaultItselfRefused() public {
        _deposit(alice, 10e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.TransferMismatch.selector, 1e18, 0));
        vault.withdrawTo(1e18, address(vault));
    }

    /// Pausing never touches the exits added for odd tokens.
    function test_newExitsAreNeverPaused() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        _settle(M1, alice, FEE);
        vm.prank(owner);
        vault.pause();
        assertTrue(vault.paused());
        vm.prank(house);
        vault.withdrawHouseTo(1e18, house);
        _fund(carol, 1e18);
        vm.prank(carol);
        require(token.transfer(address(vault), 1e18));
        vm.prank(owner);
        vault.creditSurplus(carol, 1e18);
        vm.prank(carol);
        vault.withdraw(1e18);
        IGameVault.Entry memory a = _entry(_mid(alice, "p"), alice, address(0), 1e18);
        IGameVault.Entry memory b = _entry(_mid(alice, "p"), bob, alice, 1e18);
        bytes memory sa = _signEntry(aliceKeyPk, a);
        bytes memory sb = _signEntry(bobKeyPk, b);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.lock(a, sa, b, sb);
    }
}
