// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity ^0.8.28;

// The SPIDER-TAG wager vault: the frozen interface every lane builds against (docs/WAGER.md §3).
//
// One vault per token (the token is fixed at deploy). Players deposit once, keep a balance in the vault and withdraw
// their free balance to their own wallet at any time, straight from this contract. A 1v1 best-of-3 match moves both
// equal stakes from free to locked when both players' EIP-712 Entries are submitted together (signed by a scoped
// session key, so there is no wallet popup per match), and the EIP-712 Result of the referee the match locked under pays
// the winner the pot minus the house fee (or refunds both on a void). Nobody - the owner, the referee, a relayer or the
// server - can move a player's free balance or block a withdrawal. Anyone may submit any of these calls (a house relayer
// pays the gas so play is gasless, but it has no role here). No upgrades, no admin withdrawal of player funds, no
// bankroll.

// ---- EIP-712 (domain: name "RadRun GameVault", version "1", chainId, verifyingContract = the vault) ------------------
// These strings are also in src/wager/eip712.ts; test/wager-shared.test.ts checks the TS copy against these hashes.

// Authorises a session key for a player; signed by the player's wallet (EOA or ERC-1271).
bytes32 constant SESSION_AUTH_TYPEHASH =
    keccak256("SessionAuth(address player,address sessionKey,uint128 maxStake,uint128 cap,uint64 expiry,uint64 nonce)");
// = 0xd1d5ccb7ccc0909f77f484701036251c5e6cabd5176750b6559b41c3ec12cb91

// One player's side of a match; signed by that player's session key (or wallet).
bytes32 constant ENTRY_TYPEHASH = keccak256(
    "Entry(bytes32 matchId,address player,address opponent,uint128 stake,uint16 feeCapBps,uint16 roundSeconds,bytes32 rules,uint64 deadline)"
);
// = 0x97ada63af3d17c4bc608f40b5c8c4c5372ae59704832fc8b489002f3876e462c

// The outcome of a locked match; signed by the referee (settle) or by both players' wallets (settleMutual).
bytes32 constant RESULT_TYPEHASH =
    keccak256("Result(bytes32 matchId,uint8 outcome,address winner,uint16 feeBps,bytes32 logHash)");
// = 0x0a893589f21454ee3400d410b77ab46b3ce91ef1ae45452b4bae84c112271b29

// Result.outcome values.
uint8 constant OUTCOME_WIN = 1;
uint8 constant OUTCOME_VOID = 2;

// MatchVoided.reason values.
uint8 constant VOID_REFEREE = 1;
uint8 constant VOID_MUTUAL = 2;
uint8 constant VOID_TIMEOUT = 3;

interface IGameVault {
    // ---- signed messages --------------------------------------------------------------------------------------

    struct SessionAuth {
        address player;
        /// The key allowed to sign Entries for `player` (a browser-held EOA). It can do nothing else.
        address sessionKey;
        /// Largest stake one Entry signed by this key may lock.
        uint128 maxStake;
        /// Total stake all Entries signed by this key may lock (gross, summed at lock time).
        uint128 cap;
        /// Unix seconds; at most MAX_SESSION_TTL after the block that opens it.
        uint64 expiry;
        /// Must equal sessionNonce(player); opening or revoking a session increments it.
        uint64 nonce;
    }

    struct Entry {
        /// The match creator's address (the first 20 bytes) followed by 12 random bytes the creator picks: only the
        /// creator can be playerA of it, and a match id is used once, ever (docs/WAGER.md §3.2).
        bytes32 matchId;
        /// The vault account entering (its free balance funds the stake).
        address player;
        /// The other player, or address(0) for "anyone" (an open offer or an invite link).
        address opponent;
        /// Token base units; both Entries must have the same stake.
        uint128 stake;
        /// The highest house fee this player accepts: lock reverts while the vault's house fee is above it.
        uint16 feeCapBps;
        /// Seconds per round; both Entries must match.
        uint16 roundSeconds;
        /// keccak256 of the canonical rules (game, district, best-of, tie-breaks, assists, sim id): src/wager/eip712.ts
        /// rulesHash(). Both Entries must match.
        bytes32 rules;
        /// Unix seconds: the lock must be mined at or before this time.
        uint64 deadline;
    }

