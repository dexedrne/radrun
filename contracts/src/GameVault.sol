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
/// key (or their wallet), and withdraw their free balance to any address at any time. A referee-signed Result pays the
/// winner the pot minus the house fee, or refunds both. The owner changes settings only: it can never move, freeze or
/// block a player's balance, and there is no proxy, upgrade path, sweep or admin withdrawal.
/// @dev Accounting: `totalLiabilities == Σfree + Σlocked + houseAccrued <= token.balanceOf(this)`. Only deposits and
/// withdrawals (players' and the house's) change `totalLiabilities`; lock, settle and void move value between buckets
/// and never call the token, so a token that blocks an address can never block a settle or a refund.
/// Every amount fits in 128 bits: a deposit may not take `totalLiabilities` above `type(uint128).max`, and every
/// bucket is bounded by it, so no settle or refund can overflow.
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

    IERC20 internal immutable _token;
    /// Receives the house fees (through withdrawHouse, which anyone may call). Fixed at deploy.
    address public immutable house;
    /// Seconds from a lock to its settleBy.
    uint32 public immutable settleWindow;

    // ---- settings (owner) ---------------------------------------------------------------------------------------
    // Packed so a lock reads one settings slot: the stake cap and both fees.
    uint128 public maxStake;
    uint16 public houseFeeBps;
    uint16 public holderFeeBps;
    address public referee;
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

    mapping(address player => Account) internal _accounts;
    mapping(address player => SessionSlot) internal _sessions;
    mapping(bytes32 matchId => Match) internal _matches;

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
        _send(to, amount);
    }

    /// Pays out and requires the vault's balance to fall by exactly `amount`: a token that takes more than that from
    /// the vault would otherwise leave it owing more than it holds.
    function _send(address to, uint256 amount) private {
        uint256 before = _token.balanceOf(address(this));
        _token.safeTransfer(to, amount);
        uint256 afterBal = _token.balanceOf(address(this));
        uint256 sent = before > afterBal ? before - afterBal : 0;
        if (sent != amount) revert TransferMismatch(amount, sent);
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
        (address pa, address pb, uint128 stake) = _checkTerms(a, b);
        _checkEntry(a, sigA);
        _checkEntry(b, sigB);
        _lockStake(pa, stake);
        _lockStake(pb, stake);

        // A token whose balance fell under what the vault owes (negative rebase, a hook) stops new matches.
        uint256 bal = _token.balanceOf(address(this));
        uint256 liabilities = _totalLiabilities;
        if (bal < liabilities) revert Insolvent(bal, liabilities);

        _record(a, pb, _min(a.feeCapBps, b.feeCapBps));
    }

    /// The pairing checks of lock, in the spec's order (docs/WAGER.md §3.2, steps 2-7).
    function _checkTerms(Entry calldata a, Entry calldata b)
        private
        view
        returns (address pa, address pb, uint128 stake)
    {
        bytes32 matchId = a.matchId;
        if (b.matchId != matchId) revert EntryMismatch();
        if (_matches[matchId].state != MatchState.None) revert MatchExists(matchId);
        pa = a.player;
        pb = b.player;
        if (pa == address(0) || pb == address(0)) revert ZeroAddress();
        if (pa == pb) revert EntryMismatch();
        if ((a.opponent != address(0) && a.opponent != pb) || (b.opponent != address(0) && b.opponent != pa)) {
            revert EntryMismatch();
        }
        stake = a.stake;
        if (b.stake != stake) revert EntryMismatch();
        uint128 maxStake_ = maxStake;
        if (stake == 0 || stake > maxStake_) revert StakeOutOfRange(stake, maxStake_);
        if (a.roundSeconds != b.roundSeconds || a.rules != b.rules) revert EntryMismatch();
        if (block.timestamp > a.deadline) revert EntryExpired(pa, a.deadline);
        if (block.timestamp > b.deadline) revert EntryExpired(pb, b.deadline);
    }

    /// Stores the match with its captured fees: min(house fee, both players' caps), and the holder fee under that.
    function _record(Entry calldata a, address pb, uint16 feeCapBps) private {
        uint16 feeBps = _min(houseFeeBps, feeCapBps);
        uint16 holderFee = _min(holderFeeBps, feeBps);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 lockedAt = uint64(block.timestamp); // safe: unix seconds fit 64 bits
        uint64 settleBy = lockedAt + settleWindow;
        _matches[a.matchId] = Match({
            playerA: a.player,
            feeBps: feeBps,
            holderFeeBps: holderFee,
            roundSeconds: a.roundSeconds,
            state: MatchState.Locked,
            playerB: pb,
            lockedAt: lockedAt,
            stake: a.stake,
            settleBy: settleBy,
            rules: a.rules
        });
        // Only staticcalls (ERC-1271, balanceOf) come before this log.
        // forge-lint: disable-next-line(reentrancy-events)
        emit MatchLocked(a.matchId, a.player, pb, a.stake, feeBps, holderFee, a.roundSeconds, a.rules, settleBy);
    }

    /// Accepts an Entry signed by the player's wallet (ECDSA, or ERC-1271 for a contract wallet) or by the player's
    /// live session key within its limits (which it then spends).
    function _checkEntry(Entry calldata e, bytes calldata sig) private {
        address player = e.player;
        bytes32 digest = hashEntry(e);
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, sig);
        if (err == ECDSA.RecoverError.NoError) {
            if (signer == player) return;
            SessionSlot storage s = _sessions[player];
            if (signer == s.key) {
                uint256 used = uint256(s.used) + e.stake;
                if (block.timestamp >= s.expiry || e.stake > s.maxStake || used > s.cap) revert SessionLimit(player);
                // forge-lint: disable-next-line(unsafe-typecast)
                s.used = uint128(used); // safe: used <= cap, a uint128
                return;
            }
        }
        if (player.code.length != 0 && SignatureChecker.isValidERC1271SignatureNowCalldata(player, digest, sig)) {
            return;
        }
        revert BadSignature(player);
    }

    function _lockStake(address player, uint128 stake) private {
        Account memory acct = _accounts[player];
        if (acct.free < stake) revert InsufficientFree(player, acct.free, stake);
        _accounts[player] = Account({free: acct.free - stake, locked: acct.locked + stake});
    }

    /// @inheritdoc IGameVault
    function settle(Result calldata r, bytes calldata refereeSig) external {
        Match storage m = _settleable(r.matchId);
        address referee_ = referee;
        if (!_isValidSig(referee_, hashResult(r), refereeSig)) revert BadSignature(referee_);
        _apply(m, r, false);
    }

    /// @inheritdoc IGameVault
    function settleMutual(Result calldata r, bytes calldata sigA, bytes calldata sigB) external {
        Match storage m = _settleable(r.matchId);
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
        Match storage m = _matches[matchId];
        if (m.state != MatchState.Locked) revert NotLocked(matchId);
        uint64 settleBy = m.settleBy;
        if (block.timestamp <= settleBy) revert SettleWindowOpen(matchId, settleBy);
        _void(m, matchId, VOID_TIMEOUT, bytes32(0));
    }

    function _settleable(bytes32 matchId) private view returns (Match storage m) {
        m = _matches[matchId];
        if (m.state != MatchState.Locked) revert NotLocked(matchId);
        uint64 settleBy = m.settleBy;
        if (block.timestamp > settleBy) revert SettleWindowClosed(matchId, settleBy);
    }

    /// Applies a checked Result. Internal credits only: nothing here calls the token.
    function _apply(Match storage m, Result calldata r, bool mutual) private {
        if (r.outcome == OUTCOME_WIN) {
            _win(m, r, mutual);
        } else if (r.outcome == OUTCOME_VOID) {
            if (r.winner != address(0) || r.feeBps != 0) revert BadResult();
            _void(m, r.matchId, mutual ? VOID_MUTUAL : VOID_REFEREE, r.logHash);
        } else {
            revert BadResult();
        }
    }

    function _win(Match storage m, Result calldata r, bool mutual) private {
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

    function _void(Match storage m, bytes32 matchId, uint8 reason, bytes32 logHash) private {
        m.state = MatchState.Voided;
        uint128 stake = m.stake;
        address pa = m.playerA;
        address pb = m.playerB;
        _release(pa, stake);
        _release(pb, stake);
        // Only staticcalls (ERC-1271, balanceOf) come before this log.
        // forge-lint: disable-next-line(reentrancy-events)
        emit MatchVoided(matchId, pa, pb, reason, logHash);
    }

    function _release(address player, uint128 stake) private {
        Account memory acct = _accounts[player];
        _accounts[player] = Account({free: acct.free + stake, locked: acct.locked - stake});
    }

    // =================================================================================================================
    // House
    // =================================================================================================================

    /// @inheritdoc IGameVault
    function withdrawHouse() external nonReentrant {
        uint128 amount = _houseAccrued;
        if (amount == 0) revert ZeroAmount();
        _houseAccrued = 0;
        _totalLiabilities -= amount;
        emit HouseWithdrawn(house, amount);
        _send(house, amount);
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

    function _setReferee(address referee_) private {
        if (referee_ == address(0)) revert ZeroAddress();
        referee = referee_;
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
        return _matches[matchId];
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

    function _min(uint16 x, uint16 y) private pure returns (uint16) {
        return x < y ? x : y;
    }

    function _nonzero(address a) private pure returns (address) {
        if (a == address(0)) revert ZeroAddress();
        return a;
    }
}
// forge-lint: disable-end(block-timestamp)
