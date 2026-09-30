// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {
    IGameVault,
    SESSION_AUTH_TYPEHASH,
    ENTRY_TYPEHASH,
    RESULT_TYPEHASH,
    OUTCOME_WIN,
    OUTCOME_VOID,
    VOID_REFEREE,
    VOID_MUTUAL,
    VOID_TIMEOUT
} from "./interfaces/IGameVault.sol";

/// @title RadRun GameVault
/// @notice The SPIDER-TAG wager vault (docs/WAGER.md §3). One vault per token; the token, the house and the settle
/// window are fixed at deploy. Players deposit once, enter 1v1 matches with EIP-712 Entries signed by a scoped session
/// key (or their wallet), and withdraw their free balance to any address at any time. A Result signed by the referee the
/// match locked under pays the winner the pot minus the house fee, or refunds both. The owner changes settings only: it
/// can never move, freeze or block a player's balance or decide a live match, and there is no proxy, upgrade path or
/// admin withdrawal. The one thing it can hand out is surplus: tokens the vault holds beyond everything it owes.
/// @dev Accounting: `totalLiabilities == Σfree + Σlocked + houseAccrued <= token.balanceOf(this)`. Only deposits,
/// withdrawals (players' and the house's) and surplus credits change `totalLiabilities`; lock, settle, void and reclaim
/// move value between buckets and never call the token, so a token that blocks an address can never block a settle or
/// a refund. Every amount fits in 128 bits: a deposit or credit may not take `totalLiabilities` above
/// `type(uint128).max`, and every bucket is bounded by it, so no settle or refund can overflow.
// Every deadline is block.timestamp by design (docs/WAGER.md §3.2: block.number is an L1 estimate on Robinhood Chain).
// forge-lint: disable-start(block-timestamp)
contract GameVault is IGameVault, EIP712, Ownable2Step, Pausable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// Hard cap on every fee: 5%.
    uint16 public constant MAX_FEE_BPS = 500;
    /// Longest a session key may live.
    uint64 public constant MAX_SESSION_TTL = 30 days;
    uint32 internal constant MIN_SETTLE_WINDOW = 1 hours;
    uint32 internal constant MAX_SETTLE_WINDOW = 7 days;
    uint256 internal constant BPS = 10_000;
    uint8 internal constant RECLAIMED_A = 1;
    uint8 internal constant RECLAIMED_B = 2;

    IERC20 internal immutable _token;
    /// Receives the house fees (withdrawHouse, which anyone may call), or sends them elsewhere itself (withdrawHouseTo).
    /// Fixed at deploy.
    address public immutable house;
    /// Seconds from a lock to its settleBy.
    uint32 public immutable settleWindow;

    // ---- settings (owner) ---------------------------------------------------------------------------------------
    // Packed so a lock reads one settings slot: the stake cap, both fees and the current referee's epoch.
    uint128 public maxStake;
    uint16 public houseFeeBps;
    uint16 public holderFeeBps;
    uint32 internal _refereeEpoch;
    uint128 public maxBalance;

    // ---- accounting -----------------------------------------------------------------------------------------------
    uint128 internal _totalLiabilities;
    uint128 internal _houseAccrued;

    struct Account {
        uint128 free;
        uint128 locked;
    }

    /// Storage form of a session: the key, its expiry and the player's nonce share one slot.
    struct SessionSlot {
        address key;
        uint40 expiry;
        uint56 nonce;
        uint128 maxStake;
        uint128 cap;
        uint128 used;
    }

    /// Storage form of a match (matchOf builds the ABI's Match from it). Four slots, like the ABI struct, with room for
    /// the referee's epoch, the session each stake was entered under and the sides that reclaimed; settleBy is
    /// lockedAt + settleWindow.
    struct MatchSlot {
        address playerA;
        uint16 feeBps;
        uint16 holderFeeBps;
        uint16 roundSeconds;
        MatchState state;
        /// RECLAIMED_A | RECLAIMED_B: the sides that took their stake back after settleBy.
        uint8 reclaimed;
        address playerB;
        uint40 lockedAt;
        /// The referee this match locked under (_referees[refereeEpoch]): the only one whose Result it takes.
        uint32 refereeEpoch;
        uint128 stake;
        /// The session (the player's session nonce) whose key signed that side's Entry; 0 for a wallet signature. A void
        /// gives the stake back to that session's cap while it is still the player's session.
        uint56 sessionA;
        uint56 sessionB;
        bytes32 rules;
    }

    mapping(address player => Account) internal _accounts;
    mapping(address player => SessionSlot) internal _sessions;
    mapping(bytes32 matchId => MatchSlot) internal _matches;
    /// Every referee the vault has had, by epoch (the first is 1); setReferee starts a new epoch.
    mapping(uint32 epoch => address) internal _referees;

    constructor(
        IERC20Metadata token_,
        address house_,
        address referee_,
        address owner_,
        uint16 houseFeeBps_,
        uint16 holderFeeBps_,
        uint128 maxStake_,
        uint128 maxBalance_,
        uint32 settleWindow_
    ) EIP712("RadRun GameVault", "1") Ownable(_nonzero(owner_)) {
        if (address(token_) == address(0) || house_ == address(0)) revert ZeroAddress();
        if (address(token_).code.length == 0) revert BadConfig();
        // A token without a working decimals() is not one the client, the relay or the deploy probe can handle.
        try token_.decimals() returns (uint8) {}
        catch {
            revert BadConfig();
        }
        if (settleWindow_ < MIN_SETTLE_WINDOW || settleWindow_ > MAX_SETTLE_WINDOW) revert BadConfig();
        _token = IERC20(address(token_));
        house = house_;
        settleWindow = settleWindow_;
        _setHouseFees(houseFeeBps_, holderFeeBps_);
        _setCaps(maxStake_, maxBalance_);
        _setReferee(referee_);
    }

    // =================================================================================================================
    // Player funds
    // =================================================================================================================

    /// @inheritdoc IGameVault
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        _deposit(msg.sender, amount);
    }

    /// @inheritdoc IGameVault
    function depositFor(address player, uint256 amount) external nonReentrant whenNotPaused {
        _deposit(player, amount);
    }

    /// @inheritdoc IGameVault
    function withdraw(uint256 amount) external nonReentrant {
        _withdraw(amount, msg.sender);
    }

    /// @inheritdoc IGameVault
    function withdrawTo(uint256 amount, address to) external nonReentrant {
        _withdraw(amount, to);
    }

    function _deposit(address player, uint256 amount) private {
        if (player == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        Account storage acct = _accounts[player];
        uint256 cap = maxBalance;
        uint256 held = uint256(acct.free) + acct.locked;
        // Winnings may take a player past the cap; a deposit may not.
        if (held > cap || amount > cap - held) revert BalanceCapExceeded(player, cap);
        if (uint256(_totalLiabilities) + amount > type(uint128).max) {
            revert BalanceCapExceeded(player, type(uint128).max);
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 amt = uint128(amount); // safe: amount <= maxBalance, a uint128

        uint256 before = _token.balanceOf(address(this));
        _token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 afterBal = _token.balanceOf(address(this));
        uint256 received = afterBal > before ? afterBal - before : 0;
        // Fee-on-transfer, rebasing and hooked tokens deliver a different amount: rejected (docs/WAGER.md §3.6).
        if (received != amount) revert TransferMismatch(amount, received);

        acct.free += amt;
        _totalLiabilities += amt;
        // The credit has to follow the balance check; nonReentrant keeps this log in order.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Deposited(player, msg.sender, amount);
    }

    function _withdraw(uint256 amount, address to) private {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        Account storage acct = _accounts[msg.sender];
        uint128 free_ = acct.free;
        if (amount > free_) revert InsufficientFree(msg.sender, free_, amount);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 amt = uint128(amount); // safe: amount <= free_, a uint128
        acct.free = free_ - amt;
        _totalLiabilities -= amt;
        emit Withdrawn(msg.sender, to, amount);
        uint256 extra = _send(to, amount);
        if (extra != 0) {
            // Read again: the free balance is only final after the transfer (a token hook may have re-entered a lock).
            free_ = acct.free;
            if (extra > free_) revert TransferMismatch(amount, amount + extra);
            // forge-lint: disable-next-line(unsafe-typecast)
            uint128 tax = uint128(extra); // safe: extra <= free_, a uint128
            acct.free = free_ - tax;
            _totalLiabilities -= tax;
            // forge-lint: disable-next-line(reentrancy-events)
            emit TransferTaxPaid(msg.sender, extra);
        }
    }

    /// Pays `amount` out and returns how much more than that the vault's balance fell: a tax the token charges the
    /// vault as the sender, which the caller bills to whoever is being paid out (so the vault never owes more than it
    /// holds). A smaller fall (part of a reflection fee comes back to the vault) leaves the difference as surplus. A
    /// transfer that takes nothing from the vault (paying the vault itself, a token that moved nothing) is refused.
    function _send(address to, uint256 amount) private returns (uint256 extra) {
        uint256 before = _token.balanceOf(address(this));
        _token.safeTransfer(to, amount);
        uint256 afterBal = _token.balanceOf(address(this));
        uint256 sent = before > afterBal ? before - afterBal : 0;
        if (sent == 0) revert TransferMismatch(amount, 0);
        if (sent > amount) extra = sent - amount;
    }

    // =================================================================================================================
    // Session keys
    // =================================================================================================================

    /// @inheritdoc IGameVault
    /// @dev SessionOpened carries the nonce this SessionAuth consumed; the player's next nonce is one more.
    function openSession(SessionAuth calldata auth, bytes calldata walletSig) external whenNotPaused {
        address player = auth.player;
        if (player == address(0) || auth.sessionKey == address(0)) revert ZeroAddress();
        SessionSlot storage s = _sessions[player];
        uint56 nonce = s.nonce;
        if (auth.nonce != nonce) revert BadNonce(nonce, auth.nonce);
        if (auth.maxStake == 0 || auth.maxStake > auth.cap) revert BadSession();
        if (auth.expiry <= block.timestamp || auth.expiry > block.timestamp + MAX_SESSION_TTL) revert BadSession();
        if (!_isValidSig(player, hashSessionAuth(auth), walletSig)) revert BadSignature(player);

        _sessions[player] = SessionSlot({
            key: auth.sessionKey,
            // forge-lint: disable-next-line(unsafe-typecast)
            expiry: uint40(auth.expiry), // safe: expiry <= now + 30 days
            nonce: nonce + 1,
            maxStake: auth.maxStake,
            cap: auth.cap,
            used: 0
        });
        // Only staticcalls (ERC-1271, balanceOf) come before this log.
        // forge-lint: disable-next-line(reentrancy-events)
        emit SessionOpened(player, auth.sessionKey, auth.maxStake, auth.cap, auth.expiry, auth.nonce);
    }

    /// @inheritdoc IGameVault
    /// @dev Never paused. SessionRevoked carries the player's new nonce (every SessionAuth signed below it is dead).
    function revokeSession() external {
        uint56 next = _sessions[msg.sender].nonce + 1;
        delete _sessions[msg.sender];
        _sessions[msg.sender].nonce = next;
        emit SessionRevoked(msg.sender, next);
    }

    // =================================================================================================================
    // Matches
    // =================================================================================================================

    /// @inheritdoc IGameVault
    /// @dev The one external call is a staticcall (balanceOf), so lock needs no reentrancy guard.
    function lock(Entry calldata a, bytes calldata sigA, Entry calldata b, bytes calldata sigB) external whenNotPaused {
        (uint128 stake, uint16 feeBps, uint16 holderFee, uint32 epoch) = _checkTerms(a, b);
        uint56 sessionA = _checkEntry(a, sigA);
        uint56 sessionB = _checkEntry(b, sigB);
        _lockStake(a.player, stake);
        _lockStake(b.player, stake);

        // A token whose balance fell under what the vault owes (negative rebase, a hook) stops new matches.
        uint256 bal = _token.balanceOf(address(this));
        uint256 liabilities = _totalLiabilities;
        if (bal < liabilities) revert Insolvent(bal, liabilities);

        _record(a, b.player, feeBps, holderFee, epoch, sessionA, sessionB);
    }

    /// The pairing checks of lock, in the spec's order (docs/WAGER.md §3.2, steps 2-8), and the settings it captures:
    /// the house fee (both caps cover it), the holder fee under it and the current referee's epoch.
    function _checkTerms(Entry calldata a, Entry calldata b)
        private
        view
        returns (uint128 stake, uint16 feeBps, uint16 holderFee, uint32 epoch)
    {
        bytes32 matchId = a.matchId;
        if (b.matchId != matchId) revert EntryMismatch();
        address pa = a.player;
        address pb = b.player;
        // Only the creator can be playerA of their id: nobody else can burn a published id, or swap the seats.
        if (_creatorOf(matchId) != pa) revert BadMatchId(matchId);
        if (_matches[matchId].state != MatchState.None) revert MatchExists(matchId);
        if (pa == address(0) || pb == address(0)) revert ZeroAddress();
        if (pa == pb) revert EntryMismatch();
        if ((a.opponent != address(0) && a.opponent != pb) || (b.opponent != address(0) && b.opponent != pa)) {
            revert EntryMismatch();
        }
        stake = a.stake;
        if (b.stake != stake) revert EntryMismatch();
        uint128 maxStake_ = maxStake;
        if (stake == 0 || stake > maxStake_) revert StakeOutOfRange(stake, maxStake_);
        // A player's cap bounds the fee they pay; it can't lower the house's fee (the match would lock at the cap).
        feeBps = houseFeeBps;
        if (a.feeCapBps < feeBps) revert FeeAboveCap(pa, feeBps, a.feeCapBps);
        if (b.feeCapBps < feeBps) revert FeeAboveCap(pb, feeBps, b.feeCapBps);
        holderFee = _min(holderFeeBps, feeBps);
        epoch = _refereeEpoch;
        if (a.roundSeconds != b.roundSeconds || a.rules != b.rules) revert EntryMismatch();
        if (block.timestamp > a.deadline) revert EntryExpired(pa, a.deadline);
        if (block.timestamp > b.deadline) revert EntryExpired(pb, b.deadline);
    }

    /// Stores the match with what it captured at lock.
    function _record(
        Entry calldata a,
        address pb,
        uint16 feeBps,
        uint16 holderFee,
        uint32 epoch,
        uint56 sessionA,
        uint56 sessionB
    ) private {
        // forge-lint: disable-next-line(unsafe-typecast)
        uint40 lockedAt = uint40(block.timestamp); // safe: unix seconds fit 40 bits for 34,000 years
        _matches[a.matchId] = MatchSlot({
            playerA: a.player,
            feeBps: feeBps,
            holderFeeBps: holderFee,
            roundSeconds: a.roundSeconds,
            state: MatchState.Locked,
            reclaimed: 0,
            playerB: pb,
            lockedAt: lockedAt,
            refereeEpoch: epoch,
            stake: a.stake,
            sessionA: sessionA,
            sessionB: sessionB,
            rules: a.rules
        });
        // Only staticcalls (ERC-1271, balanceOf) come before this log.
        // forge-lint: disable-next-item(reentrancy-events)
        emit MatchLocked(
            a.matchId,
            a.player,
            pb,
            a.stake,
            feeBps,
            holderFee,
            a.roundSeconds,
            a.rules,
            uint64(lockedAt) + settleWindow
        );
    }

    /// Accepts an Entry signed by the player's wallet (ECDSA, or ERC-1271 for a contract wallet) or by the player's
    /// live session key within its limits (which it then spends). Returns the session's nonce when its key signed (a
    /// live session's nonce is never 0), 0 for the wallet.
    function _checkEntry(Entry calldata e, bytes calldata sig) private returns (uint56) {
        address player = e.player;
        bytes32 digest = hashEntry(e);
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, sig);
        if (err == ECDSA.RecoverError.NoError) {
            if (signer == player) return 0;
            SessionSlot storage s = _sessions[player];
            if (signer == s.key) {
                uint256 used = uint256(s.used) + e.stake;
                if (block.timestamp >= s.expiry || e.stake > s.maxStake || used > s.cap) revert SessionLimit(player);
                // forge-lint: disable-next-line(unsafe-typecast)
                s.used = uint128(used); // safe: used <= cap, a uint128
                return s.nonce;
            }
        }
        if (player.code.length != 0 && SignatureChecker.isValidERC1271SignatureNowCalldata(player, digest, sig)) {
            return 0;
        }
        revert BadSignature(player);
    }

    function _lockStake(address player, uint128 stake) private {
        Account memory acct = _accounts[player];
        if (acct.free < stake) revert InsufficientFree(player, acct.free, stake);
        _accounts[player] = Account({free: acct.free - stake, locked: acct.locked + stake});
    }

    /// @inheritdoc IGameVault
    /// @dev Never paused. Only a Match the id's creator never locked can be cancelled; its Entries then never lock.
    function cancel(bytes32 matchId) external {
        if (_creatorOf(matchId) != msg.sender) revert BadMatchId(matchId);
        MatchSlot storage m = _matches[matchId];
        if (m.state != MatchState.None) revert MatchExists(matchId);
        m.state = MatchState.Cancelled;
        m.playerA = msg.sender;
        emit MatchCancelled(matchId, msg.sender);
    }

    /// @inheritdoc IGameVault
    function settle(Result calldata r, bytes calldata refereeSig) external {
        MatchSlot storage m = _settleable(r.matchId);
        // The referee the match locked under: a later setReferee neither decides it nor voids its signed Results.
        address referee_ = _referees[m.refereeEpoch];
        if (!_isValidSig(referee_, hashResult(r), refereeSig)) revert BadSignature(referee_);
        _apply(m, r, false);
    }

    /// @inheritdoc IGameVault
    function settleMutual(Result calldata r, bytes calldata sigA, bytes calldata sigB) external {
        MatchSlot storage m = _settleable(r.matchId);
        bytes32 digest = hashResult(r);
        address pa = m.playerA;
        address pb = m.playerB;
        // _isValidSig only accepts the players' own wallets: a session key recovers to another address.
        if (!_isValidSig(pa, digest, sigA)) revert BadSignature(pa);
        if (!_isValidSig(pb, digest, sigB)) revert BadSignature(pb);
        _apply(m, r, true);
    }

    /// @inheritdoc IGameVault
    function refundExpired(bytes32 matchId) external {
        MatchSlot storage m = _expired(matchId);
        _void(m, matchId, VOID_TIMEOUT, bytes32(0));
    }

    /// @inheritdoc IGameVault
    /// @dev Never paused. Releases only msg.sender's stake and logs only msg.sender, so a player never depends on a
    /// transaction that involves the other player (whom the chain or the token may refuse).
    function reclaim(bytes32 matchId) external {
        MatchSlot storage m = _expired(matchId);
        uint8 side = msg.sender == m.playerA ? RECLAIMED_A : msg.sender == m.playerB ? RECLAIMED_B : 0;
        uint8 done = m.reclaimed;
        if (side == 0 || done & side != 0) revert NothingToReclaim(matchId, msg.sender);
        done |= side;
        m.reclaimed = done;
        // Both stakes out: the match is over (MatchVoided would name the other player, so only StakeReclaimed logs it).
        if (done == RECLAIMED_A | RECLAIMED_B) m.state = MatchState.Voided;
        uint128 stake = m.stake;
        _release(msg.sender, stake, side == RECLAIMED_A ? m.sessionA : m.sessionB);
        emit StakeReclaimed(matchId, msg.sender, stake);
    }

    function _settleable(bytes32 matchId) private view returns (MatchSlot storage m) {
        m = _matches[matchId];
        if (m.state != MatchState.Locked) revert NotLocked(matchId);
        uint64 settleBy = _settleBy(m);
        if (block.timestamp > settleBy) revert SettleWindowClosed(matchId, settleBy);
    }

    function _expired(bytes32 matchId) private view returns (MatchSlot storage m) {
        m = _matches[matchId];
        if (m.state != MatchState.Locked) revert NotLocked(matchId);
        uint64 settleBy = _settleBy(m);
        if (block.timestamp <= settleBy) revert SettleWindowOpen(matchId, settleBy);
    }

    function _settleBy(MatchSlot storage m) private view returns (uint64) {
        return uint64(m.lockedAt) + settleWindow;
    }

    /// Applies a checked Result. Internal credits only: nothing here calls the token.
    function _apply(MatchSlot storage m, Result calldata r, bool mutual) private {
        if (r.outcome == OUTCOME_WIN) {
            _win(m, r, mutual);
        } else if (r.outcome == OUTCOME_VOID) {
            if (r.winner != address(0) || r.feeBps != 0) revert BadResult();
            _void(m, r.matchId, mutual ? VOID_MUTUAL : VOID_REFEREE, r.logHash);
        } else {
            revert BadResult();
        }
    }

    function _win(MatchSlot storage m, Result calldata r, bool mutual) private {
        address winner = r.winner;
        address pa = m.playerA;
        address pb = m.playerB;
        // Players are never address(0), so a zero loser means the winner is neither of them.
        address loser = winner == pa ? pb : winner == pb ? pa : address(0);
        if (loser == address(0)) revert BadResult();
        uint16 feeBps = r.feeBps;
        // The referee may give a Radbro-holder winner the captured holder fee; players settling between themselves
        // may not.
        if (feeBps != m.feeBps && (mutual || feeBps != m.holderFeeBps)) revert BadResult();
        m.state = MatchState.Settled;
        (uint256 payout, uint256 fee) = _credit(winner, loser, m.stake, feeBps);
        // Only staticcalls (ERC-1271, balanceOf) come before this log.
        // forge-lint: disable-next-line(reentrancy-events)
        emit MatchSettled(r.matchId, winner, loser, payout, fee, feeBps, r.logHash, mutual);
    }

    /// pot = 2 x stake; fee = pot x feeBps / 10 000 rounded down (the dust stays with the winner).
    function _credit(address winner, address loser, uint128 stake, uint16 feeBps)
        private
        returns (uint256 payout, uint256 fee)
    {
        uint256 pot = 2 * uint256(stake);
        fee = pot * feeBps / BPS;
        payout = pot - fee;
        // Both casts are safe: payout and fee are at most the pot, which both stakes (<= totalLiabilities, which a
        // deposit keeps within uint128) already cover.
        Account memory w = _accounts[winner];
        // forge-lint: disable-next-line(unsafe-typecast)
        _accounts[winner] = Account({free: w.free + uint128(payout), locked: w.locked - stake});
        _accounts[loser].locked -= stake;
        // forge-lint: disable-next-line(unsafe-typecast)
        _houseAccrued += uint128(fee);
    }

    /// Both stakes (those not reclaimed yet) go back to free, and back to the cap of the session that entered them.
    function _void(MatchSlot storage m, bytes32 matchId, uint8 reason, bytes32 logHash) private {
        m.state = MatchState.Voided;
        uint128 stake = m.stake;
        address pa = m.playerA;
        address pb = m.playerB;
        uint8 done = m.reclaimed;
        if (done & RECLAIMED_A == 0) _release(pa, stake, m.sessionA);
        if (done & RECLAIMED_B == 0) _release(pb, stake, m.sessionB);
        // Only staticcalls (ERC-1271, balanceOf) come before this log.
        // forge-lint: disable-next-line(reentrancy-events)
        emit MatchVoided(matchId, pa, pb, reason, logHash);
    }

    /// A match that didn't happen doesn't count against the session that entered it: while that session is still the
    /// player's (same nonce: not replaced or revoked since), its used total drops by the stake again.
    function _release(address player, uint128 stake, uint56 session) private {
        Account memory acct = _accounts[player];
        _accounts[player] = Account({free: acct.free + stake, locked: acct.locked - stake});
        if (session == 0) return;
        SessionSlot storage s = _sessions[player];
        if (s.nonce != session) return;
        uint128 used = s.used;
        s.used = used > stake ? used - stake : 0;
    }

    // =================================================================================================================
    // House
    // =================================================================================================================

    /// @inheritdoc IGameVault
    function withdrawHouse() external nonReentrant {
        _withdrawHouse(_houseAccrued, house);
    }

    /// @inheritdoc IGameVault
    function withdrawHouseTo(uint256 amount, address to) external nonReentrant {
        if (msg.sender != house) revert NotHouse(msg.sender);
        if (to == address(0)) revert ZeroAddress();
        _withdrawHouse(amount, to);
    }

    function _withdrawHouse(uint256 amount, address to) private {
        if (amount == 0) revert ZeroAmount();
        uint128 accrued = _houseAccrued;
        if (amount > accrued) revert InsufficientFree(house, accrued, amount);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 amt = uint128(amount); // safe: amount <= accrued, a uint128
        _houseAccrued = accrued - amt;
        _totalLiabilities -= amt;
        emit HouseWithdrawn(to, amount);
        uint256 extra = _send(to, amount);
        if (extra != 0) {
            accrued = _houseAccrued;
            if (extra > accrued) revert TransferMismatch(amount, amount + extra);
            // forge-lint: disable-next-line(unsafe-typecast)
            uint128 tax = uint128(extra); // safe: extra <= accrued, a uint128
            _houseAccrued = accrued - tax;
            _totalLiabilities -= tax;
            // forge-lint: disable-next-line(reentrancy-events)
            emit TransferTaxPaid(house, extra);
        }
    }

    // =================================================================================================================
    // Owner: settings only
    // =================================================================================================================

    /// @inheritdoc IGameVault
    function setHouseFees(uint16 feeBps, uint16 holderFeeBps_) external onlyOwner {
        _setHouseFees(feeBps, holderFeeBps_);
    }

    /// @inheritdoc IGameVault
    function setCaps(uint128 maxStake_, uint128 maxBalance_) external onlyOwner {
        _setCaps(maxStake_, maxBalance_);
    }

    /// @inheritdoc IGameVault
    function setReferee(address referee_) external onlyOwner {
        _setReferee(referee_);
    }

    /// @inheritdoc IGameVault
    /// @dev The surplus is balanceOf(vault) - totalLiabilities, measured now: nothing the vault owes can be credited.
    function creditSurplus(address player, uint256 amount) external nonReentrant onlyOwner {
        if (player == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 bal = _token.balanceOf(address(this));
        uint256 liabilities = _totalLiabilities;
        uint256 surplus = bal > liabilities ? bal - liabilities : 0;
        if (amount > surplus) revert SurplusExceeded(surplus, amount);
        if (liabilities + amount > type(uint128).max) revert BalanceCapExceeded(player, type(uint128).max);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 amt = uint128(amount); // safe: liabilities + amount <= type(uint128).max
        _accounts[player].free += amt;
        _totalLiabilities += amt;
        emit SurplusCredited(player, amount);
    }

    /// The vault always keeps an owner: without one a pause could never end, a leaked referee key could never be
    /// rotated out and held series could never be reviewed. Ownership still moves with transferOwnership.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @inheritdoc IGameVault
    function pause() external onlyOwner {
        _pause();
    }

    /// @inheritdoc IGameVault
    function unpause() external onlyOwner {
        _unpause();
    }

    function _setHouseFees(uint16 feeBps, uint16 holderFeeBps_) private {
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh(feeBps);
        if (holderFeeBps_ > MAX_FEE_BPS) revert FeeTooHigh(holderFeeBps_);
        houseFeeBps = feeBps;
        holderFeeBps = holderFeeBps_;
        emit HouseFeesSet(feeBps, holderFeeBps_);
    }

    function _setCaps(uint128 maxStake_, uint128 maxBalance_) private {
        if (maxStake_ == 0 || maxBalance_ == 0) revert BadConfig();
        maxStake = maxStake_;
        maxBalance = maxBalance_;
        emit CapsSet(maxStake_, maxBalance_);
    }

    /// Starts a new referee epoch: matches locked from now on capture it, those already locked keep theirs.
    function _setReferee(address referee_) private {
        if (referee_ == address(0)) revert ZeroAddress();
        uint32 epoch = _refereeEpoch + 1;
        _refereeEpoch = epoch;
        _referees[epoch] = referee_;
        emit RefereeSet(referee_);
    }

    // =================================================================================================================
    // Views
    // =================================================================================================================

    /// @inheritdoc IGameVault
    function token() external view returns (address) {
        return address(_token);
    }

    /// @inheritdoc IGameVault
    function referee() external view returns (address) {
        return _referees[_refereeEpoch];
    }

    /// @inheritdoc IGameVault
    function refereeOf(bytes32 matchId) external view returns (address) {
        return _referees[_matches[matchId].refereeEpoch];
    }

    /// @inheritdoc IGameVault
    function freeOf(address player) external view returns (uint256) {
        return _accounts[player].free;
    }

    /// @inheritdoc IGameVault
    function lockedOf(address player) external view returns (uint256) {
        return _accounts[player].locked;
    }

    /// @inheritdoc IGameVault
    function houseAccrued() external view returns (uint256) {
        return _houseAccrued;
    }

    /// @inheritdoc IGameVault
    function totalLiabilities() external view returns (uint256) {
        return _totalLiabilities;
    }

    /// @inheritdoc IGameVault
    /// @dev A revoked session reads as all zeros; an expired one keeps its fields (valid while now < expiry).
    function sessionOf(address player) external view returns (Session memory) {
        SessionSlot storage s = _sessions[player];
        return Session({key: s.key, expiry: s.expiry, maxStake: s.maxStake, cap: s.cap, used: s.used});
    }

    /// @inheritdoc IGameVault
    function sessionNonce(address player) external view returns (uint64) {
        return _sessions[player].nonce;
    }

    /// @inheritdoc IGameVault
    function matchOf(bytes32 matchId) external view returns (Match memory) {
        MatchSlot storage m = _matches[matchId];
        uint64 lockedAt = m.lockedAt;
        return Match({
            playerA: m.playerA,
            feeBps: m.feeBps,
            holderFeeBps: m.holderFeeBps,
            roundSeconds: m.roundSeconds,
            state: m.state,
            playerB: m.playerB,
            lockedAt: lockedAt,
            stake: m.stake,
            settleBy: lockedAt == 0 ? 0 : lockedAt + settleWindow,
            rules: m.rules
        });
    }

    /// @inheritdoc IGameVault
    function hashSessionAuth(SessionAuth calldata auth) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SESSION_AUTH_TYPEHASH,
                    auth.player,
                    auth.sessionKey,
                    auth.maxStake,
                    auth.cap,
                    auth.expiry,
                    auth.nonce
                )
            )
        );
    }

    /// @inheritdoc IGameVault
    function hashEntry(Entry calldata e) public view returns (bytes32) {
        return _hashTypedDataV4(
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

    /// @inheritdoc IGameVault
    function hashResult(Result calldata r) public view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(abi.encode(RESULT_TYPEHASH, r.matchId, r.outcome, r.winner, r.feeBps, r.logHash))
            );
    }

    // =================================================================================================================
    // Internals
    // =================================================================================================================

    /// A wallet signature: ECDSA by `signer` itself (EOAs, including EIP-7702 accounts) or ERC-1271 by a contract.
    function _isValidSig(address signer, bytes32 digest, bytes calldata sig) private view returns (bool) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, sig);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) return true;
        return signer.code.length != 0 && SignatureChecker.isValidERC1271SignatureNowCalldata(signer, digest, sig);
    }

    /// The creator a match id belongs to: its first 20 bytes.
    function _creatorOf(bytes32 matchId) private pure returns (address) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(bytes20(matchId)); // the first 20 bytes, by design
    }

    function _min(uint16 x, uint16 y) private pure returns (uint16) {
        return x < y ? x : y;
    }

    function _nonzero(address a) private pure returns (address) {
        if (a == address(0)) revert ZeroAddress();
        return a;
    }
}
// forge-lint: disable-end(block-timestamp)
