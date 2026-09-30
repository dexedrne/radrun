// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {GameVault} from "../../src/GameVault.sol";
import {TestSpiderTag} from "../../src/TestSpiderTag.sol";
import {
    IGameVault,
    SESSION_AUTH_TYPEHASH,
    ENTRY_TYPEHASH,
    RESULT_TYPEHASH,
    OUTCOME_WIN,
    OUTCOME_VOID
} from "../../src/interfaces/IGameVault.sol";

/// Shared fixture: a vault on the test token, two funded players with keys, session keys, a referee key and the
/// signing helpers every suite uses.
abstract contract VaultTestBase is Test {
    uint16 internal constant FEE = 300;
    uint16 internal constant HOLDER_FEE = 150;
    uint128 internal constant MAX_STAKE = 1_000e18;
    uint128 internal constant MAX_BALANCE = 100_000e18;
    uint32 internal constant WINDOW = 1 days;
    uint16 internal constant ROUND = 90;
    bytes32 internal constant RULES = keccak256("radrun-spidertag rules (test)");
    uint256 internal constant T0 = 1_800_000_000;

    GameVault internal vault;
    IERC20 internal token;

    address internal alice;
    uint256 internal alicePk;
    address internal bob;
    uint256 internal bobPk;
    address internal carol;
    uint256 internal carolPk;
    address internal aliceKey;
    uint256 internal aliceKeyPk;
    address internal bobKey;
    uint256 internal bobKeyPk;
    address internal referee;
    uint256 internal refereePk;

    address internal house = makeAddr("house");
    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");

    function setUp() public virtual {
        vm.warp(T0);
        (alice, alicePk) = makeAddrAndKey("alice");
        (bob, bobPk) = makeAddrAndKey("bob");
        (carol, carolPk) = makeAddrAndKey("carol");
        (aliceKey, aliceKeyPk) = makeAddrAndKey("alice session key");
        (bobKey, bobKeyPk) = makeAddrAndKey("bob session key");
        (referee, refereePk) = makeAddrAndKey("referee");
        token = IERC20(address(new TestSpiderTag(address(this))));
        vault = _newVault(address(token));
    }

    function _newVault(address token_) internal returns (GameVault) {
        return
            new GameVault(
                IERC20Metadata(token_), house, referee, owner, FEE, HOLDER_FEE, MAX_STAKE, MAX_BALANCE, WINDOW
            );
    }

    // ---- funds ------------------------------------------------------------------------------------------------------

    /// Gives `who` tokens from this contract's supply and approves the vault for them.
    function _fund(address who, uint256 amount) internal {
        require(token.transfer(who, amount));
        vm.prank(who);
        token.approve(address(vault), type(uint256).max);
    }

    function _deposit(address who, uint256 amount) internal {
        _fund(who, amount);
        vm.prank(who);
        vault.deposit(amount);
    }

    // ---- signatures -------------------------------------------------------------------------------------------------

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _auth(address player, address key, uint128 maxStake, uint128 cap, uint64 expiry)
        internal
        view
        returns (IGameVault.SessionAuth memory)
    {
        return IGameVault.SessionAuth({
            player: player,
            sessionKey: key,
            maxStake: maxStake,
            cap: cap,
            expiry: expiry,
            nonce: vault.sessionNonce(player)
        });
    }

    function _openSession(uint256 playerPk, address key, uint128 maxStake, uint128 cap) internal {
        address player = vm.addr(playerPk);
        IGameVault.SessionAuth memory a = _auth(player, key, maxStake, cap, uint64(vm.getBlockTimestamp() + 3 days));
        vm.prank(relayer);
        vault.openSession(a, _sign(playerPk, _hashAuth(a)));
    }

    function _entry(bytes32 id, address player, address opponent, uint128 stake)
        internal
        view
        returns (IGameVault.Entry memory)
    {
        return IGameVault.Entry({
            matchId: id,
            player: player,
            opponent: opponent,
            stake: stake,
            feeCapBps: FEE,
            roundSeconds: ROUND,
            rules: RULES,
            deadline: uint64(vm.getBlockTimestamp() + 10 minutes)
        });
    }

    // The test's own EIP-712 digests (independent of the vault's hash functions, which a test compares against these).
    // Computing them here also keeps vm.expectRevert pointed at the vault call rather than at a hash view.

    function _domainSeparator(address v) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("RadRun GameVault"),
                keccak256("1"),
                block.chainid,
                v
            )
        );
    }

    function _digest(address v, bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(v), structHash));
    }

    function _hashAuth(IGameVault.SessionAuth memory a) internal view returns (bytes32) {
        return _digest(
            address(vault),
            keccak256(abi.encode(SESSION_AUTH_TYPEHASH, a.player, a.sessionKey, a.maxStake, a.cap, a.expiry, a.nonce))
        );
    }

    function _hashEntry(IGameVault.Entry memory e) internal view returns (bytes32) {
        return _digest(
            address(vault),
            keccak256(
                abi.encode(
                    ENTRY_TYPEHASH,
                    e.matchId,
                    e.player,
                    e.opponent,
                    e.stake,
                    e.feeCapBps,
                    e.roundSeconds,
                    e.rules,
                    e.deadline
                )
            )
        );
    }

    function _hashResult(IGameVault.Result memory r) internal view returns (bytes32) {
        return _digest(
            address(vault), keccak256(abi.encode(RESULT_TYPEHASH, r.matchId, r.outcome, r.winner, r.feeBps, r.logHash))
        );
    }

    function _signEntry(uint256 pk, IGameVault.Entry memory e) internal view returns (bytes memory) {
        return _sign(pk, _hashEntry(e));
    }

    function _result(bytes32 id, uint8 outcome, address winner, uint16 feeBps)
        internal
        pure
        returns (IGameVault.Result memory)
    {
        return IGameVault.Result({
            matchId: id, outcome: outcome, winner: winner, feeBps: feeBps, logHash: keccak256(abi.encode("log", id))
        });
    }

    function _signResult(uint256 pk, IGameVault.Result memory r) internal view returns (bytes memory) {
        return _sign(pk, _hashResult(r));
    }

    // ---- common flows -----------------------------------------------------------------------------------------------

    /// Both players deposited and hold session keys (maxStake max(MAX_STAKE, each), cap 10 x that).
    function _ready(uint256 each) internal {
        _deposit(alice, each);
        _deposit(bob, each);
        uint128 ms = each > MAX_STAKE ? uint128(each) : MAX_STAKE;
        _openSession(alicePk, aliceKey, ms, 10 * ms);
        _openSession(bobPk, bobKey, ms, 10 * ms);
    }

    /// Alice (open offer) vs Bob (names Alice), both signed by their session keys, submitted by the relayer.
    function _lock(bytes32 id, uint128 stake) internal {
        IGameVault.Entry memory a = _entry(id, alice, address(0), stake);
        IGameVault.Entry memory b = _entry(id, bob, alice, stake);
        vm.prank(relayer);
        vault.lock(a, _signEntry(aliceKeyPk, a), b, _signEntry(bobKeyPk, b));
    }

    function _settle(bytes32 id, address winner, uint16 feeBps) internal {
        IGameVault.Result memory r = _result(id, OUTCOME_WIN, winner, feeBps);
        vm.prank(relayer);
        vault.settle(r, _signResult(refereePk, r));
    }

    function _void(bytes32 id) internal {
        IGameVault.Result memory r = _result(id, OUTCOME_VOID, address(0), 0);
        vm.prank(relayer);
        vault.settle(r, _signResult(refereePk, r));
    }

    /// Σfree + Σlocked + houseAccrued over the given players equals totalLiabilities and the token covers it.
    function _assertBooks(address[] memory players) internal view {
        uint256 sum = vault.houseAccrued();
        for (uint256 i = 0; i < players.length; i++) {
            sum += vault.freeOf(players[i]) + vault.lockedOf(players[i]);
        }
        assertEq(sum, vault.totalLiabilities(), "liabilities == sum of buckets");
        assertGe(IERC20(vault.token()).balanceOf(address(vault)), vault.totalLiabilities(), "solvent");
    }

    function _players() internal view returns (address[] memory p) {
        p = new address[](3);
        p[0] = alice;
        p[1] = bob;
        p[2] = carol;
    }
}
