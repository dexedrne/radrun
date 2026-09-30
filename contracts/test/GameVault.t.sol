// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity 0.8.37;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {GameVault} from "../src/GameVault.sol";
import {
    IGameVault,
    OUTCOME_WIN,
    OUTCOME_VOID,
    VOID_REFEREE,
    VOID_MUTUAL,
    VOID_TIMEOUT
} from "../src/interfaces/IGameVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";
import {MockERC20, NoDecimalsToken} from "./mocks/Tokens.sol";

/// Unit tests: every function, every revert of IGameVault and every event with its arguments (docs/WAGER.md §9.1).
contract GameVaultTest is VaultTestBase {
    bytes32 internal M1; // alice's ("match-1")
    bytes32 internal M2; // alice's ("match-2")

    function setUp() public override {
        super.setUp();
        M1 = _mid(alice, keccak256("match-1"));
        M2 = _mid(alice, keccak256("match-2"));
    }

    // =================================================================================================================
    // constructor and views
    // =================================================================================================================

    function test_constructor_storesSettings() public view {
        assertEq(vault.token(), address(token));
        assertEq(vault.house(), house);
        assertEq(vault.referee(), referee);
        assertEq(vault.owner(), owner);
        assertEq(vault.houseFeeBps(), FEE);
        assertEq(vault.holderFeeBps(), HOLDER_FEE);
        assertEq(vault.maxStake(), MAX_STAKE);
        assertEq(vault.maxBalance(), MAX_BALANCE);
        assertEq(vault.settleWindow(), WINDOW);
        assertEq(vault.MAX_FEE_BPS(), 500);
        assertEq(vault.MAX_SESSION_TTL(), 30 days);
        assertFalse(vault.paused());
        assertEq(vault.totalLiabilities(), 0);
        assertEq(vault.houseAccrued(), 0);
    }

    function test_constructor_emitsSettings() public {
        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectEmit(next);
        emit IGameVault.HouseFeesSet(FEE, HOLDER_FEE);
        vm.expectEmit(next);
        emit IGameVault.CapsSet(MAX_STAKE, MAX_BALANCE);
        vm.expectEmit(next);
        emit IGameVault.RefereeSet(referee);
        _newVault(address(token));
    }

    function test_constructor_eip712Domain() public view {
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = vault.eip712Domain();
        assertEq(name, "RadRun GameVault");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifying, address(vault));
    }

    function test_constructor_reverts() public {
        IERC20Metadata t = IERC20Metadata(address(token));
        vm.expectRevert(IGameVault.ZeroAddress.selector);
        new GameVault(
            IERC20Metadata(address(0)), house, referee, owner, FEE, HOLDER_FEE, MAX_STAKE, MAX_BALANCE, WINDOW
        );
        vm.expectRevert(IGameVault.ZeroAddress.selector);
        new GameVault(t, address(0), referee, owner, FEE, HOLDER_FEE, MAX_STAKE, MAX_BALANCE, WINDOW);
        vm.expectRevert(IGameVault.ZeroAddress.selector);
        new GameVault(t, house, address(0), owner, FEE, HOLDER_FEE, MAX_STAKE, MAX_BALANCE, WINDOW);
        vm.expectRevert(IGameVault.ZeroAddress.selector);
        new GameVault(t, house, referee, address(0), FEE, HOLDER_FEE, MAX_STAKE, MAX_BALANCE, WINDOW);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.FeeTooHigh.selector, uint16(501)));
        new GameVault(t, house, referee, owner, 501, HOLDER_FEE, MAX_STAKE, MAX_BALANCE, WINDOW);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.FeeTooHigh.selector, uint16(501)));
        new GameVault(t, house, referee, owner, FEE, 501, MAX_STAKE, MAX_BALANCE, WINDOW);
        vm.expectRevert(IGameVault.BadConfig.selector);
        new GameVault(t, house, referee, owner, FEE, HOLDER_FEE, 0, MAX_BALANCE, WINDOW);
        vm.expectRevert(IGameVault.BadConfig.selector);
        new GameVault(t, house, referee, owner, FEE, HOLDER_FEE, MAX_STAKE, 0, WINDOW);
        vm.expectRevert(IGameVault.BadConfig.selector);
        new GameVault(t, house, referee, owner, FEE, HOLDER_FEE, MAX_STAKE, MAX_BALANCE, 1 hours - 1);
        vm.expectRevert(IGameVault.BadConfig.selector);
        new GameVault(t, house, referee, owner, FEE, HOLDER_FEE, MAX_STAKE, MAX_BALANCE, 7 days + 1);
        // A token must be a contract with decimals().
        vm.expectRevert(IGameVault.BadConfig.selector);
        new GameVault(
            IERC20Metadata(makeAddr("eoa")), house, referee, owner, FEE, HOLDER_FEE, MAX_STAKE, MAX_BALANCE, WINDOW
        );
        address noDec = address(new NoDecimalsToken());
        vm.expectRevert(IGameVault.BadConfig.selector);
        new GameVault(IERC20Metadata(noDec), house, referee, owner, FEE, HOLDER_FEE, MAX_STAKE, MAX_BALANCE, WINDOW);
    }

    function test_constructor_edgeValuesAccepted() public {
        GameVault v =
            new GameVault(IERC20Metadata(address(token)), house, referee, owner, 0, 500, 1, type(uint128).max, 1 hours);
        assertEq(v.houseFeeBps(), 0);
        assertEq(v.holderFeeBps(), 500);
        v = new GameVault(IERC20Metadata(address(token)), house, referee, owner, 500, 0, type(uint128).max, 1, 7 days);
        assertEq(v.settleWindow(), 7 days);
    }

    // =================================================================================================================
    // deposit / depositFor
    // =================================================================================================================

    function test_deposit_creditsFreeAndLiabilities() public {
        _fund(alice, 500e18);
        vm.expectEmit(true, true, false, true, address(vault));
        emit IGameVault.Deposited(alice, alice, 500e18);
        vm.prank(alice);
        vault.deposit(500e18);
        assertEq(vault.freeOf(alice), 500e18);
        assertEq(vault.lockedOf(alice), 0);
        assertEq(vault.totalLiabilities(), 500e18);
        assertEq(token.balanceOf(address(vault)), 500e18);
        assertEq(token.balanceOf(alice), 0);
    }

    function test_depositFor_creditsPlayerPullsFromSender() public {
        _fund(carol, 300e18);
        vm.expectEmit(true, true, false, true, address(vault));
        emit IGameVault.Deposited(bob, carol, 300e18);
        vm.prank(carol);
        vault.depositFor(bob, 300e18);
        assertEq(vault.freeOf(bob), 300e18);
        assertEq(vault.freeOf(carol), 0);
        assertEq(token.balanceOf(carol), 0);
    }

    function test_deposit_reverts() public {
        _fund(alice, MAX_BALANCE + 1);
        vm.startPrank(alice);
        vm.expectRevert(IGameVault.ZeroAmount.selector);
        vault.deposit(0);
        vm.expectRevert(IGameVault.ZeroAddress.selector);
        vault.depositFor(address(0), 1);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BalanceCapExceeded.selector, alice, uint256(MAX_BALANCE)));
        vault.deposit(MAX_BALANCE + 1);
        vault.deposit(MAX_BALANCE);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BalanceCapExceeded.selector, alice, uint256(MAX_BALANCE)));
        vault.deposit(1);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BalanceCapExceeded.selector, alice, uint256(MAX_BALANCE)));
        vault.deposit(type(uint256).max);
        vm.stopPrank();
    }

    function test_deposit_withoutAllowanceReverts() public {
        require(token.transfer(alice, 10e18));
        vm.prank(alice);
        vm.expectRevert();
        vault.deposit(10e18);
    }

    function test_deposit_capCountsLockedBalance() public {
        _ready(MAX_BALANCE);
        _lock(M1, MAX_STAKE);
        _fund(alice, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BalanceCapExceeded.selector, alice, uint256(MAX_BALANCE)));
        vault.deposit(1);
    }

    function test_deposit_winningsMayExceedCapButNoNewDeposit() public {
        _ready(MAX_BALANCE);
        _lock(M1, MAX_STAKE);
        _settle(M1, alice, FEE);
        assertGt(vault.freeOf(alice), MAX_BALANCE, "winnings may exceed maxBalance");
        _fund(alice, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BalanceCapExceeded.selector, alice, uint256(MAX_BALANCE)));
        vault.deposit(1);
    }

    function test_deposit_liabilitiesFitIn128Bits() public {
        MockERC20 big = new MockERC20("Big", "BIG", 18);
        GameVault v = new GameVault(
            IERC20Metadata(address(big)), house, referee, owner, FEE, HOLDER_FEE, MAX_STAKE, type(uint128).max, WINDOW
        );
        big.mint(alice, type(uint128).max);
        big.mint(bob, 1);
        vm.prank(alice);
        big.approve(address(v), type(uint256).max);
        vm.prank(bob);
        big.approve(address(v), type(uint256).max);
        vm.prank(alice);
        v.deposit(type(uint128).max);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BalanceCapExceeded.selector, bob, uint256(type(uint128).max)));
        v.deposit(1);
    }

    function test_deposit_pausedReverts() public {
        _fund(alice, 10e18);
        vm.prank(owner);
        vault.pause();
        vm.startPrank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.deposit(10e18);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.depositFor(bob, 10e18);
        vm.stopPrank();
    }

    // =================================================================================================================
    // withdraw / withdrawTo
    // =================================================================================================================

    function test_withdraw_sendsFreeToCaller() public {
        _deposit(alice, 500e18);
        vm.expectEmit(true, true, false, true, address(vault));
        emit IGameVault.Withdrawn(alice, alice, 200e18);
        vm.prank(alice);
        vault.withdraw(200e18);
        assertEq(vault.freeOf(alice), 300e18);
        assertEq(vault.totalLiabilities(), 300e18);
        assertEq(token.balanceOf(alice), 200e18);
    }

    function test_withdrawTo_sendsElsewhere() public {
        _deposit(alice, 500e18);
        vm.expectEmit(true, true, false, true, address(vault));
        emit IGameVault.Withdrawn(alice, carol, 500e18);
        vm.prank(alice);
        vault.withdrawTo(500e18, carol);
        assertEq(vault.freeOf(alice), 0);
        assertEq(token.balanceOf(carol), 500e18);
    }

    function test_withdraw_reverts() public {
        _deposit(alice, 500e18);
        vm.startPrank(alice);
        vm.expectRevert(IGameVault.ZeroAmount.selector);
        vault.withdraw(0);
        vm.expectRevert(IGameVault.ZeroAddress.selector);
        vault.withdrawTo(1, address(0));
        vm.expectRevert(abi.encodeWithSelector(IGameVault.InsufficientFree.selector, alice, 500e18, 500e18 + 1));
        vault.withdraw(500e18 + 1);
        // Sending to the vault itself would turn a liability into an unowned surplus: the balance does not drop.
        vm.expectRevert(abi.encodeWithSelector(IGameVault.TransferMismatch.selector, 1e18, 0));
        vault.withdrawTo(1e18, address(vault));
        vm.stopPrank();
        // Nobody else can withdraw alice's balance.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.InsufficientFree.selector, bob, 0, 1));
        vault.withdraw(1);
    }

    function test_withdraw_lockedBalanceNotWithdrawable() public {
        _ready(1_000e18);
        _lock(M1, 400e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.InsufficientFree.selector, alice, 600e18, 600e18 + 1));
        vault.withdraw(600e18 + 1);
        vm.prank(alice);
        vault.withdraw(600e18);
    }

    function test_withdraw_worksWhilePaused() public {
        _deposit(alice, 500e18);
        vm.prank(owner);
        vault.pause();
        vm.prank(alice);
        vault.withdraw(100e18);
        vm.prank(alice);
        vault.withdrawTo(400e18, carol);
        assertEq(vault.freeOf(alice), 0);
    }

    // =================================================================================================================
    // sessions
    // =================================================================================================================

    function test_openSession_storesAndEmits() public {
        uint64 expiry = uint64(block.timestamp + 3 days);
        IGameVault.SessionAuth memory a = _auth(alice, aliceKey, 100e18, 1_000e18, expiry);
        bytes memory sig = _sign(alicePk, _hashAuth(a));
        vm.expectEmit(true, true, false, true, address(vault));
        emit IGameVault.SessionOpened(alice, aliceKey, 100e18, 1_000e18, expiry, 0);
        vm.prank(relayer);
        vault.openSession(a, sig);
        IGameVault.Session memory s = vault.sessionOf(alice);
        assertEq(s.key, aliceKey);
        assertEq(s.expiry, expiry);
        assertEq(s.maxStake, 100e18);
        assertEq(s.cap, 1_000e18);
        assertEq(s.used, 0);
        assertEq(vault.sessionNonce(alice), 1);
    }

    function test_openSession_replacesPreviousAndResetsUsed() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        assertEq(vault.sessionOf(alice).used, 100e18);
        (address newKey, uint256 newKeyPk) = makeAddrAndKey("alice new key");
        _openSession(alicePk, newKey, 50e18, 500e18);
        IGameVault.Session memory s = vault.sessionOf(alice);
        assertEq(s.key, newKey);
        assertEq(s.used, 0);
        assertEq(vault.sessionNonce(alice), 2);
        // The old key is dead; the new one works.
        IGameVault.Entry memory a = _entry(M2, alice, address(0), 50e18);
        IGameVault.Entry memory b = _entry(M2, bob, alice, 50e18);
        bytes memory sigB = _signEntry(bobKeyPk, b);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, alice));
        vault.lock(a, _signEntry(aliceKeyPk, a), b, sigB);
        vault.lock(a, _signEntry(newKeyPk, a), b, sigB);
    }

    function test_openSession_reverts() public {
        uint64 exp = uint64(block.timestamp + 1 days);
        IGameVault.SessionAuth memory a = _auth(alice, aliceKey, 100e18, 1_000e18, exp);

        a.player = address(0);
        vm.expectRevert(IGameVault.ZeroAddress.selector);
        vault.openSession(a, _sign(alicePk, _hashAuth(a)));
        a.player = alice;

        a.sessionKey = address(0);
        vm.expectRevert(IGameVault.ZeroAddress.selector);
        vault.openSession(a, _sign(alicePk, _hashAuth(a)));
        a.sessionKey = aliceKey;

        a.nonce = 1;
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadNonce.selector, uint64(0), uint64(1)));
        vault.openSession(a, _sign(alicePk, _hashAuth(a)));
        a.nonce = 0;

        a.maxStake = 0;
        vm.expectRevert(IGameVault.BadSession.selector);
        vault.openSession(a, _sign(alicePk, _hashAuth(a)));
        a.maxStake = 1_000e18 + 1;
        vm.expectRevert(IGameVault.BadSession.selector);
        vault.openSession(a, _sign(alicePk, _hashAuth(a)));
        a.maxStake = 100e18;

        a.expiry = uint64(block.timestamp);
        vm.expectRevert(IGameVault.BadSession.selector);
        vault.openSession(a, _sign(alicePk, _hashAuth(a)));
        a.expiry = uint64(block.timestamp + 30 days + 1);
        vm.expectRevert(IGameVault.BadSession.selector);
        vault.openSession(a, _sign(alicePk, _hashAuth(a)));
        a.expiry = uint64(block.timestamp + 30 days);

        // Signed by someone else (bob, or the session key itself).
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, alice));
        vault.openSession(a, _sign(bobPk, _hashAuth(a)));
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, alice));
        vault.openSession(a, _sign(aliceKeyPk, _hashAuth(a)));
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, alice));
        vault.openSession(a, hex"1234");

        // The edge values themselves are accepted: maxStake == cap, expiry == now + 30 days.
        a.maxStake = a.cap;
        vault.openSession(a, _sign(alicePk, _hashAuth(a)));
    }

    function test_openSession_sameAuthTwiceReverts() public {
        IGameVault.SessionAuth memory a = _auth(alice, aliceKey, 100e18, 1_000e18, uint64(block.timestamp + 1 days));
        bytes memory sig = _sign(alicePk, _hashAuth(a));
        vault.openSession(a, sig);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadNonce.selector, uint64(1), uint64(0)));
        vault.openSession(a, sig);
    }

    function test_openSession_pausedReverts() public {
        IGameVault.SessionAuth memory a = _auth(alice, aliceKey, 100e18, 1_000e18, uint64(block.timestamp + 1 days));
        bytes memory sig = _sign(alicePk, _hashAuth(a));
        vm.prank(owner);
        vault.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.openSession(a, sig);
    }

    function test_revokeSession_deletesAndBumpsNonce() public {
        IGameVault.SessionAuth memory a = _auth(alice, aliceKey, 100e18, 1_000e18, uint64(block.timestamp + 1 days));
        bytes memory sig = _sign(alicePk, _hashAuth(a));
        vm.expectEmit(true, false, false, true, address(vault));
        emit IGameVault.SessionRevoked(alice, 1);
        vm.prank(alice);
        vault.revokeSession(); // kills the unused, already-signed SessionAuth too
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadNonce.selector, uint64(1), uint64(0)));
        vault.openSession(a, sig);

        _openSession(alicePk, aliceKey, 100e18, 1_000e18);
        assertEq(vault.sessionNonce(alice), 2);
        vm.prank(owner);
        vault.pause(); // revoking is never paused
        vm.prank(alice);
        vault.revokeSession();
        IGameVault.Session memory s = vault.sessionOf(alice);
        assertEq(s.key, address(0));
        assertEq(s.expiry, 0);
        assertEq(s.maxStake, 0);
        assertEq(s.cap, 0);
        assertEq(s.used, 0);
        assertEq(vault.sessionNonce(alice), 3);
    }

    function test_revokeSession_stopsLocks() public {
        _ready(1_000e18);
        vm.prank(alice);
        vault.revokeSession();
        IGameVault.Entry memory a = _entry(M1, alice, address(0), 10e18);
        IGameVault.Entry memory b = _entry(M1, bob, alice, 10e18);
        bytes memory sigA = _signEntry(aliceKeyPk, a);
        bytes memory sigB = _signEntry(bobKeyPk, b);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, alice));
        vault.lock(a, sigA, b, sigB);
    }

    // =================================================================================================================
    // lock
    // =================================================================================================================

    function test_lock_movesStakesAndStoresMatch() public {
        _ready(1_000e18);
        IGameVault.Entry memory a = _entry(M1, alice, address(0), 100e18);
        IGameVault.Entry memory b = _entry(M1, bob, alice, 100e18);
        bytes memory sigA = _signEntry(aliceKeyPk, a);
        bytes memory sigB = _signEntry(bobKeyPk, b);
        uint64 settleBy = uint64(block.timestamp + WINDOW);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IGameVault.MatchLocked(M1, alice, bob, 100e18, FEE, HOLDER_FEE, ROUND, RULES, settleBy);
        vm.prank(relayer);
        vault.lock(a, sigA, b, sigB);

        assertEq(vault.freeOf(alice), 900e18);
        assertEq(vault.lockedOf(alice), 100e18);
        assertEq(vault.freeOf(bob), 900e18);
        assertEq(vault.lockedOf(bob), 100e18);
        assertEq(vault.totalLiabilities(), 2_000e18, "lock moves buckets only");
        assertEq(vault.sessionOf(alice).used, 100e18);
        assertEq(vault.sessionOf(bob).used, 100e18);

        IGameVault.Match memory m = vault.matchOf(M1);
        assertEq(m.playerA, alice);
        assertEq(m.playerB, bob);
        assertEq(m.stake, 100e18);
        assertEq(m.feeBps, FEE);
        assertEq(m.holderFeeBps, HOLDER_FEE);
        assertEq(m.roundSeconds, ROUND);
        assertEq(uint8(m.state), uint8(IGameVault.MatchState.Locked));
        assertEq(m.lockedAt, block.timestamp);
        assertEq(m.settleBy, settleBy);
        assertEq(m.rules, RULES);
    }

    function test_lock_namedInviteBothWays() public {
        _ready(1_000e18);
        // Both Entries name each other.
        IGameVault.Entry memory a = _entry(M1, alice, bob, 10e18);
        IGameVault.Entry memory b = _entry(M1, bob, alice, 10e18);
        vault.lock(a, _signEntry(aliceKeyPk, a), b, _signEntry(bobKeyPk, b));
        // Both open ("anyone"): also pairs.
        a = _entry(M2, alice, address(0), 10e18);
        b = _entry(M2, bob, address(0), 10e18);
        vault.lock(a, _signEntry(aliceKeyPk, a), b, _signEntry(bobKeyPk, b));
    }

    function test_lock_walletSignedEntries() public {
        _deposit(alice, 100e18);
        _deposit(bob, 100e18);
        IGameVault.Entry memory a = _entry(M1, alice, address(0), 100e18);
        IGameVault.Entry memory b = _entry(M1, bob, alice, 100e18);
        vault.lock(a, _signEntry(alicePk, a), b, _signEntry(bobPk, b));
        assertEq(vault.lockedOf(alice), 100e18);
        // No session was needed or spent.
        assertEq(vault.sessionOf(alice).used, 0);
    }

    function test_lock_feeCapsMustCoverTheHouseFee() public {
        _ready(1_000e18);
        // A cap under the house fee refuses the lock (either side): a player can't sign the house's fee away.
        IGameVault.Entry memory a = _entry(M1, alice, address(0), 10e18);
        IGameVault.Entry memory b = _entry(M1, bob, alice, 10e18);
        a.feeCapBps = 250;
        bytes memory sigA = _signEntry(aliceKeyPk, a);
        bytes memory sigB = _signEntry(bobKeyPk, b);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.FeeAboveCap.selector, alice, FEE, 250));
        vault.lock(a, sigA, b, sigB);
        a.feeCapBps = FEE;
        b.feeCapBps = 0;
        sigA = _signEntry(aliceKeyPk, a);
        sigB = _signEntry(bobKeyPk, b);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.FeeAboveCap.selector, bob, FEE, 0));
        vault.lock(a, sigA, b, sigB);
        // Caps at or above it capture the house fee itself.
        b.feeCapBps = 500;
        vault.lock(a, sigA, b, _signEntry(bobKeyPk, b));
        IGameVault.Match memory m = vault.matchOf(M1);
        assertEq(m.feeBps, FEE);
        assertEq(m.holderFeeBps, HOLDER_FEE);

        // A house fee under the holder fee pulls the holder fee down with it; a raised fee needs raised caps.
        vm.prank(owner);
        vault.setHouseFees(100, HOLDER_FEE);
        a = _entry(M2, alice, address(0), 10e18);
        b = _entry(M2, bob, alice, 10e18);
        a.feeCapBps = 100;
        vault.lock(a, _signEntry(aliceKeyPk, a), b, _signEntry(bobKeyPk, b));
        m = vault.matchOf(M2);
        assertEq(m.feeBps, 100);
        assertEq(m.holderFeeBps, 100);
    }

    function test_lock_revertsInSpecOrder() public {
        _ready(1_000e18);
        IGameVault.Entry memory a = _entry(M1, alice, address(0), 100e18);
        IGameVault.Entry memory b = _entry(M1, bob, alice, 100e18);

        // 2. match ids
        b.matchId = M2;
        _expectLockRevert(a, b, abi.encodeWithSelector(IGameVault.EntryMismatch.selector));
        b.matchId = M1;
        // 3. players
        b.player = address(0);
        _expectLockRevert(a, b, abi.encodeWithSelector(IGameVault.ZeroAddress.selector));
        b.player = alice;
        _expectLockRevert(a, b, abi.encodeWithSelector(IGameVault.EntryMismatch.selector));
        b.player = bob;
        // 4. opponents: a stranger can't take a named seat, and the joiner must name the creator (or anyone)
        a.opponent = carol;
        _expectLockRevert(a, b, abi.encodeWithSelector(IGameVault.EntryMismatch.selector));
        a.opponent = address(0);
        b.opponent = carol;
        _expectLockRevert(a, b, abi.encodeWithSelector(IGameVault.EntryMismatch.selector));
        b.opponent = alice;
        // 5. stakes
        b.stake = 99e18;
        _expectLockRevert(a, b, abi.encodeWithSelector(IGameVault.EntryMismatch.selector));
        a.stake = 0;
        b.stake = 0;
        _expectLockRevert(a, b, abi.encodeWithSelector(IGameVault.StakeOutOfRange.selector, 0, MAX_STAKE));
        a.stake = MAX_STAKE + 1;
        b.stake = MAX_STAKE + 1;
        _expectLockRevert(a, b, abi.encodeWithSelector(IGameVault.StakeOutOfRange.selector, MAX_STAKE + 1, MAX_STAKE));
        a.stake = 100e18;
        b.stake = 100e18;
        // 6. round length and rules
        b.roundSeconds = 60;
        _expectLockRevert(a, b, abi.encodeWithSelector(IGameVault.EntryMismatch.selector));
        b.roundSeconds = ROUND;
        b.rules = keccak256("other district");
        _expectLockRevert(a, b, abi.encodeWithSelector(IGameVault.EntryMismatch.selector));
        b.rules = RULES;
        // 7. deadlines (inclusive)
        a.deadline = uint64(block.timestamp - 1);
        _expectLockRevert(a, b, abi.encodeWithSelector(IGameVault.EntryExpired.selector, alice, a.deadline));
        a.deadline = uint64(block.timestamp);
        b.deadline = uint64(block.timestamp - 1);
        _expectLockRevert(a, b, abi.encodeWithSelector(IGameVault.EntryExpired.selector, bob, b.deadline));
        b.deadline = uint64(block.timestamp);
        // 8. signatures
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, alice));
        vault.lock(a, _signEntry(carolPk, a), b, _signEntry(bobKeyPk, b));
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, bob));
        vault.lock(a, _signEntry(aliceKeyPk, a), b, _signEntry(aliceKeyPk, b));
        // 9. free balances
        IGameVault.Entry memory a2 = _entry(M1, alice, address(0), 100e18);
        IGameVault.Entry memory c = _entry(M1, carol, alice, 100e18);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.InsufficientFree.selector, carol, 0, 100e18));
        vault.lock(a2, _signEntry(aliceKeyPk, a2), c, _signEntry(carolPk, c));
        // deadline == now is still in time
        vault.lock(a, _signEntry(aliceKeyPk, a), b, _signEntry(bobKeyPk, b));
        // 2. a match id locks once, ever
        _expectLockRevert(a, b, abi.encodeWithSelector(IGameVault.MatchExists.selector, M1));
    }

    function _expectLockRevert(IGameVault.Entry memory a, IGameVault.Entry memory b, bytes memory err) internal {
        bytes memory sigA = _signEntry(aliceKeyPk, a);
        bytes memory sigB = _signEntry(b.player == alice ? aliceKeyPk : bobKeyPk, b);
        vm.expectRevert(err);
        vault.lock(a, sigA, b, sigB);
    }

    function test_lock_sessionLimits() public {
        _deposit(alice, 1_000e18);
        _deposit(bob, 1_000e18);
        _openSession(alicePk, aliceKey, 100e18, 250e18);
        _openSession(bobPk, bobKey, 1_000e18, 10_000e18);

        // stake > session maxStake
        IGameVault.Entry memory a = _entry(M1, alice, address(0), 101e18);
        IGameVault.Entry memory b = _entry(M1, bob, alice, 101e18);
        bytes memory sigB = _signEntry(bobKeyPk, b);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.SessionLimit.selector, alice));
        vault.lock(a, _signEntry(aliceKeyPk, a), b, sigB);

        // used + stake > cap: 100 + 100 fit, the third 100 does not (250 cap)
        for (uint256 i = 0; i < 2; i++) {
            bytes32 id = _mid(alice, keccak256(abi.encode("cap", i)));
            a = _entry(id, alice, address(0), 100e18);
            b = _entry(id, bob, alice, 100e18);
            vault.lock(a, _signEntry(aliceKeyPk, a), b, _signEntry(bobKeyPk, b));
        }
        assertEq(vault.sessionOf(alice).used, 200e18);
        a = _entry(M2, alice, address(0), 100e18);
        b = _entry(M2, bob, alice, 100e18);
        sigB = _signEntry(bobKeyPk, b);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.SessionLimit.selector, alice));
        vault.lock(a, _signEntry(aliceKeyPk, a), b, sigB);
        // exactly up to the cap is fine
        a.stake = 50e18;
        b.stake = 50e18;
        vault.lock(a, _signEntry(aliceKeyPk, a), b, _signEntry(bobKeyPk, b));
        assertEq(vault.sessionOf(alice).used, 250e18);
        // the wallet itself is never limited by the session
        bytes32 id3 = _mid(alice, keccak256("wallet"));
        a = _entry(id3, alice, address(0), 100e18);
        b = _entry(id3, bob, alice, 100e18);
        vault.lock(a, _signEntry(alicePk, a), b, _signEntry(bobKeyPk, b));
    }

    function test_lock_expiredSessionReverts() public {
        _ready(1_000e18);
        uint64 expiry = vault.sessionOf(alice).expiry;
        vm.warp(expiry); // valid while now < expiry
        IGameVault.Entry memory a = _entry(M1, alice, address(0), 10e18);
        IGameVault.Entry memory b = _entry(M1, bob, alice, 10e18);
        bytes memory sigB = _signEntry(bobPk, b);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.SessionLimit.selector, alice));
        vault.lock(a, _signEntry(aliceKeyPk, a), b, sigB);
        vm.warp(expiry - 1);
        a.deadline = uint64(block.timestamp + 60);
        b.deadline = a.deadline;
        vault.lock(a, _signEntry(aliceKeyPk, a), b, _signEntry(bobPk, b));
    }

    function test_lock_pausedReverts() public {
        _ready(1_000e18);
        IGameVault.Entry memory a = _entry(M1, alice, address(0), 10e18);
        IGameVault.Entry memory b = _entry(M1, bob, alice, 10e18);
        bytes memory sigA = _signEntry(aliceKeyPk, a);
        bytes memory sigB = _signEntry(bobKeyPk, b);
        vm.prank(owner);
        vault.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.lock(a, sigA, b, sigB);
        vm.prank(owner);
        vault.unpause();
        vault.lock(a, sigA, b, sigB);
    }

    function test_lock_usesSettingsAtLockTime() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        vm.prank(owner);
        vault.setHouseFees(500, 400);
        // M1 keeps what it captured.
        assertEq(vault.matchOf(M1).feeBps, FEE);
        IGameVault.Entry memory a = _entry(M2, alice, address(0), 100e18);
        IGameVault.Entry memory b = _entry(M2, bob, alice, 100e18);
        a.feeCapBps = 500;
        b.feeCapBps = 500;
        vault.lock(a, _signEntry(aliceKeyPk, a), b, _signEntry(bobKeyPk, b));
        assertEq(vault.matchOf(M2).feeBps, 500);
        assertEq(vault.matchOf(M2).holderFeeBps, 400);
    }

    // =================================================================================================================
    // settle
    // =================================================================================================================

    function test_settle_winPaysWinnerAndHouse() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        IGameVault.Result memory r = _result(M1, OUTCOME_WIN, alice, FEE);
        bytes memory sig = _signResult(refereePk, r);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IGameVault.MatchSettled(M1, alice, bob, 194e18, 6e18, FEE, r.logHash, false);
        vm.prank(relayer);
        vault.settle(r, sig);
        // docs/WAGER.md §3.5: stakes of 100 -> winner +194, house +6.
        assertEq(vault.freeOf(alice), 1_094e18);
        assertEq(vault.lockedOf(alice), 0);
        assertEq(vault.freeOf(bob), 900e18);
        assertEq(vault.lockedOf(bob), 0);
        assertEq(vault.houseAccrued(), 6e18);
        assertEq(vault.totalLiabilities(), 2_000e18);
        assertEq(uint8(vault.matchOf(M1).state), uint8(IGameVault.MatchState.Settled));
        _assertBooks(_players());
    }

    function test_settle_holderFee() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        IGameVault.Result memory r = _result(M1, OUTCOME_WIN, bob, HOLDER_FEE);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IGameVault.MatchSettled(M1, bob, alice, 197e18, 3e18, HOLDER_FEE, r.logHash, false);
        vault.settle(r, _signResult(refereePk, r));
        // A Radbro-holder winner: +197, house +3.
        assertEq(vault.freeOf(bob), 1_097e18);
        assertEq(vault.houseAccrued(), 3e18);
    }

    function test_settle_zeroFee() public {
        vm.prank(owner);
        vault.setHouseFees(0, 0);
        _ready(1_000e18);
        _lock(M1, 100e18);
        _settle(M1, bob, 0);
        assertEq(vault.freeOf(bob), 1_100e18);
        assertEq(vault.houseAccrued(), 0);
    }

    function test_settle_roundingDustGoesToWinner() public {
        _ready(1_000e18);
        _lock(M1, 1); // pot 2 wei, 3% of it rounds to 0
        _settle(M1, alice, FEE);
        assertEq(vault.freeOf(alice), 1_000e18 + 1);
        assertEq(vault.houseAccrued(), 0);
        _lock(M2, 17); // pot 34: fee floor(34 * 300 / 10000) = 1
        _settle(M2, alice, FEE);
        assertEq(vault.houseAccrued(), 1);
        assertEq(vault.freeOf(alice), 1_000e18 + 1 + 17 - 1);
    }

    function test_settle_void() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        IGameVault.Result memory r = _result(M1, OUTCOME_VOID, address(0), 0);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IGameVault.MatchVoided(M1, alice, bob, VOID_REFEREE, r.logHash);
        vault.settle(r, _signResult(refereePk, r));
        assertEq(vault.freeOf(alice), 1_000e18);
        assertEq(vault.freeOf(bob), 1_000e18);
        assertEq(vault.lockedOf(alice) + vault.lockedOf(bob), 0);
        assertEq(vault.houseAccrued(), 0);
        assertEq(uint8(vault.matchOf(M1).state), uint8(IGameVault.MatchState.Voided));
    }

    function test_settle_badResults() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        _expectSettleRevert(_result(M1, OUTCOME_WIN, carol, FEE), IGameVault.BadResult.selector); // not a player
        _expectSettleRevert(_result(M1, OUTCOME_WIN, address(0), FEE), IGameVault.BadResult.selector);
        _expectSettleRevert(_result(M1, OUTCOME_WIN, alice, 500), IGameVault.BadResult.selector); // above captured
        _expectSettleRevert(_result(M1, OUTCOME_WIN, alice, 100), IGameVault.BadResult.selector); // neither value
        _expectSettleRevert(_result(M1, OUTCOME_WIN, alice, 0), IGameVault.BadResult.selector);
        _expectSettleRevert(_result(M1, OUTCOME_VOID, alice, 0), IGameVault.BadResult.selector);
        _expectSettleRevert(_result(M1, OUTCOME_VOID, address(0), FEE), IGameVault.BadResult.selector);
        _expectSettleRevert(_result(M1, 0, alice, FEE), IGameVault.BadResult.selector);
        _expectSettleRevert(_result(M1, 3, alice, FEE), IGameVault.BadResult.selector);
        _settle(M1, alice, FEE);
    }

    function _expectSettleRevert(IGameVault.Result memory r, bytes4 sel) internal {
        bytes memory sig = _signResult(refereePk, r);
        vm.expectRevert(sel);
        vault.settle(r, sig);
    }

    function test_settle_wrongSignerAndStates() public {
        _ready(1_000e18);
        IGameVault.Result memory r = _result(M1, OUTCOME_WIN, alice, FEE);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.NotLocked.selector, M1));
        vault.settle(r, _signResult(refereePk, r));
        _lock(M1, 100e18);
        // Not the referee: a player, the owner's key, the relayer-submitted garbage.
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, referee));
        vault.settle(r, _signResult(alicePk, r));
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, referee));
        vault.settle(r, "");
        // A signature over a different result (the other winner) doesn't carry over.
        IGameVault.Result memory other = _result(M1, OUTCOME_WIN, bob, FEE);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, referee));
        vault.settle(r, _signResult(refereePk, other));
        bytes memory sig = _signResult(refereePk, r);
        vault.settle(r, sig);
        // Settled: nothing applies twice, not even a void.
        vm.expectRevert(abi.encodeWithSelector(IGameVault.NotLocked.selector, M1));
        vault.settle(r, sig);
        IGameVault.Result memory v = _result(M1, OUTCOME_VOID, address(0), 0);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.NotLocked.selector, M1));
        vault.settle(v, _signResult(refereePk, v));
        vm.expectRevert(abi.encodeWithSelector(IGameVault.NotLocked.selector, M1));
        vault.refundExpired(M1);
    }

    function test_settle_windowCloses() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        uint64 settleBy = vault.matchOf(M1).settleBy;
        IGameVault.Result memory r = _result(M1, OUTCOME_WIN, alice, FEE);
        bytes memory sig = _signResult(refereePk, r);
        vm.warp(settleBy + 1);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.SettleWindowClosed.selector, M1, settleBy));
        vault.settle(r, sig);
        vm.warp(settleBy); // settleBy itself is still in the window
        vault.settle(r, sig);
    }

    function test_settle_worksWhilePaused() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        _lock(M2, 100e18);
        vm.prank(owner);
        vault.pause();
        _settle(M1, alice, FEE);
        _void(M2);
        vm.warp(block.timestamp + WINDOW + 1);
        assertEq(vault.lockedOf(alice), 0);
    }

    function test_setReferee_appliesToLaterLocksOnly() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        IGameVault.Result memory r = _result(M1, OUTCOME_WIN, alice, FEE);
        bytes memory signedBefore = _signResult(refereePk, r); // signed, not yet submitted
        (address newRef, uint256 newRefPk) = makeAddrAndKey("new referee");
        vm.expectEmit(true, false, false, true, address(vault));
        emit IGameVault.RefereeSet(newRef);
        vm.prank(owner);
        vault.setReferee(newRef);
        assertEq(vault.referee(), newRef);
        assertEq(vault.refereeOf(M1), referee, "a live match keeps the referee it locked under");
        // The new key can't decide a match locked before it ...
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, referee));
        vault.settle(r, _signResult(newRefPk, r));
        // ... and the Result signed before the rotation still pays the winner.
        vault.settle(r, signedBefore);
        assertEq(vault.freeOf(alice), 1_094e18);

        // Matches locked after the rotation take the new referee only.
        _lock(M2, 100e18);
        assertEq(vault.refereeOf(M2), newRef);
        IGameVault.Result memory r2 = _result(M2, OUTCOME_WIN, bob, FEE);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, newRef));
        vault.settle(r2, _signResult(refereePk, r2));
        vault.settle(r2, _signResult(newRefPk, r2));
        assertEq(vault.refereeOf(keccak256("never locked")), address(0));
    }

    // =================================================================================================================
    // settleMutual
    // =================================================================================================================

    function test_settleMutual_win() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        IGameVault.Result memory r = _result(M1, OUTCOME_WIN, bob, FEE);
        bytes memory sigA = _signResult(alicePk, r);
        bytes memory sigB = _signResult(bobPk, r);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IGameVault.MatchSettled(M1, bob, alice, 194e18, 6e18, FEE, r.logHash, true);
        vault.settleMutual(r, sigA, sigB);
        assertEq(vault.freeOf(bob), 1_094e18);
        assertEq(vault.houseAccrued(), 6e18);
    }

    function test_settleMutual_void() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        IGameVault.Result memory r = _result(M1, OUTCOME_VOID, address(0), 0);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IGameVault.MatchVoided(M1, alice, bob, VOID_MUTUAL, r.logHash);
        vault.settleMutual(r, _signResult(alicePk, r), _signResult(bobPk, r));
        assertEq(vault.freeOf(alice), 1_000e18);
        assertEq(vault.freeOf(bob), 1_000e18);
    }

    function test_settleMutual_reverts() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        IGameVault.Result memory r = _result(M1, OUTCOME_WIN, alice, FEE);
        // Session keys can't sign a mutual settle (a stolen key plus a colluding opponent could otherwise "lose").
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, alice));
        vault.settleMutual(r, _signResult(aliceKeyPk, r), _signResult(bobPk, r));
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, bob));
        vault.settleMutual(r, _signResult(alicePk, r), _signResult(bobKeyPk, r));
        // The referee's key is not a player's.
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, alice));
        vault.settleMutual(r, _signResult(refereePk, r), _signResult(bobPk, r));
        // Swapped signatures.
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, alice));
        vault.settleMutual(r, _signResult(bobPk, r), _signResult(alicePk, r));
        // Players can't award themselves the holder discount.
        IGameVault.Result memory h = _result(M1, OUTCOME_WIN, alice, HOLDER_FEE);
        vm.expectRevert(IGameVault.BadResult.selector);
        vault.settleMutual(h, _signResult(alicePk, h), _signResult(bobPk, h));
        // Window.
        uint64 settleBy = vault.matchOf(M1).settleBy;
        bytes memory sigA = _signResult(alicePk, r);
        bytes memory sigB = _signResult(bobPk, r);
        vm.warp(settleBy + 1);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.SettleWindowClosed.selector, M1, settleBy));
        vault.settleMutual(r, sigA, sigB);
        vm.warp(settleBy);
        vault.settleMutual(r, sigA, sigB);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.NotLocked.selector, M1));
        vault.settleMutual(r, sigA, sigB);
    }

    // =================================================================================================================
    // refundExpired
    // =================================================================================================================

    function test_refundExpired_afterWindow() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        uint64 settleBy = vault.matchOf(M1).settleBy;
        vm.expectRevert(abi.encodeWithSelector(IGameVault.SettleWindowOpen.selector, M1, settleBy));
        vault.refundExpired(M1);
        vm.warp(settleBy);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.SettleWindowOpen.selector, M1, settleBy));
        vault.refundExpired(M1);
        vm.warp(settleBy + 1);
        vm.prank(owner);
        vault.pause(); // never paused
        vm.expectEmit(true, true, true, true, address(vault));
        emit IGameVault.MatchVoided(M1, alice, bob, VOID_TIMEOUT, bytes32(0));
        vm.prank(stranger); // anyone
        vault.refundExpired(M1);
        assertEq(vault.freeOf(alice), 1_000e18);
        assertEq(vault.freeOf(bob), 1_000e18);
        assertEq(uint8(vault.matchOf(M1).state), uint8(IGameVault.MatchState.Voided));
        vm.expectRevert(abi.encodeWithSelector(IGameVault.NotLocked.selector, M1));
        vault.refundExpired(M1);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.NotLocked.selector, M2));
        vault.refundExpired(M2);
    }

    // =================================================================================================================
    // house
    // =================================================================================================================

    function test_withdrawHouse_onlyToHouse() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        _settle(M1, alice, FEE);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IGameVault.HouseWithdrawn(house, 6e18);
        vm.prank(stranger); // anyone may call; the fees still only go to the house
        vault.withdrawHouse();
        assertEq(token.balanceOf(house), 6e18);
        assertEq(token.balanceOf(stranger), 0);
        assertEq(vault.houseAccrued(), 0);
        assertEq(vault.totalLiabilities(), 2_000e18 - 6e18);
        vm.expectRevert(IGameVault.ZeroAmount.selector);
        vault.withdrawHouse();
        _assertBooks(_players());
    }

    function test_withdrawHouse_worksWhilePaused() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        _settle(M1, alice, FEE);
        vm.prank(owner);
        vault.pause();
        vault.withdrawHouse();
        assertEq(token.balanceOf(house), 6e18);
    }

    // =================================================================================================================
    // owner
    // =================================================================================================================

    function test_owner_settings() public {
        vm.startPrank(owner);
        vm.expectEmit(address(vault));
        emit IGameVault.HouseFeesSet(500, 0);
        vault.setHouseFees(500, 0);
        assertEq(vault.houseFeeBps(), 500);
        assertEq(vault.holderFeeBps(), 0);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.FeeTooHigh.selector, uint16(501)));
        vault.setHouseFees(501, 0);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.FeeTooHigh.selector, uint16(600)));
        vault.setHouseFees(0, 600);

        vm.expectEmit(address(vault));
        emit IGameVault.CapsSet(5e18, 50e18);
        vault.setCaps(5e18, 50e18);
        assertEq(vault.maxStake(), 5e18);
        assertEq(vault.maxBalance(), 50e18);
        vm.expectRevert(IGameVault.BadConfig.selector);
        vault.setCaps(0, 1);
        vm.expectRevert(IGameVault.BadConfig.selector);
        vault.setCaps(1, 0);

        vm.expectRevert(IGameVault.ZeroAddress.selector);
        vault.setReferee(address(0));

        vm.expectEmit(address(vault));
        emit Pausable.Paused(owner);
        vault.pause();
        vm.expectEmit(address(vault));
        emit Pausable.Unpaused(owner);
        vault.unpause();
        vm.stopPrank();
    }

    function test_owner_onlyOwner() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);
        vm.startPrank(stranger);
        vm.expectRevert(err);
        vault.setHouseFees(0, 0);
        vm.expectRevert(err);
        vault.setCaps(1, 1);
        vm.expectRevert(err);
        vault.setReferee(stranger);
        vm.expectRevert(err);
        vault.pause();
        vm.expectRevert(err);
        vault.unpause();
        vm.stopPrank();
        // The referee and the house have no owner powers either.
        vm.prank(referee);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, referee));
        vault.pause();
        vm.prank(house);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, house));
        vault.setCaps(1, 1);
    }

    function test_owner_twoStepTransfer() public {
        vm.prank(owner);
        vault.transferOwnership(carol);
        assertEq(vault.owner(), owner);
        assertEq(vault.pendingOwner(), carol);
        vm.prank(carol);
        vault.acceptOwnership();
        assertEq(vault.owner(), carol);
    }

    /// The owner (or anyone) can't move, lock or block a player's balance: every owner action leaves balances as is and
    /// a full withdrawal still works.
    function test_owner_cannotTouchBalances() public {
        _ready(1_000e18);
        _lock(M1, 100e18);
        uint256 freeA = vault.freeOf(alice);
        uint256 lockedA = vault.lockedOf(alice);
        (address ownerRef, uint256 ownerRefPk) = makeAddrAndKey("owner's own referee");
        vm.startPrank(owner);
        vault.setCaps(1, 1);
        vault.setHouseFees(500, 500);
        vault.setReferee(ownerRef);
        vault.pause();
        vm.stopPrank();
        assertEq(vault.freeOf(alice), freeA);
        assertEq(vault.lockedOf(alice), lockedA);
        vm.prank(alice);
        vault.withdraw(freeA);
        assertEq(token.balanceOf(alice), freeA);
        // A referee the owner appoints now can't decide the live match at all: it keeps the referee it locked under.
        IGameVault.Result memory r = _result(M1, OUTCOME_WIN, bob, FEE);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, referee));
        vault.settle(r, _signResult(ownerRefPk, r));
        // And that referee can only pick one of its two players at the fees captured at lock: never pay the owner,
        // never charge the new 5%.
        r = _result(M1, OUTCOME_WIN, owner, FEE);
        bytes memory sig = _signResult(refereePk, r);
        vm.expectRevert(IGameVault.BadResult.selector);
        vault.settle(r, sig);
        r = _result(M1, OUTCOME_WIN, alice, 500);
        sig = _signResult(refereePk, r);
        vm.expectRevert(IGameVault.BadResult.selector);
        vault.settle(r, sig);
        // The owner can't give ownership up either (pause, rotation and reviews always have someone to run them).
        vm.prank(owner);
        vm.expectRevert(IGameVault.RenounceDisabled.selector);
        vault.renounceOwnership();
        assertEq(vault.owner(), owner);
        _assertBooks(_players());
    }

    function test_hashes_matchTestDigests() public view {
        IGameVault.SessionAuth memory a = _auth(alice, aliceKey, 1, 2, 3);
        assertEq(vault.hashSessionAuth(a), _hashAuth(a));
        IGameVault.Entry memory e = _entry(M1, alice, bob, 5e18);
        assertEq(vault.hashEntry(e), _hashEntry(e));
        IGameVault.Result memory r = _result(M1, OUTCOME_WIN, bob, 150);
        assertEq(vault.hashResult(r), _hashResult(r));
    }

    function test_hashes_matchManualEip712() public view {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("RadRun GameVault"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
        IGameVault.Entry memory e = _entry(M1, alice, bob, 5e18);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Entry(bytes32 matchId,address player,address opponent,uint128 stake,uint16 feeCapBps,uint16 roundSeconds,bytes32 rules,uint64 deadline)"
                ),
                e.matchId,
                e.player,
                e.opponent,
                e.stake,
                e.feeCapBps,
                e.roundSeconds,
                e.rules,
                e.deadline
            )
        );
        assertEq(vault.hashEntry(e), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }
}
