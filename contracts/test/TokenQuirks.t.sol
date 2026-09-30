// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {GameVault} from "../src/GameVault.sol";
import {IGameVault, OUTCOME_WIN} from "../src/interfaces/IGameVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";
import {
    MockERC20,
    FeeOnTransferToken,
    SenderTaxToken,
    BlacklistToken,
    PausableToken,
    GraduationLockedToken,
    MaxWalletToken,
    RebasingToken,
    NoReturnToken,
    FalseReturnToken,
    HookToken
} from "./mocks/Tokens.sol";

/// The token policy (docs/WAGER.md §3.6, §9.1 "Quirk tokens"): the vault works with any plain ERC-20, rejects taxed
/// and rebasing behaviour, and a token that blocks an address or pauses can never block a settle or trap the other
/// player's stake.
contract TokenQuirksTest is VaultTestBase {
    bytes32 internal constant M1 = keccak256("quirk-1");

    /// Points the fixture at a vault for `t` and funds alice and bob with `amount` of it (approved).
    function _useToken(address t, uint256 amount) internal {
        token = IERC20(t);
        vault = _newVault(t);
        for (uint256 i = 0; i < 2; i++) {
            address p = i == 0 ? alice : bob;
            MockERC20(t).mint(p, amount);
            vm.prank(p);
            SafeERC20.forceApprove(IERC20(t), address(vault), type(uint256).max);
        }
    }

    function _depositBoth(uint256 amount) internal {
        vm.prank(alice);
        vault.deposit(amount);
        vm.prank(bob);
        vault.deposit(amount);
        _openSession(alicePk, aliceKey, MAX_STAKE, 10 * MAX_STAKE);
        _openSession(bobPk, bobKey, MAX_STAKE, 10 * MAX_STAKE);
    }

    // ---- taxed transfers --------------------------------------------------------------------------------------------

    function test_feeOnTransfer_depositRejected() public {
        _useToken(address(new FeeOnTransferToken(100)), 1_000e18); // 1% tax
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.TransferMismatch.selector, 100e18, 99e18));
        vault.deposit(100e18);
        assertEq(vault.totalLiabilities(), 0);
    }

    function test_senderTax_depositLooksExactButPayoutsRefuseToOverdraw() public {
        // A token that charges the sender on top: the vault would pay more than it owes on every withdrawal.
        _useToken(address(new SenderTaxToken(100)), 1_000e18);
        vm.prank(alice);
        vault.deposit(500e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.TransferMismatch.selector, 100e18, 101e18));
        vault.withdraw(100e18);
        // The books stay whole instead of the first withdrawer draining the others.
        assertEq(vault.freeOf(alice), 500e18);
        assertGe(token.balanceOf(address(vault)), vault.totalLiabilities());
    }

    // ---- rebasing ---------------------------------------------------------------------------------------------------

    function test_rebasing_depositAtOddIndexRejected() public {
        RebasingToken t = new RebasingToken();
        _useToken(address(t), 0);
        t.mint(alice, 1_000e18);
        vm.prank(alice);
        t.approve(address(vault), type(uint256).max);
        t.rebase(3e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.TransferMismatch.selector, 10, 9));
        vault.deposit(10); // 10 / 3 = 3 shares = 9 units: not what was asked
    }

    function test_rebasing_negativeStopsLocksButNotExits() public {
        RebasingToken t = new RebasingToken();
        _useToken(address(t), 0);
        t.mint(alice, 1_000e18);
        t.mint(bob, 1_000e18);
        vm.prank(alice);
        t.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        t.approve(address(vault), type(uint256).max);
        _depositBoth(1_000e18);
        _lock(M1, 100e18);

        t.rebase(0.5e18); // the vault now holds half of what it owes
        bytes32 m2 = keccak256("quirk-2");
        IGameVault.Entry memory a = _entry(m2, alice, address(0), 100e18);
        IGameVault.Entry memory b = _entry(m2, bob, alice, 100e18);
        bytes memory sigA = _signEntry(aliceKeyPk, a);
        bytes memory sigB = _signEntry(bobKeyPk, b);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.Insolvent.selector, 1_000e18, 2_000e18));
        vault.lock(a, sigA, b, sigB);
        // The live match still settles (an internal credit), and a timed-out one would still refund.
        _settle(M1, alice, FEE);
        assertEq(vault.freeOf(alice), 1_094e18);
    }

    function test_rebasing_positiveLeavesASurplus() public {
        RebasingToken t = new RebasingToken();
        _useToken(address(t), 0);
        t.mint(alice, 1_000e18);
        t.mint(bob, 1_000e18);
        vm.prank(alice);
        t.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        t.approve(address(vault), type(uint256).max);
        _depositBoth(1_000e18);
        t.rebase(2e18);
        assertEq(t.balanceOf(address(vault)), 4_000e18);
        _lock(M1, 100e18); // solvent: more than enough
        _settle(M1, bob, FEE);
        vm.prank(bob);
        vault.withdraw(1_094e18);
        assertEq(t.balanceOf(bob), 1_094e18);
        // The surplus is nobody's: there is no sweep (docs/WAGER.md §3.6).
        assertGt(t.balanceOf(address(vault)), vault.totalLiabilities());
    }

    // ---- blacklist --------------------------------------------------------------------------------------------------

    function test_blacklist_blockedPlayerUsesWithdrawToAndNeverBlocksTheOther() public {
        BlacklistToken t = new BlacklistToken();
        _useToken(address(t), 1_000e18);
        _depositBoth(1_000e18);
        _lock(M1, 100e18);

        t.setBlacklisted(alice, true);
        // Settles never call the token.
        _settle(M1, bob, FEE);
        assertEq(vault.freeOf(bob), 1_094e18);
        // Bob's exit is unaffected.
        vm.prank(bob);
        vault.withdraw(1_094e18);
        assertEq(t.balanceOf(bob), 1_094e18);
        // Alice can't receive at her own address, so she sends elsewhere.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BlacklistToken.Blacklisted.selector, alice));
        vault.withdraw(900e18);
        vm.prank(alice);
        vault.withdrawTo(900e18, carol);
        assertEq(t.balanceOf(carol), 900e18);
        _assertBooks(_players());
    }

    function test_blacklist_voidAndRefundStillWork() public {
        BlacklistToken t = new BlacklistToken();
        _useToken(address(t), 1_000e18);
        _depositBoth(1_000e18);
        _lock(M1, 100e18);
        bytes32 m2 = keccak256("quirk-2");
        _lock(m2, 100e18);
        t.setBlacklisted(alice, true);
        t.setBlacklisted(bob, true);
        t.setBlacklisted(address(vault), true); // even the vault itself
        _void(M1);
        vm.warp(block.timestamp + WINDOW + 1);
        vault.refundExpired(m2);
        assertEq(vault.freeOf(alice), 1_000e18);
        assertEq(vault.freeOf(bob), 1_000e18);
        // Once the token lets the vault move again, everyone leaves.
        t.setBlacklisted(address(vault), false);
        t.setBlacklisted(bob, false);
        vm.prank(bob);
        vault.withdraw(1_000e18);
        vm.prank(alice);
        vault.withdrawTo(1_000e18, carol);
    }

    function test_blacklist_blockedHouseOnlyStrandsItsOwnFees() public {
        BlacklistToken t = new BlacklistToken();
        _useToken(address(t), 1_000e18);
        _depositBoth(1_000e18);
        _lock(M1, 100e18);
        _settle(M1, alice, FEE);
        t.setBlacklisted(house, true);
        vm.expectRevert(abi.encodeWithSelector(BlacklistToken.Blacklisted.selector, house));
        vault.withdrawHouse();
        vm.prank(alice);
        vault.withdraw(1_094e18);
        vm.prank(bob);
        vault.withdraw(900e18);
        assertEq(vault.totalLiabilities(), 6e18);
    }

    // ---- pausable ---------------------------------------------------------------------------------------------------

    function test_pausableToken_settlesWorkWithdrawalsWaitForUnpause() public {
        PausableToken t = new PausableToken();
        _useToken(address(t), 1_000e18);
        _depositBoth(1_000e18);
        _lock(M1, 100e18);
        t.setPaused(true);
        _settle(M1, alice, FEE);
        vm.prank(alice);
        vm.expectRevert(PausableToken.TokenPaused.selector);
        vault.withdraw(1_094e18);
        vm.prank(bob);
        vm.expectRevert(PausableToken.TokenPaused.selector);
        vault.deposit(1);
        t.setPaused(false);
        vm.prank(alice);
        vault.withdraw(1_094e18);
        assertEq(t.balanceOf(alice), 1_094e18);
    }

    // ---- launch windows ---------------------------------------------------------------------------------------------

    function test_lockedUntilGraduation_depositWaitsForUnlock() public {
        GraduationLockedToken t = new GraduationLockedToken();
        _useToken(address(t), 1_000e18);
        vm.prank(alice);
        vm.expectRevert(GraduationLockedToken.TransfersLockedUntilGraduation.selector);
        vault.deposit(100e18);
        t.unlock();
        vm.prank(alice);
        vault.deposit(100e18);
        assertEq(vault.freeOf(alice), 100e18);
    }

    function test_maxWallet_bigWithdrawRevertsSmallerOnesWork() public {
        MaxWalletToken t = new MaxWalletToken(400e18, 1_500e18);
        _useToken(address(t), 1_000e18);
        t.setExempt(address(vault), true);
        vm.prank(alice);
        vm.expectRevert(MaxWalletToken.MaxTx.selector);
        vault.deposit(500e18);
        for (uint256 i = 0; i < 2; i++) {
            vm.prank(alice);
            vault.deposit(400e18);
            vm.prank(bob);
            vault.deposit(400e18);
        }
        _openSession(alicePk, aliceKey, MAX_STAKE, 10 * MAX_STAKE);
        _openSession(bobPk, bobKey, MAX_STAKE, 10 * MAX_STAKE);
        _lock(M1, 800e18);
        _settle(M1, alice, FEE); // alice: 1,552 free
        vm.prank(alice);
        vm.expectRevert(MaxWalletToken.MaxTx.selector);
        vault.withdraw(1_552e18);
        vm.startPrank(alice);
        vault.withdraw(400e18);
        vault.withdraw(400e18);
        vault.withdraw(400e18);
        // alice's wallet now holds 200 + 1,200 = 1,400: the next 400 would pass the 1,500 max-wallet
        vm.expectRevert(MaxWalletToken.MaxWallet.selector);
        vault.withdraw(352e18);
        vault.withdraw(100e18);
        vault.withdrawTo(252e18, carol);
        vm.stopPrank();
        assertEq(vault.freeOf(alice), 0);
    }

    // ---- ERC-20 shapes ----------------------------------------------------------------------------------------------

    function test_noReturnToken_worksThroughSafeERC20() public {
        NoReturnToken t = new NoReturnToken();
        token = IERC20(address(t));
        vault = _newVault(address(t));
        t.mint(alice, 1_000e6);
        vm.startPrank(alice);
        t.approve(address(vault), 1_000e6);
        vault.deposit(1_000e6);
        vault.withdraw(400e6);
        vm.stopPrank();
        assertEq(t.balanceOf(alice), 400e6);
        assertEq(vault.freeOf(alice), 600e6);
    }

    function test_falseReturningToken_treatedAsFailure() public {
        FalseReturnToken t = new FalseReturnToken();
        _useToken(address(t), 1_000e18);
        vm.prank(alice);
        vault.deposit(100e18);
        t.setFail(true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(t)));
        vault.withdraw(100e18);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(t)));
        vault.deposit(100e18);
        assertEq(vault.freeOf(alice), 100e18);
    }

    function test_hookToken_reentryIsRefused() public {
        HookToken t = new HookToken();
        _useToken(address(t), 1_000e18);
        vm.prank(alice);
        vault.deposit(500e18);
        Reenterer r = new Reenterer(vault);
        t.setHook(address(r));
        // A withdrawal whose token calls back into withdraw (or deposit) reverts whole.
        r.arm(Reenterer.Mode.Withdraw);
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        vault.withdraw(100e18);
        r.arm(Reenterer.Mode.Deposit);
        vm.prank(bob);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        vault.deposit(100e18);
        r.arm(Reenterer.Mode.House);
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        vault.withdraw(100e18);
        assertEq(vault.freeOf(alice), 500e18);
        assertEq(vault.totalLiabilities(), 500e18);
    }

    function test_decimalsAreTheTokens() public {
        MockERC20 six = new MockERC20("Six", "SIX", 6);
        GameVault v = _newVault(address(six));
        assertEq(v.token(), address(six));
        MockERC20 zero = new MockERC20("Zero", "ZERO", 0);
        v = _newVault(address(zero));
        assertEq(v.token(), address(zero));
    }
}

/// Tries to re-enter the vault from inside a token transfer.
contract Reenterer {
    enum Mode {
        None,
        Withdraw,
        Deposit,
        House
    }

    GameVault internal immutable vault;
    Mode public mode;

    constructor(GameVault vault_) {
        vault = vault_;
    }

    function arm(Mode m) external {
        mode = m;
    }

    function onTokenTransfer() external {
        if (mode == Mode.Withdraw) vault.withdraw(1);
        else if (mode == Mode.Deposit) vault.deposit(1);
        else if (mode == Mode.House) vault.withdrawHouse();
    }
}
