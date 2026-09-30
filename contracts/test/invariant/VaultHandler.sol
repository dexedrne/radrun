// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity 0.8.37;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {GameVault} from "../../src/GameVault.sol";
import {IGameVault, OUTCOME_WIN, OUTCOME_VOID} from "../../src/interfaces/IGameVault.sol";
import {HostileToken} from "../mocks/Tokens.sol";

/// Drives the vault as players, their session keys, the owner, the referees, the house, the token's own owner (who
/// switches on a pause, a blacklist and a sender tax at random) and a stranger, with time warps and landings on exact
/// boundaries. Every choice comes from a keccak of the fuzzed seed, so the fuzzer's favourite edge values don't pin one
/// branch. About one lock in three carries exactly one defect that must make it fail, and every call the spec says must
/// go through (settles, refunds, reclaims, cancels, withdrawals the token allows) is checked to go through. The ghosts
/// hold what the vault should hold (docs/WAGER.md §9.1); VaultInvariants compares them.
contract VaultHandler is CommonBase, StdCheats, StdUtils {
    uint256 internal constant N = 4;
    uint256 internal constant BAD_KINDS = 10;
    /// An address the token never blocks: blacklisted players exit to it.
    address public constant CLEAN = address(0xC1EA2);
    /// Where the house sends its fees itself (withdrawHouseTo).
    address public constant HOUSE_COLD = address(0xC01D);

    GameVault public immutable vault;
    HostileToken public immutable token;
    address public immutable owner;
    address public immutable house;

    address[N] public players;
    uint256[N] internal pks;
    address[N] public keys;
    uint256[N] internal keyPks;
    uint256 internal immutable strangerPk;
    /// The current referee's key, and every referee's key by address.
    uint256 internal refereePk;
    mapping(address referee => uint256 pk) internal refereePks;

    bytes32[] public matchIds;
    uint256 internal nonce;

    // ---- ghosts ---------------------------------------------------------------------------------------------------
    /// 0 none, 1 Locked, 2 Settled, 3 Voided, 4 Cancelled.
    mapping(bytes32 => uint8) public ghostState;
    /// 1: A reclaimed, 2: B reclaimed.
    mapping(bytes32 => uint8) public ghostReclaimed;
    mapping(bytes32 => address) public ghostReferee;
    /// The session nonce whose key signed that side (0: the wallet signed).
    mapping(bytes32 => uint256) internal ghostSessionA;
    mapping(bytes32 => uint256) internal ghostSessionB;
    mapping(address => uint256) public ghostUsed;
    mapping(address => address) public ghostKey;
    mapping(address => uint256) public ghostNonce;
    /// Tokens the vault holds beyond what it owes (sent to it directly), minus what the owner credited out of them.
    uint256 public ghostSurplus;

    // ---- violations (every one must stay 0) -----------------------------------------------------------------------
    uint256 public illegalFreeDrops;
    uint256 public strangerSuccesses;
    uint256 public invalidAccepted;
    uint256 public feeViolations;
    uint256 public payoutViolations;
    uint256 public settleBlocked;
    uint256 public refundBlocked;
    uint256 public reclaimBlocked;
    uint256 public cancelBlocked;
    uint256 public withdrawBlocked;
    uint256 public houseMisrouted;

    // ---- house ------------------------------------------------------------------------------------------------------
    uint256 public feesCharged;
    /// Delivered to the house or HOUSE_COLD.
    uint256 public houseWithdrawn;
    /// Sender tax the house fees paid on their way out.
    uint256 public houseTaxPaid;

    // ---- reach (logged after each run) ----------------------------------------------------------------------------
    uint256 public locks;
    uint256 public sessionLocks;
    uint256 public settles;
    uint256 public holderSettles;
    uint256 public voids;
    uint256 public mutuals;
    uint256 public refunds;
    uint256 public reclaims;
    uint256 public cancels;
    uint256 public rotations;
    uint256 public oldRefereeSettles;
    uint256 public taxedExits;
    uint256 public surplusCredits;
    uint256 public blacklistedExits;
    uint256 public settlesWhileTokenBlocked;
    uint256 public withdrawsWhileVaultPaused;
    uint256 public defectiveLocksRefused;

    uint256[N] internal lastFree;

    constructor(GameVault vault_, HostileToken token_, address owner_, address house_, uint256 refereePk_) {
        vault = vault_;
        token = token_;
        owner = owner_;
        house = house_;
        refereePk = refereePk_;
        refereePks[vm.addr(refereePk_)] = refereePk_;
        strangerPk = uint256(keccak256("handler stranger"));
        for (uint256 i = 0; i < N; i++) {
            pks[i] = uint256(keccak256(abi.encode("handler player", i)));
            players[i] = vm.addr(pks[i]);
            keyPks[i] = uint256(keccak256(abi.encode("handler session key", i)));
            keys[i] = vm.addr(keyPks[i]);
            vm.prank(players[i]);
            token.approve(address(vault_), type(uint256).max);
        }
    }

    function matchCount() external view returns (uint256) {
        return matchIds.length;
    }

    function stranger() public view returns (address) {
        return vm.addr(strangerPk);
    }

    // ---- helpers ----------------------------------------------------------------------------------------------------

    function _h(uint256 seed, string memory tag) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, tag)));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _mid(address creator, bytes32 salt) internal pure returns (bytes32) {
        return bytes32((uint256(uint160(creator)) << 96) | (uint256(salt) & type(uint96).max));
    }

    function _freshId(uint256 creator) internal returns (bytes32) {
        return _mid(players[creator], keccak256(abi.encode("handler match", nonce++)));
    }

    /// Only `okA` and `okB` (players acting themselves, or whose own key signed) may see their free balance drop.
    modifier tracked(address okA, address okB) {
        for (uint256 i = 0; i < N; i++) {
            lastFree[i] = vault.freeOf(players[i]);
        }
        _;
        for (uint256 i = 0; i < N; i++) {
            if (vault.freeOf(players[i]) < lastFree[i] && players[i] != okA && players[i] != okB) illegalFreeDrops++;
        }
    }

    function _tokenBlocks(address a) internal view returns (bool) {
        return token.paused() || token.blacklisted(a) || token.blacklisted(address(vault));
    }

    function _idx(address p) internal view returns (uint256) {
        for (uint256 i = 0; i < N; i++) {
            if (players[i] == p) return i;
        }
        revert("unknown player");
    }

    /// A void, refund or reclaim gives the stake back to the session that entered it while that session is current.
    function _ghostRelease(address player, uint256 stake, uint256 session) internal {
        if (session == 0 || ghostNonce[player] != session) return;
        uint256 used = ghostUsed[player];
        ghostUsed[player] = used > stake ? used - stake : 0;
    }

    // ---- players: funds -----------------------------------------------------------------------------------------

    function deposit(uint256 seed, uint256 amount) external tracked(address(0), address(0)) {
        uint256 i = _h(seed, "p") % N;
        address p = players[i];
        amount = bound(amount, 1, 20_000e18);
        bool over = vault.freeOf(p) + vault.lockedOf(p) + amount > vault.maxBalance();
        bool paused = vault.paused();
        // depositFor from another player about one time in four; the payer covers any sender tax.
        address payer = _h(seed, "for") % 4 == 0 ? players[(i + 1) % N] : p;
        token.mint(payer, amount + token.taxOn(amount));
        vm.prank(payer);
        try vault.depositFor(p, amount) {
            if (over || paused) invalidAccepted++;
        } catch {}
    }

    /// Withdrawals: when the token lets the vault pay the destination and the free balance covers the amount plus any
    /// sender tax, the call must go through, paused or not; otherwise it must fail.
    function withdraw(uint256 seed, uint256 amount) external {
        address p = players[_h(seed, "p") % N];
        uint256 free_ = vault.freeOf(p);
        if (free_ == 0) return;
        // A third of the time the most a taxed token lets out: free / (1 + tax).
        amount = _h(seed, "max") % 3 == 0 ? free_ * 10_000 / (10_000 + token.taxBps()) : bound(amount, 1, free_);
        if (amount == 0) return;
        _withdraw(p, amount, _h(seed, "plain") % 2 == 0);
    }

    function _withdraw(address p, uint256 amount, bool plain) internal tracked(p, address(0)) {
        address to = token.blacklisted(p) ? CLEAN : p;
        uint256 free_ = vault.freeOf(p);
        bool ok = !token.paused() && !token.blacklisted(address(vault)) && !token.blacklisted(to)
            && amount + token.taxOn(amount) <= free_;
        uint256 before = token.balanceOf(to);
        try this.doWithdraw(p, amount, to, plain && to == p) {
            _checkWithdraw(p, to, amount, free_, before, ok);
        } catch {
            if (ok) withdrawBlocked++;
        }
    }

    function _checkWithdraw(address p, address to, uint256 amount, uint256 free_, uint256 before, bool ok) internal {
        if (!ok) {
            invalidAccepted++;
            return;
        }
        uint256 tax = token.taxOn(amount);
        if (token.balanceOf(to) - before != amount) payoutViolations++;
        if (vault.freeOf(p) != free_ - amount - tax) payoutViolations++;
        if (tax != 0) taxedExits++;
        if (vault.paused()) withdrawsWhileVaultPaused++;
        if (to != p) blacklistedExits++;
    }

    /// External so a try/catch can wrap either call (excluded from the fuzzed targets).
    function doWithdraw(address p, uint256 amount, address to, bool plain) external {
        require(msg.sender == address(this));
        vm.prank(p);
        if (plain) vault.withdraw(amount);
        else vault.withdrawTo(amount, to);
    }

    /// Tokens sent straight to the vault (a wallet's plain send): nobody's balance, surplus the owner may credit.
    function donate(uint256 seed, uint256 amount) external tracked(address(0), address(0)) {
        amount = bound(amount, 1, 1_000e18);
        address donor = _h(seed, "donor") % 2 == 0 ? stranger() : players[_h(seed, "p") % N];
        token.mint(donor, amount + token.taxOn(amount));
        vm.prank(donor);
        try token.transfer(address(vault), amount) {
            ghostSurplus += amount;
        } catch {}
    }

    // ---- players: sessions ----------------------------------------------------------------------------------------

    function openSession(uint256 seed, uint128 maxStake, uint128 cap, uint32 ttl)
        external
        tracked(address(0), address(0))
    {
        uint256 i = _h(seed, "p") % N;
        maxStake = uint128(bound(maxStake, 1e18, 5_000e18));
        cap = uint128(bound(cap, maxStake, (_h(seed, "cap") % 4 == 0 ? 20 : 3) * uint256(maxStake)));
        IGameVault.SessionAuth memory a = IGameVault.SessionAuth({
            player: players[i],
            sessionKey: keys[i],
            maxStake: maxStake,
            cap: cap,
            expiry: uint64(block.timestamp + bound(ttl, 1 hours, 40 days)),
            nonce: vault.sessionNonce(players[i])
        });
        bool invalid = a.expiry > block.timestamp + 30 days || vault.paused();
        try vault.openSession(a, _sign(pks[i], vault.hashSessionAuth(a))) {
            if (invalid) invalidAccepted++;
            ghostUsed[players[i]] = 0;
            ghostKey[players[i]] = keys[i];
            ghostNonce[players[i]]++;
        } catch {}
    }

    function revokeSession(uint256 seed) external tracked(address(0), address(0)) {
        address p = players[_h(seed, "p") % N];
        vm.prank(p);
        vault.revokeSession();
        ghostUsed[p] = 0;
        ghostKey[p] = address(0);
        ghostNonce[p]++;
    }

    // ---- matches ----------------------------------------------------------------------------------------------------

    function lock(uint256 seed, uint128 stake, uint16 capA, uint16 capB) external {
        uint256 ia = _h(seed, "a") % N;
        uint256 ib = (ia + 1 + _h(seed, "b") % (N - 1)) % N;
        // Half the time a player without a live session authorises one first (as the page does before a match).
        if (_h(seed, "auth a") % 2 == 0) _ensureSession(ia, seed);
        if (_h(seed, "auth b") % 2 == 0) _ensureSession(ib, seed);
        (IGameVault.Entry memory ea, IGameVault.Entry memory eb) = _pair(seed, ia, ib, stake, capA, capB);
        uint8 ma = _mode(ia, _h(seed, "ma"));
        uint8 mb = _mode(ib, _h(seed, "mb"));
        uint256 bad = _mangle(seed, ea, eb, ma);
        if (bad >= BAD_KINDS && ma == 0 && _h(seed, "edge") % 3 == 0) _sessionEdge(seed, ia, ib, ea, eb);
        bytes memory sa = _signEntry(ia, ma, ea);
        bytes memory sb = bad == 6 ? _sign(keyPks[ia], vault.hashEntry(eb)) : _signEntry(ib, mb, eb);
        // 8: the joiner submits the pair the other way round, to sit in the creator's seat.
        if (bad == 8) _lock(eb, sb, ea, sa, mb, ma, true);
        else _lock(ea, sa, eb, sb, ma, mb, bad < BAD_KINDS);
    }

    function _pair(uint256 seed, uint256 ia, uint256 ib, uint128 stake, uint16 capA, uint16 capB)
        internal
        returns (IGameVault.Entry memory ea, IGameVault.Entry memory eb)
    {
        uint256 top = _h(seed, "big") % 20 == 0 ? 2 * uint256(vault.maxStake()) : vault.maxStake();
        stake = uint128(bound(stake, 1, top));
        _topUp(ia, stake);
        _topUp(ib, stake);
        // About 1 in 25 reuses an id that locked or was cancelled before: it must never lock again.
        bytes32 id = _h(seed, "replay") % 25 == 0 && matchIds.length > 0
            ? matchIds[_h(seed, "which") % matchIds.length]
            : _freshId(ia);
        uint16 fee = vault.houseFeeBps();
        ea = _entry(id, ia, _h(seed, "open") % 2 == 0 ? address(0) : players[ib], stake, fee + capA % 201);
        eb = _entry(id, ib, _h(seed, "named") % 8 == 0 ? address(0) : players[ia], stake, fee + capB % 201);
    }

    /// About 10 in 30 locks carry one defect that must make them fail; returns which (>= BAD_KINDS: none).
    function _mangle(uint256 seed, IGameVault.Entry memory ea, IGameVault.Entry memory eb, uint8 ma)
        internal
        view
        returns (uint256 bad)
    {
        bad = _h(seed, "bad") % 30;
        if (bad == 0) {
            eb.opponent = stranger();
        } else if (bad == 1) {
            eb.deadline = uint64(block.timestamp - 1);
        } else if (bad == 2) {
            eb.roundSeconds = 60;
        } else if (bad == 3) {
            eb.rules = keccak256("other rules");
        } else if (bad == 4) {
            eb.stake = ea.stake + 1;
        } else if (bad == 5) {
            ea.deadline = uint64(block.timestamp - 1);
        } else if (bad == 6) {
            if (ma != 0) bad = 64; // 6 = A's session key signs B's Entry (only when A has one)
        } else if (bad == 7) {
            // The id belongs to the joiner, not to playerA.
            bytes32 id = _mid(eb.player, ea.matchId);
            ea.matchId = id;
            eb.matchId = id;
        } else if (bad == 9) {
            // A cap under the house fee (on either side).
            uint16 fee = vault.houseFeeBps();
            if (fee == 0) bad = 64;
            else if (seed % 2 == 0) ea.feeCapBps = fee - 1;
            else eb.feeCapBps = uint16(_h(seed, "low") % fee);
        }
    }

    function _ensureSession(uint256 i, uint256 seed) internal {
        IGameVault.Session memory s = vault.sessionOf(players[i]);
        if (vault.paused() || (s.key != address(0) && block.timestamp < s.expiry && s.cap - s.used >= s.maxStake)) {
            return;
        }
        uint128 maxStake = uint128(bound(_h(seed, "session stake"), 1e18, vault.maxStake()));
        IGameVault.SessionAuth memory a = IGameVault.SessionAuth({
            player: players[i],
            sessionKey: keys[i],
            maxStake: maxStake,
            cap: 3 * maxStake,
            expiry: uint64(block.timestamp + 1 days),
            nonce: vault.sessionNonce(players[i])
        });
        vault.openSession(a, _sign(pks[i], vault.hashSessionAuth(a)));
        ghostUsed[players[i]] = 0;
        ghostKey[players[i]] = keys[i];
        ghostNonce[players[i]]++;
    }

    /// The relay's everyday flow: a well-formed lock (session keys where the players have them), then the match's
    /// referee settles it at once (a win at the fee or the holder fee, or a void), or it is left running.
    function playSeries(uint256 seed, uint128 stake) external {
        uint256 ia = _h(seed, "a") % N;
        uint256 ib = (ia + 1 + _h(seed, "b") % (N - 1)) % N;
        _ensureSession(ia, seed);
        _ensureSession(ib, seed);
        uint256 top = vault.maxStake();
        IGameVault.Session memory sa = vault.sessionOf(players[ia]);
        IGameVault.Session memory sb = vault.sessionOf(players[ib]);
        if (sa.maxStake < top) top = sa.maxStake;
        if (sb.maxStake < top) top = sb.maxStake;
        stake = uint128(bound(stake, 1, top));
        _topUp(ia, stake);
        _topUp(ib, stake);
        bytes32 id = _freshId(ia);
        IGameVault.Entry memory ea = _entry(id, ia, address(0), stake, vault.houseFeeBps());
        IGameVault.Entry memory eb = _entry(id, ib, players[ia], stake, vault.houseFeeBps());
        uint8 ma = _sessionOk(ea) ? 0 : 1;
        uint8 mb = _sessionOk(eb) ? 0 : 1;
        _lock(ea, _signEntry(ia, ma, ea), eb, _signEntry(ib, mb, eb), ma, mb, false);
        if (ghostState[id] != 1 || _h(seed, "leave") % 4 == 0) return;
        IGameVault.Match memory m = vault.matchOf(id);
        uint256 h = _h(seed, "result");
        bool win = h % 4 != 0;
        IGameVault.Result memory r = IGameVault.Result({
            matchId: id,
            outcome: win ? OUTCOME_WIN : OUTCOME_VOID,
            winner: win ? ((h >> 8) % 2 == 0 ? m.playerA : m.playerB) : address(0),
            feeBps: win ? ((h >> 16) % 3 == 0 ? m.holderFeeBps : m.feeBps) : 0,
            logHash: bytes32(h)
        });
        _applyResult(id, m, r, true, false, _sign(refereePk, vault.hashResult(r)), "");
    }

    /// Session-limit edges: one over the key's maxStake, or one over what its cap has left.
    function _sessionEdge(uint256 seed, uint256 ia, uint256 ib, IGameVault.Entry memory ea, IGameVault.Entry memory eb)
        internal
    {
        IGameVault.Session memory ss = vault.sessionOf(ea.player);
        uint256 left = ss.cap > ss.used ? ss.cap - ss.used : 0;
        uint256 over = _h(seed, "which edge") % 2 == 0 ? uint256(ss.maxStake) + 1 : left + 1;
        if (over > vault.maxStake()) return;
        ea.stake = uint128(over);
        eb.stake = uint128(over);
        _topUp(ia, uint128(over));
        _topUp(ib, uint128(over));
    }

    /// Whether a session-key signature for `e` must be accepted right now (docs/WAGER.md §3.2).
    function _sessionOk(IGameVault.Entry memory e) internal view returns (bool) {
        IGameVault.Session memory s = vault.sessionOf(e.player);
        return block.timestamp < s.expiry && e.stake <= s.maxStake && uint256(s.used) + e.stake <= s.cap;
    }

    /// 0 = live session key (about 60%), 1 = wallet, 2 = stranger (about 6%).
    function _mode(uint256 i, uint256 h) internal view returns (uint8) {
        if (h % 16 == 0) return 2;
        IGameVault.Session memory s = vault.sessionOf(players[i]);
        // <= so a session key is also tried at exactly its expiry (where the vault must refuse it).
        bool live = s.key != address(0) && block.timestamp <= s.expiry;
        return live && (h >> 8) % 5 < 3 ? 0 : 1;
    }

    function _topUp(uint256 i, uint128 stake) internal {
        address p = players[i];
        uint256 free_ = vault.freeOf(p);
        if (free_ >= stake) return;
        uint256 need = stake - free_;
        token.mint(p, need + token.taxOn(need));
        vm.prank(p);
        try vault.deposit(need) {} catch {}
    }

    function _entry(bytes32 id, uint256 i, address opp, uint128 stake, uint256 cap)
        internal
        view
        returns (IGameVault.Entry memory)
    {
        return IGameVault.Entry({
            matchId: id,
            player: players[i],
            opponent: opp,
            stake: stake,
            feeCapBps: uint16(cap),
            roundSeconds: 90,
            rules: keccak256("rules"),
            deadline: uint64(block.timestamp + 10 minutes)
        });
    }

    function _signEntry(uint256 i, uint8 mode, IGameVault.Entry memory e) internal view returns (bytes memory) {
        return _sign(mode == 0 ? keyPks[i] : mode == 1 ? pks[i] : strangerPk, vault.hashEntry(e));
    }

    function _lock(
        IGameVault.Entry memory ea,
        bytes memory sa,
        IGameVault.Entry memory eb,
        bytes memory sb,
        uint8 ma,
        uint8 mb,
        bool mustFail
    ) internal tracked(ma < 2 ? ea.player : address(0), mb < 2 ? eb.player : address(0)) {
        bool refused = mustFail || ma == 2 || mb == 2 || ghostState[ea.matchId] != 0 || vault.paused();
        refused = refused || (ma == 0 && !_sessionOk(ea)) || (mb == 0 && !_sessionOk(eb));
        uint16 house_ = vault.houseFeeBps();
        uint16 holder_ = vault.holderFeeBps();
        refused = refused || ea.feeCapBps < house_ || eb.feeCapBps < house_;
        try vault.lock(ea, sa, eb, sb) {
            if (refused) invalidAccepted++;
            _recordLock(ea, eb, ma, mb, house_, holder_);
        } catch {
            if (refused) defectiveLocksRefused++;
        }
    }

    function _recordLock(
        IGameVault.Entry memory ea,
        IGameVault.Entry memory eb,
        uint8 ma,
        uint8 mb,
        uint16 house_,
        uint16 holder_
    ) internal {
        bytes32 id = ea.matchId;
        locks++;
        matchIds.push(id);
        ghostState[id] = 1;
        ghostReferee[id] = vm.addr(refereePk);
        if (ma == 0) {
            ghostUsed[ea.player] += ea.stake;
            ghostSessionA[id] = ghostNonce[ea.player];
            sessionLocks++;
        }
        if (mb == 0) {
            ghostUsed[eb.player] += eb.stake;
            ghostSessionB[id] = ghostNonce[eb.player];
            sessionLocks++;
        }
        IGameVault.Match memory m = vault.matchOf(id);
        // The house fee exactly (both caps covered it), the holder fee under it, and the creator in seat A.
        if (m.feeBps != house_ || m.holderFeeBps != (holder_ < house_ ? holder_ : house_) || m.feeBps > 500) {
            feeViolations++;
        }
        if (m.playerA != ea.player || address(bytes20(id)) != m.playerA) invalidAccepted++;
    }

    /// Mostly a match that is still Locked (so settles happen), sometimes any id (so the refusals are exercised).
    function _pick(uint256 seed) internal view returns (bytes32) {
        uint256 n = matchIds.length;
        uint256 h = _h(seed, "pick");
        if (h % 6 == 0) return matchIds[h % n];
        for (uint256 k = 0; k < n; k++) {
            bytes32 id = matchIds[(h + k) % n];
            if (ghostState[id] == 1) return id;
        }
        return matchIds[h % n];
    }

    /// A referee's settle must go through whenever the Result is well formed, signed by the referee the match locked
    /// under, for a Locked match in its window, whatever the token is doing. Any other signer is refused.
    function settle(uint256 seed, uint16 oddFee) external tracked(address(0), address(0)) {
        if (matchIds.length == 0) return;
        bytes32 id = _pick(seed);
        IGameVault.Match memory m = vault.matchOf(id);
        uint256 h = _h(seed, "settle");
        bool win = h % 5 != 0;
        uint8 feeMode = uint8((h >> 8) % 8); // 0-3 captured fee, 4-5 holder fee, 6-7 another fee
        uint16 fee = feeMode < 4
            ? m.feeBps
            : feeMode < 6
                ? m.holderFeeBps
                : feeMode == 6 ? uint16(bound(oddFee, 0, m.feeBps)) : uint16(bound(oddFee, 0, 1_000));
        IGameVault.Result memory r = IGameVault.Result({
            matchId: id,
            outcome: win ? OUTCOME_WIN : OUTCOME_VOID,
            winner: win ? ((h >> 16) % 2 == 0 ? m.playerA : m.playerB) : address(0),
            feeBps: win ? fee : 0,
            logHash: bytes32(h)
        });
        if (!win && (h >> 32) % 6 == 0) r.feeBps = m.feeBps == 0 ? 1 : m.feeBps; // a void carrying a fee
        if (!win && (h >> 32) % 6 == 1) r.winner = m.playerA; // a void naming a winner
        // About 1 in 5 is signed by the current referee instead of the match's own (fine only if they are the same).
        address own = ghostReferee[id];
        uint256 pk = (h >> 40) % 5 == 0 || own == address(0) ? refereePk : refereePks[own];
        bool ok = m.state == IGameVault.MatchState.Locked && block.timestamp <= m.settleBy && vm.addr(pk) == own
            && (win ? (fee == m.feeBps || fee == m.holderFeeBps) : (r.feeBps == 0 && r.winner == address(0)));
        if (ok && own != vm.addr(refereePk)) oldRefereeSettles++;
        _applyResult(id, m, r, ok, false, _sign(pk, vault.hashResult(r)), "");
    }

    function settleMutual(uint256 seed, uint16 oddFee) external tracked(address(0), address(0)) {
        if (matchIds.length == 0) return;
        bytes32 id = _pick(seed);
        IGameVault.Match memory m = vault.matchOf(id);
        if (m.state == IGameVault.MatchState.None || m.state == IGameVault.MatchState.Cancelled) return;
        uint256 h = _h(seed, "mutual");
        bool win = h % 3 != 0;
        uint8 feeMode = uint8((h >> 8) % 3); // 0 captured, 1 holder (fails unless equal), 2 any
        uint16 fee = feeMode == 0 ? m.feeBps : feeMode == 1 ? m.holderFeeBps : uint16(bound(oddFee, 0, 1_000));
        bool keysInstead = (h >> 24) % 10 == 0; // session keys may never sign a mutual settle
        IGameVault.Result memory r = IGameVault.Result({
            matchId: id,
            outcome: win ? OUTCOME_WIN : OUTCOME_VOID,
            winner: win ? ((h >> 16) % 2 == 0 ? m.playerA : m.playerB) : address(0),
            feeBps: win ? fee : 0,
            logHash: bytes32(h)
        });
        bytes32 d = vault.hashResult(r);
        uint256 a = _idx(m.playerA);
        uint256 b = _idx(m.playerB);
        bytes memory sa = _sign(keysInstead ? keyPks[a] : pks[a], d);
        bool swapped = (h >> 32) % 10 == 0;
        bytes memory sb = _sign(swapped ? pks[a] : keysInstead ? keyPks[b] : pks[b], d);
        bool ok = !keysInstead && !swapped && m.state == IGameVault.MatchState.Locked && block.timestamp <= m.settleBy
            && (!win || fee == m.feeBps);
        _applyResult(id, m, r, ok, true, sa, sb);
    }

    function _applyResult(
        bytes32 id,
        IGameVault.Match memory m,
        IGameVault.Result memory r,
        bool ok,
        bool mutual,
        bytes memory s1,
        bytes memory s2
    ) internal {
        uint256[2] memory freeBefore = [vault.freeOf(m.playerA), vault.freeOf(m.playerB)];
        uint256 houseBefore = vault.houseAccrued();
        bool blockedToken = _tokenBlocks(m.playerA) || _tokenBlocks(m.playerB);
        bool done;
        if (mutual) {
            try vault.settleMutual(r, s1, s2) {
                done = true;
            } catch {}
        } else {
            try vault.settle(r, s1) {
                done = true;
            } catch {}
        }
        if (done != ok) {
            if (ok) settleBlocked++;
            else invalidAccepted++;
            return;
        }
        if (!done) return;
        if (mutual) mutuals++;
        if (blockedToken) settlesWhileTokenBlocked++;
        if (r.outcome == OUTCOME_WIN) _checkWin(id, m, r, freeBefore, houseBefore);
        else _checkVoid(id, m, freeBefore, houseBefore);
    }

    function _checkWin(
        bytes32 id,
        IGameVault.Match memory m,
        IGameVault.Result memory r,
        uint256[2] memory freeBefore,
        uint256 houseBefore
    ) internal {
        settles++;
        if (r.feeBps == m.holderFeeBps && m.holderFeeBps != m.feeBps) holderSettles++;
        ghostState[id] = 2;
        uint256 pot = 2 * uint256(m.stake);
        uint256 fee = pot * r.feeBps / 10_000;
        bool aWon = r.winner == m.playerA;
        if (vault.freeOf(r.winner) != freeBefore[aWon ? 0 : 1] + pot - fee) payoutViolations++;
        if (vault.freeOf(aWon ? m.playerB : m.playerA) != freeBefore[aWon ? 1 : 0]) payoutViolations++;
        if (vault.houseAccrued() != houseBefore + fee) payoutViolations++;
        feesCharged += fee;
    }

    function _checkVoid(bytes32 id, IGameVault.Match memory m, uint256[2] memory freeBefore, uint256 houseBefore)
        internal
    {
        voids++;
        ghostState[id] = 3;
        uint8 done = ghostReclaimed[id];
        uint256 backA = done & 1 == 0 ? m.stake : 0;
        uint256 backB = done & 2 == 0 ? m.stake : 0;
        if (vault.freeOf(m.playerA) != freeBefore[0] + backA) payoutViolations++;
        if (vault.freeOf(m.playerB) != freeBefore[1] + backB) payoutViolations++;
        if (vault.houseAccrued() != houseBefore) payoutViolations++;
        if (backA != 0) _ghostRelease(m.playerA, m.stake, ghostSessionA[id]);
        if (backB != 0) _ghostRelease(m.playerB, m.stake, ghostSessionB[id]);
    }

    function refundExpired(uint256 seed) external tracked(address(0), address(0)) {
        if (matchIds.length == 0) return;
        bytes32 id = _pick(seed);
        IGameVault.Match memory m = vault.matchOf(id);
        bool ok = m.state == IGameVault.MatchState.Locked && block.timestamp > m.settleBy;
        uint256[2] memory freeBefore = [vault.freeOf(m.playerA), vault.freeOf(m.playerB)];
        uint256 houseBefore = vault.houseAccrued();
        vm.prank(stranger());
        try vault.refundExpired(id) {
            if (!ok) invalidAccepted++;
            refunds++;
            _checkVoid(id, m, freeBefore, houseBefore);
        } catch {
            if (ok) refundBlocked++;
        }
    }

    /// After settleBy a player takes their own stake back, whatever the token is doing; nobody else can, and nobody
    /// twice.
    function reclaim(uint256 seed) external tracked(address(0), address(0)) {
        if (matchIds.length == 0) return;
        bytes32 id = _pick(seed);
        IGameVault.Match memory m = vault.matchOf(id);
        uint256 who = _h(seed, "who") % 5;
        address caller = who < 2 ? m.playerA : who < 4 ? m.playerB : stranger();
        if (caller == address(0)) return;
        uint8 side = caller == m.playerA ? 1 : caller == m.playerB ? 2 : 0;
        bool ok = m.state == IGameVault.MatchState.Locked && block.timestamp > m.settleBy && side != 0
            && ghostReclaimed[id] & side == 0;
        uint256 before = vault.freeOf(caller);
        vm.prank(caller);
        try vault.reclaim(id) {
            if (!ok) invalidAccepted++;
            reclaims++;
            ghostReclaimed[id] |= side;
            if (ghostReclaimed[id] == 3) ghostState[id] = 3;
            if (vault.freeOf(caller) != before + m.stake) payoutViolations++;
            _ghostRelease(caller, m.stake, side == 1 ? ghostSessionA[id] : ghostSessionB[id]);
        } catch {
            if (ok) reclaimBlocked++;
        }
    }

    /// A creator cancels an id of their own that never locked: always possible, and it never locks afterwards. Nobody
    /// else can cancel it, and a used id can't be cancelled.
    function cancel(uint256 seed) external tracked(address(0), address(0)) {
        uint256 h = _h(seed, "cancel");
        uint256 i = h % N;
        uint256 k = (h >> 8) % 4;
        if (k == 0 && matchIds.length > 0) {
            bytes32 used = matchIds[(h >> 16) % matchIds.length];
            vm.prank(address(bytes20(used)));
            try vault.cancel(used) {
                invalidAccepted++;
            } catch {}
            return;
        }
        bytes32 id = _freshId(i);
        if (k == 1) {
            vm.prank((h >> 24) % 2 == 0 ? players[(i + 1) % N] : stranger());
            try vault.cancel(id) {
                strangerSuccesses++;
            } catch {}
            return;
        }
        vm.prank(players[i]);
        try vault.cancel(id) {
            cancels++;
            matchIds.push(id);
            ghostState[id] = 4;
        } catch {
            cancelBlocked++;
            return;
        }
        // The creator's own Entry for it (and a willing opponent's) can never lock now.
        uint256 j = (i + 1) % N;
        _topUp(i, 1e18);
        _topUp(j, 1e18);
        IGameVault.Entry memory ea = _entry(id, i, address(0), 1e18, 500);
        IGameVault.Entry memory eb = _entry(id, j, players[i], 1e18, 500);
        _lock(ea, _signEntry(i, 1, ea), eb, _signEntry(j, 1, eb), 1, 1, true);
    }

    // ---- house, owner, the token's owner, time, a stranger ----------------------------------------------------------

    /// The house's fees leave only to the house, or where the house itself sends them; the house pays any sender tax.
    function withdrawHouse(uint256 seed, uint256 amount) external tracked(address(0), address(0)) {
        uint256 accrued = vault.houseAccrued();
        uint256 h = _h(seed, "house");
        bool all = h % 3 == 0;
        address to = all || (h >> 8) % 2 == 0 ? house : HOUSE_COLD;
        amount = all ? accrued : bound(amount, 1, accrued + 1);
        uint256 tax = token.taxOn(amount);
        bool tokenOk = !token.paused() && !token.blacklisted(address(vault)) && !token.blacklisted(to);
        bool byStranger = !all && (h >> 16) % 8 == 0;
        bool ok = amount != 0 && amount + tax <= accrued && tokenOk && !byStranger;
        uint256 before = token.balanceOf(to);
        bool done;
        if (all) {
            vm.prank(stranger()); // anyone may send the fees to the house itself
            try vault.withdrawHouse() {
                done = true;
            } catch {}
        } else {
            vm.prank(byStranger ? stranger() : house);
            try vault.withdrawHouseTo(amount, to) {
                done = true;
            } catch {}
        }
        if (!done) {
            if (ok) withdrawBlocked++;
            return;
        }
        if (!ok) {
            invalidAccepted++;
            return;
        }
        houseWithdrawn += amount;
        houseTaxPaid += tax;
        if (token.balanceOf(to) - before != amount) houseMisrouted++;
        if (vault.houseAccrued() != accrued - amount - tax) houseMisrouted++;
    }

    function ownerSettings(uint256 seed, uint16 fee, uint16 holderFee, uint128 maxStake, uint128 maxBalance)
        external
        tracked(address(0), address(0))
    {
        uint256 h = _h(seed, "owner") % 12;
        vm.startPrank(owner);
        if (h < 3) {
            vault.setHouseFees(uint16(bound(fee, 0, 500)), uint16(bound(holderFee, 0, 500)));
        } else if (h < 5) {
            vault.setCaps(uint128(bound(maxStake, 1e18, 5_000e18)), uint128(bound(maxBalance, 10_000e18, 500_000e18)));
        } else if (h == 5 && !vault.paused()) {
            vault.pause();
        } else if (h >= 6 && h <= 7 && vault.paused()) {
            vault.unpause();
        } else if (h == 8) {
            refereePk = uint256(keccak256(abi.encode("handler referee", seed)));
            refereePks[vm.addr(refereePk)] = refereePk;
            vault.setReferee(vm.addr(refereePk));
            rotations++;
        } else if (h <= 10) {
            _creditSurplus(seed, maxBalance);
        } else {
            try vault.renounceOwnership() {
                invalidAccepted++;
            } catch {}
        }
        vm.stopPrank();
    }

    /// Only surplus (the ghost's direct transfers, never a liability) can be credited, and only by the owner.
    function _creditSurplus(uint256 seed, uint256 amount) internal {
        address p = players[_h(seed, "credit to") % N];
        amount = bound(amount, 1, ghostSurplus + 2);
        bool ok = amount <= ghostSurplus;
        uint256 before = vault.freeOf(p);
        try vault.creditSurplus(p, amount) {
            if (!ok) invalidAccepted++;
            ghostSurplus -= amount;
            surplusCredits++;
            if (vault.freeOf(p) != before + amount) payoutViolations++;
        } catch {
            if (ok) withdrawBlocked++;
        }
    }

    /// The token's own owner: pause, blacklist a player or the house, a sender tax on or off (never the vault or CLEAN).
    function tokenAdmin(uint256 seed) external tracked(address(0), address(0)) {
        uint256 h = _h(seed, "token");
        uint256 k = h % 10;
        if (k == 0) token.setPaused(!token.paused());
        else if (k < 4) token.setBlacklisted(players[(h >> 8) % N], (h >> 16) % 2 == 0);
        else if (k == 4) token.setBlacklisted(house, !token.blacklisted(house));
        else if (k == 5) token.setTax([uint256(1), 10, 100, 500][(h >> 8) % 4]);
        else if (k == 6) token.setTax(0);
        else if (token.paused()) token.setPaused(false);
    }

    /// Lands exactly on a boundary: a live match's settleBy (settle works, refund and reclaim don't) or a session's
    /// expiry (its key must no longer lock).
    function boundary(uint256 seed) external tracked(address(0), address(0)) {
        uint256 h = _h(seed, "edge");
        if (h % 2 == 0 && matchIds.length > 0) {
            bytes32 id = _pick(seed);
            IGameVault.Match memory m = vault.matchOf(id);
            if (m.state != IGameVault.MatchState.Locked || m.settleBy < block.timestamp) return;
            vm.warp(m.settleBy);
            try vault.refundExpired(id) {
                invalidAccepted++;
                ghostState[id] = 3;
                return;
            } catch {}
            vm.prank(m.playerA);
            try vault.reclaim(id) {
                invalidAccepted++;
                ghostReclaimed[id] |= 1;
                return;
            } catch {}
            // The last second of the window still settles.
            IGameVault.Result memory r = IGameVault.Result({
                matchId: id, outcome: OUTCOME_VOID, winner: address(0), feeBps: 0, logHash: bytes32(h)
            });
            _applyResult(id, m, r, true, false, _sign(refereePks[ghostReferee[id]], vault.hashResult(r)), "");
        } else {
            address p = players[(h >> 8) % N];
            IGameVault.Session memory s = vault.sessionOf(p);
            if (s.key == address(0) || s.expiry < block.timestamp) return;
            vm.warp(s.expiry);
        }
    }

    /// Uses a session up with full-size session-key locks until what its cap has left is under its maxStake, then
    /// tries one unit over the cap (the vault must refuse that one).
    function sessionCapEdge(uint256 seed) external {
        uint256 ia = _h(seed, "p") % N;
        uint256 ib = (ia + 1) % N;
        for (uint256 k = 0; k < 6; k++) {
            IGameVault.Session memory s = vault.sessionOf(players[ia]);
            if (s.key == address(0) || block.timestamp >= s.expiry || vault.paused()) return;
            uint256 left = s.cap - s.used;
            uint256 st = left < s.maxStake ? left + 1 : s.maxStake;
            if (st == 0 || st > vault.maxStake()) return;
            _topUp(ia, uint128(st));
            _topUp(ib, uint128(st));
            bytes32 id = _freshId(ia);
            IGameVault.Entry memory ea = _entry(id, ia, address(0), uint128(st), 500);
            IGameVault.Entry memory eb = _entry(id, ib, players[ia], uint128(st), 500);
            _lock(ea, _signEntry(ia, 0, ea), eb, _signEntry(ib, 1, eb), 0, 1, false);
            if (left < s.maxStake) return;
        }
    }

    /// A's live session key signs B's Entry while B also holds a live session: refused (a key signs for its own
    /// player only).
    function crossKey(uint256 seed) external {
        uint256 ia = _h(seed, "p") % N;
        uint256 ib = (ia + 1 + _h(seed, "q") % (N - 1)) % N;
        IGameVault.Session memory sa = vault.sessionOf(players[ia]);
        IGameVault.Session memory sb = vault.sessionOf(players[ib]);
        if (
            sa.key == address(0) || sb.key == address(0) || block.timestamp >= sa.expiry || block.timestamp >= sb.expiry
        ) {
            return;
        }
        if (vault.paused()) return;
        _topUp(ia, 1);
        _topUp(ib, 1);
        bytes32 id = _freshId(ia);
        IGameVault.Entry memory ea = _entry(id, ia, address(0), 1, 500);
        IGameVault.Entry memory eb = _entry(id, ib, players[ia], 1, 500);
        _lock(ea, _signEntry(ia, 0, ea), eb, _sign(keyPks[ia], vault.hashEntry(eb)), 0, 2, true);
    }

    function depositToCap(uint256 seed, bool onePast) external tracked(address(0), address(0)) {
        address p = players[_h(seed, "p") % N];
        uint256 held = vault.freeOf(p) + vault.lockedOf(p);
        uint256 cap = vault.maxBalance();
        if (held >= cap || cap - held > 1e24) return;
        uint256 amount = cap - held + (onePast ? 1 : 0);
        token.mint(p, amount + token.taxOn(amount));
        vm.prank(p);
        try vault.deposit(amount) {
            if (onePast) invalidAccepted++;
        } catch {}
    }

    function warp(uint256 seed, uint32 secs) external {
        uint256 k = _h(seed, "warp") % 4;
        vm.warp(block.timestamp + (k == 0 ? bound(secs, 1 days, 3 days) : bound(secs, 0, 2 hours)));
    }

    /// A stranger tries everything that needs someone else's key or role.
    function strangerTries(uint256 seed, uint256 amount) external tracked(address(0), address(0)) {
        address s = stranger();
        uint256 i = _h(seed, "p") % N;
        vm.startPrank(s);
        if (matchIds.length > 0) {
            bytes32 id = matchIds[_h(seed, "m") % matchIds.length];
            IGameVault.Match memory m = vault.matchOf(id);
            IGameVault.Result memory r = IGameVault.Result({
                matchId: id, outcome: OUTCOME_WIN, winner: m.playerA, feeBps: m.feeBps, logHash: bytes32(0)
            });
            bytes memory sig = _sign(strangerPk, vault.hashResult(r));
            try vault.settle(r, sig) {
                strangerSuccesses++;
            } catch {}
            try vault.settleMutual(r, sig, sig) {
                strangerSuccesses++;
            } catch {}
        }
        try vault.withdraw(bound(amount, 1, 1e24)) {
            strangerSuccesses++;
        } catch {}
        try vault.withdrawHouseTo(1, s) {
            strangerSuccesses++;
        } catch {}
        try vault.creditSurplus(s, 1) {
            strangerSuccesses++;
        } catch {}
        try vault.setReferee(s) {
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
        // A session key signing a SessionAuth for its own player (it must not be able to extend itself).
        a.sessionKey = keys[i];
        a.maxStake = 1e30;
        a.cap = 1e30;
        try vault.openSession(a, _sign(keyPks[i], vault.hashSessionAuth(a))) {
            strangerSuccesses++;
        } catch {}
        vm.stopPrank();
    }
}