    struct Result {
        bytes32 matchId;
        /// OUTCOME_WIN or OUTCOME_VOID.
        uint8 outcome;
        /// The winner (one of the two players) on a win; address(0) on a void.
        address winner;
        /// On a win: the match's feeBps, or its holderFeeBps (Radbro-holder winner; referee only). 0 on a void.
        uint16 feeBps;
        /// keccak256 commitment to the series' recorded input log (docs/WAGER.md §5.4); anyone can replay it.
        bytes32 logHash;
    }

    // ---- stored state (views) -----------------------------------------------------------------------------------

    enum MatchState {
        None,
        Locked,
        Settled,
        Voided,
        /// The creator cancelled the id before any lock: it can never lock.
        Cancelled
    }

    struct Session {
        address key;
        uint64 expiry;
        uint128 maxStake;
        uint128 cap;
        uint128 used;
    }

    struct Match {
        address playerA;
        uint16 feeBps;
        uint16 holderFeeBps;
        uint16 roundSeconds;
        MatchState state;
        address playerB;
        uint64 lockedAt;
        uint128 stake;
        uint64 settleBy;
        bytes32 rules;
    }

    // ---- events ---------------------------------------------------------------------------------------------------

    event Deposited(address indexed player, address indexed from, uint256 amount);
    event Withdrawn(address indexed player, address indexed to, uint256 amount);
    event SessionOpened(
        address indexed player, address indexed sessionKey, uint128 maxStake, uint128 cap, uint64 expiry, uint64 nonce
    );
    event SessionRevoked(address indexed player, uint64 nonce);
    event MatchLocked(
        bytes32 indexed matchId,
        address indexed playerA,
        address indexed playerB,
        uint128 stake,
        uint16 feeBps,
        uint16 holderFeeBps,
        uint16 roundSeconds,
        bytes32 rules,
        uint64 settleBy
    );
    event MatchSettled(
        bytes32 indexed matchId,
        address indexed winner,
        address indexed loser,
        uint256 payout,
        uint256 fee,
        uint16 feeBps,
        bytes32 logHash,
        bool mutual
    );
    event MatchVoided(
        bytes32 indexed matchId, address indexed playerA, address indexed playerB, uint8 reason, bytes32 logHash
    );
    /// `house` is where the fees went: the house address (withdrawHouse), or where the house sent them (withdrawHouseTo).
    event HouseWithdrawn(address indexed house, uint256 amount);
    /// The creator of `matchId` cancelled it before it locked.
    event MatchCancelled(bytes32 indexed matchId, address indexed player);
    /// After settleBy, `player` took their own stake back out of a match nobody closed (the event names only them).
    event StakeReclaimed(bytes32 indexed matchId, address indexed player, uint256 stake);
    /// A payout cost the vault more than the amount paid (a transfer tax charged to the sender): the difference came out
    /// of `account`'s own balance (a player's free balance, or the house fees for the house).
    event TransferTaxPaid(address indexed account, uint256 amount);
    /// The owner credited tokens the vault held beyond what it owes (sent to it directly, or a rebase) to `player`.
    event SurplusCredited(address indexed player, uint256 amount);
    event HouseFeesSet(uint16 feeBps, uint16 holderFeeBps);
    event CapsSet(uint128 maxStake, uint128 maxBalance);
    event RefereeSet(address indexed referee);

