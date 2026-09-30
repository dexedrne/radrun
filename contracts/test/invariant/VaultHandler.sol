// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity 0.8.37;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {GameVault} from "../../src/GameVault.sol";
import {TestSpiderTag} from "../../src/TestSpiderTag.sol";
import {IGameVault, OUTCOME_WIN, OUTCOME_VOID} from "../../src/interfaces/IGameVault.sol";

/// Drives the vault as players, their session keys, the owner, the referee, a relayer and a random stranger, with time
/// warps, and keeps the ghost values the invariants check (docs/WAGER.md §9.1 I1-I7).
contract VaultHandler is CommonBase, StdCheats, StdUtils {
    uint256 internal constant N = 4;
    uint128 internal constant STAKE_CAP = 5_000e18;

    GameVault public immutable vault;
    TestSpiderTag public immutable token;
    address public immutable owner;
    address public immutable house;

    address[N] public players;
    uint256[N] internal playerPks;
    address[N] public sessionKeys;
    uint256[N] internal sessionKeyPks;
    uint256 internal refereePk;
    uint256 internal immutable strangerPk;

    bytes32[] public matchIds;
    uint256 public matchNonce;

    // ghosts
    uint256 public illegalFreeDrops;
    uint256 public feesCharged;
    uint256 public houseWithdrawn;
    uint256 public successfulLocks;
    uint256 public successfulSettles;
    uint256 public successfulRefunds;
    uint256 public strangerSuccesses;
    uint256[N] internal lastFree;
    /// Revert counts by error selector (locks and settles), for tuning the handler.
    mapping(bytes4 => uint256) public revertsBySelector;

    constructor(GameVault vault_, TestSpiderTag token_, address owner_, address house_, uint256 refereePk_) {
        vault = vault_;
        token = token_;
        owner = owner_;
        house = house_;
        refereePk = refereePk_;
        strangerPk = uint256(keccak256("stranger"));
        for (uint256 i = 0; i < N; i++) {
            playerPks[i] = uint256(keccak256(abi.encode("player", i)));
            players[i] = vm.addr(playerPks[i]);
            sessionKeyPks[i] = uint256(keccak256(abi.encode("session key", i)));
            sessionKeys[i] = vm.addr(sessionKeyPks[i]);
            vm.prank(players[i]);
            token.approve(address(vault_), type(uint256).max);
        }
    }

    function matchCount() external view returns (uint256) {
        return matchIds.length;
    }

    // ---- ghost bookkeeping ----------------------------------------------------------------------------------------

    modifier tracked(address allowedA, address allowedB) {
        for (uint256 i = 0; i < N; i++) {
            lastFree[i] = vault.freeOf(players[i]);
        }
        _;
        for (uint256 i = 0; i < N; i++) {
            uint256 f = vault.freeOf(players[i]);
            if (f < lastFree[i] && players[i] != allowedA && players[i] != allowedB) illegalFreeDrops++;
        }
    }

    function _p(uint256 seed) internal pure returns (uint256) {
        return seed % N;
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ---- players ----------------------------------------------------------------------------------------------------

    function deposit(uint256 who, uint256 amount) external tracked(address(0), address(0)) {
        address p = players[_p(who)];
        amount = bound(amount, 1, 20_000e18);
        require(token.transfer(p, amount));
        vm.prank(p);
        try vault.deposit(amount) {} catch {}
    }

    function depositFor(uint256 from, uint256 to, uint256 amount) external tracked(address(0), address(0)) {
        address f = players[_p(from)];
        amount = bound(amount, 1, 20_000e18);
        require(token.transfer(f, amount));
        vm.prank(f);
        try vault.depositFor(players[_p(to)], amount) {} catch {}
    }

    function withdraw(uint256 who, uint256 amount, bool elsewhere) external {
        address p = players[_p(who)];
        uint256 free_ = vault.freeOf(p);
        if (free_ == 0) return;
        _withdraw(p, bound(amount, 1, free_), elsewhere);
    }

    function _withdraw(address p, uint256 amount, bool elsewhere) internal tracked(p, address(0)) {
        vm.prank(p);
        if (elsewhere) vault.withdrawTo(amount, address(0xBEEF));
        else vault.withdraw(amount);
    }

    function openSession(uint256 who, uint128 maxStake, uint128 cap, uint32 ttl)
        external
        tracked(address(0), address(0))
    {
        uint256 i = _p(who);
        maxStake = uint128(bound(maxStake, 1, STAKE_CAP));
        cap = uint128(bound(cap, maxStake, 10 * uint256(STAKE_CAP)));
        IGameVault.SessionAuth memory a = IGameVault.SessionAuth({
            player: players[i],
            sessionKey: sessionKeys[i],
            maxStake: maxStake,
            cap: cap,
            expiry: uint64(block.timestamp + bound(ttl, 1 hours, 30 days)),
            nonce: vault.sessionNonce(players[i])
        });
        try vault.openSession(a, _sign(playerPks[i], vault.hashSessionAuth(a))) {} catch {}
    }

    function revokeSession(uint256 who) external tracked(address(0), address(0)) {
        vm.prank(players[_p(who)]);
        vault.revokeSession();
    }

    /// `seed` picks both players, whether the creator names the joiner, and each side's signer: mostly the player's
    /// live session key or wallet, sometimes a stranger's key. Players are topped up first so most locks can happen.
    function lock(uint256 seed, uint128 stake, uint16 capA, uint16 capB) external {
        uint256 ia = _p(seed);
        uint256 ib = _p(seed >> 8);
        if (ia == ib) ib = (ib + 1) % N;
        stake = uint128(bound(stake, 1, (seed >> 48) % 16 == 0 ? 2 * uint256(STAKE_CAP) : vault.maxStake()));
        _topUp(ia, stake);
        _topUp(ib, stake);
        uint8 modeA = _mode(ia, seed >> 16);
        uint8 modeB = _mode(ib, seed >> 24);
        bytes32 id = keccak256(abi.encode("handler match", matchNonce++));
        IGameVault.Entry memory ea = _entryFor(id, ia, (seed >> 32) & 1 == 0 ? players[ib] : address(0), stake, capA);
        IGameVault.Entry memory eb = _entryFor(id, ib, players[ia], stake, capB);
        // Only a side that really signed may lose free balance to this lock.
        _lock(
            ea,
            _signEntry(ia, modeA, ea),
            eb,
            _signEntry(ib, modeB, eb),
            modeA < 2 ? players[ia] : address(0),
            modeB < 2 ? players[ib] : address(0)
        );
    }

    /// 0 = the live session key, 1 = the wallet, 2 = a stranger (about 1 in 12).
    function _mode(uint256 i, uint256 bits) internal view returns (uint8) {
        if (bits % 12 == 0) return 2;
        IGameVault.Session memory s = vault.sessionOf(players[i]);
        return s.key != address(0) && block.timestamp < s.expiry && (bits >> 4) % 2 == 0 ? 0 : 1;
    }

    /// The player deposits what a stake needs (their own deposit: it only ever raises their free balance).
    function _topUp(uint256 i, uint128 stake) internal {
        address p = players[i];
        uint256 free_ = vault.freeOf(p);
        if (free_ >= stake || vault.paused()) return;
        uint256 need = stake - free_;
        require(token.transfer(p, need));
        vm.prank(p);
        try vault.deposit(need) {} catch {}
    }

    function _entryFor(bytes32 id, uint256 i, address opponent, uint128 stake, uint16 cap)
        internal
        view
        returns (IGameVault.Entry memory)
    {
        return IGameVault.Entry({
            matchId: id,
            player: players[i],
            opponent: opponent,
            stake: stake == 0 ? 1 : stake,
            feeCapBps: uint16(bound(cap, 0, 600)),
            roundSeconds: 90,
            rules: keccak256("rules"),
            deadline: uint64(block.timestamp + 10 minutes)
        });
    }

    function _signEntry(uint256 i, uint8 mode, IGameVault.Entry memory e) internal view returns (bytes memory) {
        uint256 pk = mode == 0 ? sessionKeyPks[i] : mode == 1 ? playerPks[i] : strangerPk;
        return _sign(pk, vault.hashEntry(e));
    }

    function _lock(
        IGameVault.Entry memory ea,
        bytes memory sa,
        IGameVault.Entry memory eb,
        bytes memory sb,
        address okA,
        address okB
    ) internal tracked(okA, okB) {
        try vault.lock(ea, sa, eb, sb) {
            matchIds.push(ea.matchId);
            successfulLocks++;
            if (okA == address(0) || okB == address(0)) strangerSuccesses++;
        } catch (bytes memory reason) {
            revertsBySelector[bytes4(reason)]++;
        }
    }

    // ---- referee, players settling, anyone refunding ----------------------------------------------------------------

    /// Mostly a match that is still Locked (so settles happen), sometimes any match (so the reverts are exercised).
    function _pick(uint256 m) internal view returns (bytes32) {
        uint256 n = matchIds.length;
        if (m % 5 == 0) return matchIds[m % n];
        for (uint256 k = 0; k < n; k++) {
            bytes32 id = matchIds[(m + k) % n];
            if (vault.matchOf(id).state == IGameVault.MatchState.Locked) return id;
        }
        return matchIds[m % n];
    }

    function settle(uint256 m, uint8 outcome, bool aWins, bool holder) external tracked(address(0), address(0)) {
        if (matchIds.length == 0) return;
        bytes32 id = _pick(m);
        IGameVault.Match memory mt = vault.matchOf(id);
        IGameVault.Result memory r = _resultFor(id, mt, outcome, aWins, holder ? mt.holderFeeBps : mt.feeBps);
        uint256 before = vault.houseAccrued();
        try vault.settle(r, _sign(refereePk, vault.hashResult(r))) {
            successfulSettles++;
            feesCharged += vault.houseAccrued() - before;
        } catch (bytes memory reason) {
            revertsBySelector[bytes4(reason)]++;
        }
    }

    function settleMutual(uint256 m, uint8 outcome, bool aWins, bool sessionKeysInstead)
        external
        tracked(address(0), address(0))
    {
        if (matchIds.length == 0) return;
        bytes32 id = _pick(m);
        IGameVault.Match memory mt = vault.matchOf(id);
        if (mt.state != IGameVault.MatchState.Locked) return;
        IGameVault.Result memory r = _resultFor(id, mt, outcome, aWins, mt.feeBps);
        bytes memory sa = _mutualSig(mt.playerA, sessionKeysInstead, r);
        bytes memory sb = _mutualSig(mt.playerB, sessionKeysInstead, r);
        uint256 before = vault.houseAccrued();
        try vault.settleMutual(r, sa, sb) {
            successfulSettles++;
            feesCharged += vault.houseAccrued() - before;
            if (sessionKeysInstead) strangerSuccesses++;
        } catch {}
    }

    function _mutualSig(address player, bool sessionKey, IGameVault.Result memory r)
        internal
        view
        returns (bytes memory)
    {
        uint256 i = _indexOf(player);
        return _sign(sessionKey ? sessionKeyPks[i] : playerPks[i], vault.hashResult(r));
    }

    function refundExpired(uint256 m) external tracked(address(0), address(0)) {
        if (matchIds.length == 0) return;
        try vault.refundExpired(_pick(m)) {
            successfulRefunds++;
        } catch {}
    }

    function _resultFor(bytes32 id, IGameVault.Match memory mt, uint8 outcome, bool aWins, uint16 fee)
        internal
        pure
        returns (IGameVault.Result memory r)
    {
        bool win = outcome % 4 != 0; // mostly wins, some voids
        r = IGameVault.Result({
            matchId: id,
            outcome: win ? OUTCOME_WIN : OUTCOME_VOID,
            winner: win ? (aWins ? mt.playerA : mt.playerB) : address(0),
            feeBps: win ? fee : 0,
            logHash: keccak256(abi.encode(id, outcome))
        });
    }

    function _indexOf(address p) internal view returns (uint256) {
        for (uint256 i = 0; i < N; i++) {
            if (players[i] == p) return i;
        }
        revert("unknown player");
    }

    // ---- house, owner, time, a stranger ----------------------------------------------------------------------------

    function withdrawHouse() external tracked(address(0), address(0)) {
        uint256 amount = vault.houseAccrued();
        try vault.withdrawHouse() {
            houseWithdrawn += amount;
        } catch {}
    }

    function ownerSettings(uint16 fee, uint16 holderFee, uint128 maxStake, uint128 maxBalance, uint8 action)
        external
        tracked(address(0), address(0))
    {
        vm.startPrank(owner);
        action %= 8;
        if (action == 0) {
            vault.setHouseFees(uint16(bound(fee, 0, 500)), uint16(bound(holderFee, 0, 500)));
        } else if (action == 1) {
            vault.setCaps(uint128(bound(maxStake, 1, STAKE_CAP)), uint128(bound(maxBalance, 1, 200_000e18)));
        } else if (action == 2 && !vault.paused()) {
            vault.pause();
        } else if (action >= 3 && action <= 5 && vault.paused()) {
            vault.unpause();
        } else if (action == 6) {
            refereePk = uint256(keccak256(abi.encode("referee", fee, holderFee)));
            vault.setReferee(vm.addr(refereePk));
        }
        vm.stopPrank();
    }

    function warp(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 2 days));
    }

    /// A stranger tries everything it can: settle with its own signature, lock players with its own signatures, pull
    /// others' balances, open sessions for players.
    function stranger(uint256 seed, uint256 amount) external tracked(address(0), address(0)) {
        address s = vm.addr(strangerPk);
        uint256 i = _p(seed);
        vm.startPrank(s);
        if (matchIds.length > 0) {
            bytes32 id = matchIds[seed % matchIds.length];
            IGameVault.Match memory mt = vault.matchOf(id);
            IGameVault.Result memory r = _resultFor(id, mt, 1, seed % 2 == 0, mt.feeBps);
            try vault.settle(r, _sign(strangerPk, vault.hashResult(r))) {
                strangerSuccesses++;
            } catch {}
        }
        try vault.withdraw(bound(amount, 1, 1e24)) {
            strangerSuccesses++;
        } catch {}
        IGameVault.SessionAuth memory a = IGameVault.SessionAuth({
            player: players[i],
            sessionKey: s,
            maxStake: 1,
            cap: 1,
            expiry: uint64(block.timestamp + 1 hours),
            nonce: vault.sessionNonce(players[i])
        });
        try vault.openSession(a, _sign(strangerPk, vault.hashSessionAuth(a))) {
            strangerSuccesses++;
        } catch {}
        vm.stopPrank();
    }
}
