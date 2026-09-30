// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity 0.8.37;

import {IGameVault, OUTCOME_WIN, OUTCOME_VOID} from "../src/interfaces/IGameVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";
import {MockRadbro} from "./mocks/Wallets.sol";

/// Whole flows as the beta runs them: deposit once, a session key, gasless matches through a relayer, settles,
/// withdrawals (docs/WAGER.md §1, §9.4 numbers).
contract ScenarioTest is VaultTestBase {
    MockRadbro internal radbros;

    function setUp() public override {
        super.setUp();
        radbros = new MockRadbro();
    }

    /// What the referee does at signing time (docs/WAGER.md §4.6): the holder fee when the winner owns a Radbro. The
    /// vault only accepts it because it is one of the two fees captured at lock.
    function _refereeFee(bytes32 id, address winner) internal view returns (uint16) {
        IGameVault.Match memory m = vault.matchOf(id);
        return radbros.balanceOf(winner) > 0 ? m.holderFeeBps : m.feeBps;
    }

    function _refereeSettles(bytes32 id, address winner) internal {
        IGameVault.Result memory r = _result(id, OUTCOME_WIN, winner, _refereeFee(id, winner));
        vm.prank(relayer);
        vault.settle(r, _signResult(refereePk, r));
    }

    function test_e2eNumbers_depositPlaySettleWithdraw() public {
        // Each deposits 1,000 and authorises a session key; one invite at 100 each.
        _ready(1_000e18);
        bytes32 id = _mid(alice, keccak256("e2e"));
        IGameVault.Entry memory a = _entry(id, alice, bob, 100e18);
        IGameVault.Entry memory b = _entry(id, bob, alice, 100e18);
        vm.prank(relayer);
        vault.lock(a, _signEntry(aliceKeyPk, a), b, _signEntry(bobKeyPk, b));
        _refereeSettles(id, alice);
        // docs/WAGER.md §9.4: winner free = 1,094, loser 900, house 6; totalLiabilities = the token balance.
        assertEq(vault.freeOf(alice), 1_094e18);
        assertEq(vault.freeOf(bob), 900e18);
        assertEq(vault.houseAccrued(), 6e18);
        assertEq(vault.totalLiabilities(), token.balanceOf(address(vault)));
        vm.prank(alice);
        vault.withdraw(1_094e18);
        vm.prank(bob);
        vault.withdraw(900e18);
        vault.withdrawHouse();
        assertEq(token.balanceOf(alice), 1_094e18);
        assertEq(token.balanceOf(bob), 900e18);
        assertEq(token.balanceOf(house), 6e18);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(vault.totalLiabilities(), 0);
    }

    function test_radbroHolderWinnerPaysHalfFee() public {
        radbros.mint(bob, 652);
        _ready(1_000e18);
        bytes32 m1 = _mid(alice, keccak256("holder-1"));
        bytes32 m2 = _mid(alice, keccak256("holder-2"));
        _lock(m1, 100e18);
        _lock(m2, 100e18);
        _refereeSettles(m1, bob); // holder wins: 1.5%
        assertEq(vault.freeOf(bob), 800e18 + 197e18);
        assertEq(vault.houseAccrued(), 3e18);
        _refereeSettles(m2, alice); // non-holder wins: 3%
        assertEq(vault.freeOf(alice), 800e18 + 194e18);
        assertEq(vault.houseAccrued(), 9e18);
    }

    function test_manyMatchesThenEveryoneLeaves() public {
        _ready(10_000e18);
        _deposit(carol, 10_000e18);
        _openSession(carolPk, vm.addr(uint256(keccak256("carol key"))), MAX_STAKE, 100 * MAX_STAKE);
        uint256 carolKeyPk = uint256(keccak256("carol key"));
        for (uint256 i = 0; i < 12; i++) {
            (address p, uint256 pk) = i % 2 == 0 ? (alice, aliceKeyPk) : (carol, carolKeyPk);
            bytes32 id = _mid(p, keccak256(abi.encode("many", i)));
            IGameVault.Entry memory a = _entry(id, p, address(0), uint128(10e18 + i * 7e18));
            IGameVault.Entry memory b = _entry(id, bob, p, uint128(10e18 + i * 7e18));
            vm.prank(relayer);
            vault.lock(a, _signEntry(pk, a), b, _signEntry(bobKeyPk, b));
            if (i % 3 == 0) _void(id);
            else _refereeSettles(id, i % 3 == 1 ? p : bob);
            _assertBooks(_players());
        }
        address[3] memory ps = [alice, bob, carol];
        for (uint256 i = 0; i < 3; i++) {
            uint256 f = vault.freeOf(ps[i]);
            assertEq(vault.lockedOf(ps[i]), 0);
            vm.prank(ps[i]);
            vault.withdraw(f);
            assertEq(token.balanceOf(ps[i]), f);
        }
        vault.withdrawHouse();
        assertEq(token.balanceOf(address(vault)), 0, "nothing left behind");
    }

    function test_noShowVoidRefundsBoth() public {
        _ready(1_000e18);
        bytes32 id = _mid(alice, keccak256("no-show"));
        _lock(id, 250e18);
        IGameVault.Result memory r = _result(id, OUTCOME_VOID, address(0), 0);
        vault.settle(r, _signResult(refereePk, r));
        assertEq(vault.freeOf(alice), 1_000e18);
        assertEq(vault.freeOf(bob), 1_000e18);
    }

    function test_deadRelay_refundAfterWindow() public {
        _ready(1_000e18);
        bytes32 id = _mid(alice, keccak256("dead relay"));
        _lock(id, 250e18);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.prank(alice); // a player needs nobody
        vault.refundExpired(id);
        vm.prank(alice);
        vault.withdraw(1_000e18);
        assertEq(token.balanceOf(alice), 1_000e18);
    }
}