    // ---- errors ---------------------------------------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    /// A deposit added a different amount than asked (fee-on-transfer, rebasing or hooked token): rejected. Or a
    /// payout of `expected` took `received` from the vault and the payer's balance can't cover the difference.
    error TransferMismatch(uint256 expected, uint256 received);
    error BalanceCapExceeded(address player, uint256 cap);
    error InsufficientFree(address player, uint256 free, uint256 needed);
    error BadSignature(address expectedSigner);
    error BadNonce(uint64 expected, uint64 got);
    error BadSession();
    error SessionLimit(address player);
    error MatchExists(bytes32 matchId);
    error EntryMismatch();
    error EntryExpired(address player, uint64 deadline);
    error StakeOutOfRange(uint256 stake, uint256 maxStake);
    error FeeTooHigh(uint16 feeBps);
    error NotLocked(bytes32 matchId);
    error SettleWindowClosed(bytes32 matchId, uint64 settleBy);
    error SettleWindowOpen(bytes32 matchId, uint64 settleBy);
    error BadResult();
    error Insolvent(uint256 balance, uint256 liabilities);
    error BadConfig();
    /// The match id doesn't start with playerA's address (lock), or the caller didn't create it (cancel).
    error BadMatchId(bytes32 matchId);
    /// The vault's house fee is above the fee cap `player` signed.
    error FeeAboveCap(address player, uint16 feeBps, uint16 feeCapBps);
    error NotHouse(address caller);
    /// `caller` is not a player of the match, or already took their stake back.
    error NothingToReclaim(bytes32 matchId, address caller);
    error SurplusExceeded(uint256 surplus, uint256 amount);
    /// The vault always keeps an owner (pause, referee rotation and reviews need one).
    error RenounceDisabled();

    // ---- player funds (never paused) --------------------------------------------------------------------------------

    /// Pull `amount` from msg.sender (approve exactly this first) and credit msg.sender's free balance. Reverts
    /// TransferMismatch unless the vault's token balance grew by exactly `amount`. Paused: reverts.
    function deposit(uint256 amount) external;

    /// As deposit, crediting `player` (pulls from msg.sender). Paused: reverts.
    function depositFor(address player, uint256 amount) external;

    /// Send `amount` of msg.sender's free balance to msg.sender. Never paused, no owner or referee involvement. If the
    /// token charges the vault more than `amount` for the transfer (a sender-side tax), the difference also comes out of
    /// msg.sender's free balance (TransferMismatch if it can't): withdraw a little less than everything then. If the
    /// vault's balance falls by less (a reflection), the difference stays in the vault as surplus.
    function withdraw(uint256 amount) external;

    /// As withdraw, to another address of the caller's choosing (e.g. when the token blocks the caller's own address).
    function withdrawTo(uint256 amount, address to) external;

    // ---- session keys -------------------------------------------------------------------------------------------

    /// Store auth.sessionKey as auth.player's session key (replacing any previous one) after checking walletSig is
    /// auth.player's signature (ECDSA or ERC-1271) over the SessionAuth, auth.nonce == sessionNonce(player),
    /// maxStake <= cap and block.timestamp < expiry <= block.timestamp + MAX_SESSION_TTL. Increments the nonce.
    /// Anyone may submit (the relayer does, so it costs the player no gas). Paused: reverts.
    function openSession(SessionAuth calldata auth, bytes calldata walletSig) external;

    /// Delete msg.sender's session key and increment its nonce (unused SessionAuth signatures die too).
    function revokeSession() external;

    // ---- matches ----------------------------------------------------------------------------------------------------

    /// Lock both stakes. Checks: same matchId, which starts with a.player's address and was never used or cancelled,
    /// different nonzero players, each opponent is 0 or the other player, equal nonzero stake <= maxStake, both fee
    /// caps >= houseFeeBps, equal roundSeconds and rules, both deadlines >= now, each signature is the player's live
    /// session key (stake <= session maxStake, used + stake <= cap; used += stake) or the player's wallet, both free
    /// balances >= stake, the vault is solvent. Captures feeBps = houseFeeBps, holderFeeBps = min(holderFeeBps, feeBps),
    /// the current referee and settleBy = now + settleWindow. Entry `a` (the creator) becomes playerA. Anyone may
    /// submit. Paused: reverts.
    function lock(Entry calldata a, bytes calldata sigA, Entry calldata b, bytes calldata sigB) external;

    /// Mark msg.sender's own unused match id (one that starts with msg.sender's address) as cancelled: no Entry for it
    /// can ever lock. Never paused.
    function cancel(bytes32 matchId) external;

    /// Apply a Result signed by the match's referee (the one captured at lock: refereeOf) to a Locked match, at or
    /// before settleBy. Win: winner is playerA or playerB and feeBps is the captured feeBps or holderFeeBps;
    /// pot = 2 * stake, fee = pot * feeBps / 10_000 (rounded down), the winner's free balance += pot - fee, the house
    /// balance += fee. Void: winner 0 and feeBps 0; both stakes go back to free. Anyone may submit. Never paused.
    function settle(Result calldata r, bytes calldata refereeSig) external;

    /// As settle, signed by BOTH players' wallets (ECDSA or ERC-1271; session keys are not accepted here). A win
    /// must use the captured feeBps (no holder discount). Never paused.
    function settleMutual(Result calldata r, bytes calldata sigA, bytes calldata sigB) external;

    /// After settleBy, anyone may void a still-Locked match: both stakes (those not reclaimed yet) go back to free.
    /// Never paused.
    function refundExpired(bytes32 matchId) external;

    /// After settleBy, a player of a still-Locked match takes their own stake back to free. The transaction and its
    /// event name only msg.sender, so it works even when the chain refuses transactions that involve the other player.
    /// The match stays Locked until the other stake is released too (Voided once both are). Never paused.
    function reclaim(bytes32 matchId) external;

    // ---- house ------------------------------------------------------------------------------------------------------

    /// Send every accrued house fee to the immutable house address. Anyone may call. Never paused. A sender-side tax
    /// on the transfer comes out of the house fees (so this reverts under one: the house uses withdrawHouseTo).
    function withdrawHouse() external;

    /// The house only: send `amount` of the accrued fees to `to` (part of them when the token limits transfer sizes or
    /// taxes the sender, elsewhere when the token blocks the house address). Never paused.
    function withdrawHouseTo(uint256 amount, address to) external;

    // ---- owner (Ownable2Step): settings only, never player funds ---------------------------------------------------

    /// New house fee and Radbro-holder fee (each <= MAX_FEE_BPS; 0 allowed). Only later locks capture them.
    function setHouseFees(uint16 feeBps, uint16 holderFeeBps) external;

    /// Beta caps: largest stake per match, largest free + locked balance a deposit may reach (both nonzero; use
    /// type(uint128).max for no cap). Winnings may exceed maxBalance.
    function setCaps(uint128 maxStake, uint128 maxBalance) external;

    /// Rotate the referee for matches locked from now on. A Locked match is only ever settled by the referee it locked
    /// under (refereeOf), so the owner can't decide a live match and Results already signed stay valid.
    function setReferee(address referee) external;

    /// Credit `amount` of the tokens the vault holds beyond totalLiabilities (tokens sent straight to the vault, a
    /// rebase or reflection) to `player`'s free balance. It can never touch what the vault owes.
    function creditSurplus(address player, uint256 amount) external;

    /// Stop deposits, openSession and lock. Withdrawals, settles, refunds and house withdrawals stay open.
    function pause() external;

    function unpause() external;

    // ---- views ------------------------------------------------------------------------------------------------------

    function MAX_FEE_BPS() external view returns (uint16); // 500
    function MAX_SESSION_TTL() external view returns (uint64); // 30 days

    function token() external view returns (address);
    function house() external view returns (address);
    /// The referee new locks capture.
    function referee() external view returns (address);
    /// The referee a match locked under (the only one whose Result it takes); address(0) if it never locked.
    function refereeOf(bytes32 matchId) external view returns (address);
    function houseFeeBps() external view returns (uint16);
    function holderFeeBps() external view returns (uint16);
    function maxStake() external view returns (uint128);
    function maxBalance() external view returns (uint128);
    /// Seconds from lock to settleBy (immutable, 1 hour to 7 days).
    function settleWindow() external view returns (uint32);

    function freeOf(address player) external view returns (uint256);
    function lockedOf(address player) external view returns (uint256);
    function houseAccrued() external view returns (uint256);
    /// Sum of every free and locked balance plus houseAccrued; token.balanceOf(vault) >= this always.
    function totalLiabilities() external view returns (uint256);

    function sessionOf(address player) external view returns (Session memory);
    function sessionNonce(address player) external view returns (uint64);
    function matchOf(bytes32 matchId) external view returns (Match memory);

    /// EIP-712 digests (for clients, the relay and tests).
    function hashSessionAuth(SessionAuth calldata auth) external view returns (bytes32);
    function hashEntry(Entry calldata e) external view returns (bytes32);
    function hashResult(Result calldata r) external view returns (bytes32);
}
