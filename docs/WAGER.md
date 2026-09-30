# SPIDER-TAG wager (beta): technical spec

Two players put up equal stakes of a token, play a 1v1 SPIDER-TAG series (best 2 of 3), and the winner takes the pot
minus a small house fee. This file is the shared spec for the contracts, the wager relay and the client. The frozen
interfaces it describes are in the repo:

| Interface | File |
|---|---|
| Vault ABI, EIP-712 typehashes, events, errors | `contracts/src/interfaces/IGameVault.sol` |
| EIP-712 domains/types, JSON shapes, rules hash, fee maths | `src/wager/eip712.ts` |
| Series log, log hash, seeds, series score | `src/wager/log.ts` |
| Canonical round construction and authoritative replay | `src/wager/replay.ts` |
| Relay routes, socket messages, timing, limits | `src/wager/protocol.ts` |
| Deployments and every env/config name | `src/wager/config.ts`, `src/wager/deployments.json` |
| Checks tying them together | `test/wager-shared.test.ts` |

**Status:** beta on the Robinhood Chain testnet with a test token only. The page is the unlisted link
`https://radrun.vyvanse.beer/?wager` (nothing on the site links to it) and always shows **BETA · TESTNET**. Anyone with
the link can play: an open lobby plus direct invite links. The real token and Robinhood Chain mainnet come later as a
configuration change (§8, §11). The live SPIDER-TAG online mode and its relay (`radrun-relay`) are not touched by any of
this.

---

## 1. How it works

1. **Deposit once.** The player connects a browser wallet, approves the vault for exactly the amount, and deposits.
   The balance lives in the vault contract under the player's address.
2. **Authorise a session key (one wallet signature).** The page makes a key in the browser and the wallet signs a
   `SessionAuth` for it: the largest stake per match, a total cap, an expiry (at most 30 days). A relayer submits it,
   so it costs the player no gas. From then on, entering a match needs no wallet popup. The session key can do one
   thing: sign match Entries within those limits. It can never withdraw or send funds anywhere.
3. **Create or join a match.** The creator's session key signs an `Entry` (match id, stake, fee cap, round length,
   rules, opponent or "anyone", deadline). It appears in the open lobby, or only behind its invite link. A joiner signs
   the matching Entry. The relayer submits `lock(entryA, sigA, entryB, sigB)`, and the vault moves both stakes from
   free to locked.
4. **Play the series.** Best of 3 SPIDER-TAG rounds (90 s by default) through the wager relay, on the existing online
   netcode. The referee re-simulates every round from the relay-recorded inputs with the canonical sim, and that
   replay decides the winner, not the clients.
5. **Settle.** The referee signs a `Result` (winner, fee, hash of the input log). Anyone can submit it (the relayer
   does). The vault credits the winner `2 x stake - fee` and the house the fee. The whole input log is public, so
   anyone can replay the series and get the same winner (`?wager&verify=<matchId>`).
6. **Withdraw any time.** Free balance goes from the contract straight to the player's wallet. No server, owner or
   referee is involved, and pausing never blocks it.

Safety valves:
- A series nobody settles refunds itself: after `settleBy` (lock + 24 h), anyone can call `refundExpired`.
- Two players can settle between themselves with both wallets' signatures (`settleMutual`) if the referee is gone.
- Every transaction the relayer sends can also be sent by the player.

---

## 2. Architecture and trust

```
 browser (?wager chunk)                       wager relay (Cloudflare Worker "radrun-wager-relay")
 ├─ wallet (EIP-6963)  ── deposit/withdraw ──▶ GameVault on Robinhood Chain ◀── relayer tx: openSession / lock / settle
 ├─ session key ── signs Entry / Login ─────▶ WagerLobby DO (singleton): login, offers, pairing, records, relayer queue
 ├─ lobby socket  /lobby ───────────────────▶      │ internal: init room, settle, record
 └─ room socket   /ws?room=<matchId> ───────▶ WagerRoom DO (one per match): inputs, deadlines, series, referee, log
                                                   │ Radbro reads (public RPC, no keys)
                                                   └──────────────▶ Ethereum mainnet: Radbro V2 / V1
```

**Keys, and exactly what each can do**

| Key | Where it lives | Can | Cannot |
|---|---|---|---|
| Player wallet | the player's wallet | deposit, withdraw, authorise/revoke session keys, sign Entries directly, sign mutual settles | - |
| Session key | the player's browser (local storage) | sign Entries up to `maxStake` each and `cap` in total until `expiry`; log in to the relay | withdraw, move free balance anywhere except into a match with an opponent's matching Entry, sign Results |
| Referee | Worker secret `REFEREE_KEY` | sign a Result for a **Locked** match: which of its two players won (fee = the match's captured fee or holder fee), or void | touch free balances, lock anyone, pay anyone but the two players, raise a fee, act after `settleBy` |
| Relayer | Worker secret `RELAYER_KEY` | pay gas for `openSession`, `lock`, `settle` | anything a random address cannot: it has no role in the contract |
| Vault owner | the house's own wallet (Ownable2Step) | set house/holder fees (≤ 5%), beta caps, rotate the referee, pause new deposits/sessions/locks | move or freeze player balances, block withdrawals, change a locked match, upgrade the contract |
| House | an address fixed at deploy | receive accrued fees (`withdrawHouse`, callable by anyone) | anything else |
| Faucet (test networks only) | Worker secret `FAUCET_KEY` | send test tokens and a little test ETH | exist on a mainnet deployment |

There is **no server-held treasury key**: the relay never holds player funds, and the vault has no admin withdrawal
path. The worst a stolen hot key can do:
- **Referee:** mis-declare the winner of matches that are live at that moment. This is bounded by the per-match stake
  cap, and it is publicly provable afterwards, because every Result commits to the published input log.
- **Relayer:** burn its own gas ETH.
- **Session key:** enter its player into matches up to `cap`. A player who never connects is refunded (no-show is a
  void, §4.4), so a stolen key cannot farm forfeits.

---

## 3. Contracts (`contracts/`, Solidity 0.8.x, Foundry, OpenZeppelin 5.6.1)

### 3.1 Files

| File | What |
|---|---|
| `contracts/foundry.toml` | solc 0.8.37, `evm_version = "prague"`, optimizer 200. Remaps OpenZeppelin to `../node_modules` (pinned in package.json) and forge-std to `lib/` |
| `contracts/src/interfaces/IGameVault.sol` | **Frozen:** structs, events, errors, function signatures, EIP-712 typehash constants |
| `contracts/src/GameVault.sol` | `contract GameVault is IGameVault, EIP712("RadRun GameVault", "1"), Ownable2Step, Pausable, ReentrancyGuard` |
| `contracts/src/TestSpiderTag.sol` | The test token (§3.8) |
| `contracts/test/**` | Unit, fuzz and invariant tests, plus quirk-token mocks (§9.1) |
| `contracts/script/**` | Deploy scripts driven by `tools/wager-deploy.ts` |

Constructor:
```solidity
constructor(IERC20Metadata token, address house, address referee, address owner,
            uint16 houseFeeBps, uint16 holderFeeBps, uint128 maxStake, uint128 maxBalance, uint32 settleWindow)
```
- Nonzero addresses. Both fees ≤ 500.
- `maxStake` and `maxBalance` are nonzero (use `type(uint128).max` for "no cap").
- `settleWindow` is 1 hour to 7 days (beta default 24 h).
- The token must have code and `decimals()`.
- There is one vault per token: the token and the house are immutable. No proxy, no upgrade path.

### 3.2 Behaviour

The frozen signatures and NatSpec are in `IGameVault.sol`. The essentials:

- **Accounting.** `free[player]`, `locked[player]`, `houseAccrued`, `totalLiabilities`.
  - Invariant: `totalLiabilities == Σfree + Σlocked + houseAccrued ≤ token.balanceOf(vault)`.
  - Lock, settle and void move value between buckets; only deposits and withdrawals change `totalLiabilities`.
- **`deposit` / `depositFor`.** Records the vault's balance, runs `safeTransferFrom(msg.sender, vault, amount)`, then
  requires the balance to have grown by **exactly** `amount`, or reverts `TransferMismatch`.
  - A deposit may not take `free + locked` above `maxBalance` (winnings may).
  - Paused: reverts.
- **`withdraw(amount)` / `withdrawTo(amount, to)`.** Only the caller's own free balance: `free -= amount`, then
  `safeTransfer`. Never paused, no other party involved.
  - `withdrawTo` lets a player whose own address the token blocks send to another address.
- **`openSession(auth, walletSig)`.**
  - Checks:
    - `walletSig` is valid for `auth.player` (OpenZeppelin `SignatureChecker`: ECDSA or ERC-1271).
    - `auth.nonce == sessionNonce[player]`.
    - `0 < maxStake ≤ cap`.
    - `now < expiry ≤ now + MAX_SESSION_TTL` (30 days).
    - `sessionKey != 0`.
  - Stores `Session{key, expiry, maxStake, cap, used: 0}`, replacing any previous session, and increments the nonce.
  - Paused: reverts.
- **`revokeSession()`.** Deletes the caller's session and increments the nonce.
- **`lock(a, sigA, b, sigB)`.** The checks, in order:
  1. The vault is not paused.
  2. `a.matchId == b.matchId` and the match is `None`.
  3. The players are distinct and nonzero.
  4. `a.opponent ∈ {0, b.player}` and `b.opponent ∈ {0, a.player}`.
  5. `a.stake == b.stake` and `0 < stake ≤ maxStake`.
  6. `roundSeconds` and `rules` are equal.
  7. `now ≤` both deadlines.
  8. Each signature is valid (below).
  9. Both free balances are ≥ stake.
  10. `token.balanceOf(vault) ≥ totalLiabilities` (otherwise `Insolvent`).

  Checking an Entry signature:
  - First try ECDSA recovery.
  - If the signer is the player's session key, the session must not be expired, `stake ≤ maxStake` and
    `used + stake ≤ cap`; then `used += stake`.
  - Otherwise `SignatureChecker.isValidSignatureNow(player, digest, sig)` must hold (the wallet signed it itself).
  - Otherwise revert `BadSignature(player)`.

  Effects:
  - Both stakes move from free to locked.
  - The match stores `playerA = a.player`, `playerB = b.player`, `feeBps = min(houseFeeBps, a.feeCapBps, b.feeCapBps)`,
    `holderFeeBps = min(holderFeeBps, feeBps)`, `lockedAt = now` and `settleBy = now + settleWindow`.
  - Emits `MatchLocked`.
- **`settle(r, refereeSig)`.**
  - Checks: the match is `Locked`, `now ≤ settleBy`, and the signer of `hashResult(r)` is `referee`.
  - Win (`outcome == 1`): `winner ∈ {playerA, playerB}` and `feeBps ∈ {m.feeBps, m.holderFeeBps}`.
  - Void (`outcome == 2`): `winner == 0` and `feeBps == 0`.
  - Anything else reverts `BadResult`.
  - Emits `MatchSettled` (win) or `MatchVoided(reason 1)` (void).
- **`settleMutual(r, sigA, sigB)`.** As `settle`, but checked against both players' wallets (`SignatureChecker`;
  session keys are not accepted). A win must use `m.feeBps`: the players can't award themselves the holder discount.
  Void reason 2.
- **`refundExpired(matchId)`.** A `Locked` match with `now > settleBy`: both stakes go back to free. Void reason 3.
  Anyone may call it; it is never paused.
- **`withdrawHouse()`.** Sends `houseAccrued` to `house`, zeroes it and lowers `totalLiabilities`. Anyone may call it.
- **Owner only:** `setHouseFees(fee, holderFee)` (each ≤ 500), `setCaps(maxStake, maxBalance)` (nonzero),
  `setReferee(addr)` (nonzero), `pause()` / `unpause()`.
- **Time.** Every deadline uses `block.timestamp`. Never use `block.number`: on Robinhood Chain (Arbitrum Nitro) it is
  the parent chain's block number.
- **Randomness.** None on-chain (`prevrandao` is constant there). Match seeds are a commit-reveal (§5.5).
- **Reentrancy.** `nonReentrant` on everything that calls the token. Checks, then effects, then the transfer.

### 3.3 EIP-712

Vault domain: `{name: "RadRun GameVault", version: "1", chainId, verifyingContract: vault}`. The relay uses a second
domain name, `"RadRun Wager Relay"`, so its messages can never be valid vault messages.

```
SessionAuth(address player,address sessionKey,uint128 maxStake,uint128 cap,uint64 expiry,uint64 nonce)   0xd1d5ccb7…cb91
Entry(bytes32 matchId,address player,address opponent,uint128 stake,uint16 feeCapBps,uint16 roundSeconds,bytes32 rules,uint64 deadline)   0x97ada63a…462c
Result(bytes32 matchId,uint8 outcome,address winner,uint16 feeBps,bytes32 logHash)   0x0a893589…1b29
-- relay domain --
Login(address player,bytes32 challenge,uint64 expiry,string relay)   0x5c1bcfbd…d4aa
Review(bytes32 matchId,uint8 decision,bytes32 logHash)   0xda36c9b7…e59a
```

Full hashes are in `eip712.ts` `TYPEHASHES`, and the test checks them against the Solidity strings.

**Why nothing can be replayed:**
- The domain binds the chain id and the vault address.
- An Entry is consumed with its `matchId` (a match locks once, ever).
- A Result applies only to a `Locked` match and moves it out of `Locked`.
- A SessionAuth carries the player's nonce.
- A Login carries a single-use relay challenge, its expiry and the relay's URL.

`rules = rulesHash(makeRules(district, simCompat))` is the keccak256 of
`abi.encode("radrun-spidertag", 1, district, 3 /*bestOf*/, 2 /*tie-breaks*/, 0 /*no assists*/, simId)`.
- Two Entries only pair when they agree on the district and on the exact sim (§5.2).
- The round length and the stake are Entry fields of their own.

### 3.4 Session keys

- **Defaults set by the client:**
  - `maxStake` = what the player picks, at most the vault's `maxStake`.
  - `cap` = 10 × maxStake.
  - `expiry` = 3 days.
- **Revoking:**
  - `revokeSession` costs one transaction.
  - Withdrawing the free balance also takes it out of any session key's reach.
- **Losing the key:** when the browser key is lost, the player authorises a new one, which replaces the old one.

### 3.5 Fees and payout

- **Captured at lock:**
  - `feeBps = min(houseFeeBps, capA, capB)`.
  - `holderFeeBps = min(holderFeeBps, feeBps)`.
  - Defaults: 300 (3%) and 150 (1.5%). The hard cap is 500. 0 is allowed.
- **On a win:**
  - `pot = 2 × stake`.
  - `fee = pot × feeBps / 10 000`, **rounded down**.
  - The winner gets `pot − fee` (the rounding dust goes to the winner) and the house gets `fee`.
- **Example:** stakes of 100 give a pot of 200, so the winner +194 and the house +6. A Radbro-holder winner gets
  +197 and the house +3.
- **Holder discount:**
  - The referee picks `m.holderFeeBps` when the **winner** holds a Radbro at settle time (§4.6), and `m.feeBps`
    otherwise.
  - The contract accepts only those two captured values, so the discount can never raise a fee above what both
    players signed.
- **Void:** each player gets their stake back, with no fee.

### 3.6 Token policy (the vault works with any standard ERC-20 given by address)

| Token behaviour | Handling |
|---|---|
| Plain ERC-20 (launchpad tokens such as pons tokens on Robinhood Chain: fixed supply, 18 decimals, no owner, tax, blacklist or pause; they move freely before and after graduation) | Works as is |
| Fee-on-transfer / taxed transfers | **Rejected.** A deposit that doesn't add exactly `amount` reverts `TransferMismatch`. Stakes must be equal, and delta accounting would tax payouts twice. Swap-only taxes (charged in the pool, not on transfers) are fine. |
| Rebasing (either direction) | Rejected by the deploy tool's probe (§11): exact deposit and withdraw of 1 unit, and a balance that stays put over several blocks. Guarded in the contract: exact deposits, and `lock` refuses to run when `balanceOf(vault) < totalLiabilities` |
| Transfers locked until graduation, or max-wallet / max-tx windows | Deposits or withdrawals revert while the lock or limit applies. Nothing is trapped: balances stay, withdraw later or in smaller amounts |
| Blacklist or pause | Settles, refunds and voids are internal credits, so they never call the token and can never be blocked. A blocked player uses `withdrawTo`. The house fee is its own pull line |
| Decimals and symbol | Read from the token by the client and the relay, never hard-coded |

Robinhood Chain's sequencer drops any transaction that involves a sanctioned address. The relay therefore never pairs
an Entry it could not lock, and the timeout refund needs no one's cooperation.

### 3.7 Security bounds (what the tests must prove)

1. Only the player (by wallet transaction) can decrease their free balance, except through `lock` with the player's
   own valid Entry signature.
2. No call by the owner, referee, relayer or anyone else can make a player's withdrawal of free balance fail (with a
   well-behaved token), paused or not.
3. The referee can only settle `Locked` matches, only pay one of that match's two players `2 × stake − fee` with fee
   ∈ {captured fee, captured holder fee}, or void. It can do nothing after `settleBy`.
4. Every `Locked` match can always be closed: by settle before `settleBy`, by `refundExpired` after it.
5. House fees only ever reach `house`.
6. No signature (SessionAuth, Entry, Result) works twice, or on another vault or chain.

### 3.8 Test token (`TestSpiderTag.sol`, test networks only)

- `ERC20("SPIDERTAG Test", "tSPIDERTAG") + ERC20Burnable`.
- 18 decimals, 1,000,000,000 × 10¹⁸ minted once to a `holder` constructor argument (the faucet wallet).
- No owner, mint, permit, tax, blacklist or pause.

It is shaped like the launchpad token the real coin will be. The real token is launched separately and is never
written or deployed by this repo. Token names and artwork must not use Robinhood Chain marks.

### 3.9 Events (the UI's history and the lobby's records come from these)

`Deposited`, `Withdrawn`, `SessionOpened`, `SessionRevoked`, `MatchLocked(matchId, playerA, playerB, …)`,
`MatchSettled(matchId, winner, loser, payout, fee, feeBps, logHash, mutual)`,
`MatchVoided(matchId, playerA, playerB, reason, logHash)`, `HouseWithdrawn`, `HouseFeesSet`, `CapsSet`, `RefereeSet`,
and OpenZeppelin's `Paused` / `Unpaused` / `OwnershipTransferred`.

A player's history:
1. `MatchLocked` logs with `playerA = me`, plus those with `playerB = me`.
2. Then the settled/voided logs by `matchId` (topics OR-list), from the deployment's `deployBlock`.

### 3.10 Gas

The targets, which the forge gas report checks:

| Call | Gas |
|---|---|
| `lock` | ≤ 220k |
| `settle` | ≤ 90k |
| `openSession` | ≤ 90k |
| `deposit` | ≤ 90k |

- **Testnet** (0.01 gwei): a match costs the relayer about 3e-6 test ETH.
- **Mainnet** (about 0.023 gwei): about 7e-6 ETH.

---

## 4. The wager relay (`relay/wager/`, Worker `radrun-wager-relay`)

### 4.1 Layout

A separate Worker with its own `relay/wager/wrangler.toml`, so deploying it never rebuilds or redeploys `radrun-relay`.

| Piece | What |
|---|---|
| `src/worker.ts` | Routes (`protocol.ts` `WAGER_ROUTES`), Origin check (`ALLOWED_ORIGINS`), region check, per-IP limits |
| `WagerLobby` DO (`idFromName("lobby")`) | Login, offers, pairing, player records and ratings, the Radbro cache, the **relayer transaction queue** (the only user of `RELAYER_KEY`, so nonces are serialised), faucet (test networks) |
| `WagerRoom` DO (`idFromName(matchId)`) | One series: sockets, sealed inputs, deadlines and fills, the referee's canonical match, flags, the log, signing with `REFEREE_KEY` |
| `src/room.ts` (`WagerRoomCore`) | Runtime-independent like `relay/src/room.ts`. It reuses the wire codecs (`src/net/wire.ts`) and imports `inputDelayFor` / `RELAY` from `relay/src/room.ts`, but never modifies the live relay's files |
| `dev.ts` | Node stand-in for both DOs (http + ws + `node:sqlite`), for tests and the local end-to-end |

It bundles the canonical sim (about 73 KB minified), `public/levels/tuning.json` and the city models of the allowed
districts (40-95 KB each). At startup it checks `selfTestHash() === SELFTEST_HASH` and refuses to referee on a mismatch.

### 4.2 Login (both sockets)

1. The client sends `hello`.
2. The relay answers `challenge {challenge: 32 random bytes, expiry: now + 60 s, relay: its base URL}`.
3. The client sends `login {player, expiry, sig, by}`, where `sig` is EIP-712 `Login` under the relay domain.
   - `by: "session"`: the signer must equal `vault.sessionOf(player).key` and the session must be unexpired.
   - `by: "wallet"`: viem `verifyTypedData` (EOA, ERC-1271, ERC-6492).
4. The relay accepts each challenge once; one that is expired or already used is refused (`auth`).

### 4.3 Lobby, offers and pairing

**`create {entry, sig, listed, holdersOnly?, minSeries?}`.** Accepted when:
- `entry.player` is the logged-in address.
- The signature is valid (session or wallet) and the session limits allow the stake.
- The stake is ≤ the vault's `maxStake`, and ≤ `NEW_ACCOUNT_MAX_STAKE` while the creator has fewer than
  `NEW_ACCOUNT_SERIES` settled series.
- The free balance is ≥ the stake.
- `roundSeconds ∈ ROUND_SECONDS` and the district is allowed.
- `rules == rulesHash(makeRules(district, referee sim))`.
- `deadline ≥ now + 60 s`.
- The creator has at most 3 open offers.

The offer is listed, or kept unlisted (reachable by its invite link or id). `entry.opponent != 0` makes a named invite.

**`join {entry, sig}` (the joiner's Entry names the creator as `opponent`).** Accepted when:
- The terms pair with the creator's Entry exactly as `lock` would require.
- A named invite is joined only by that address.
- `holdersOnly` and `minSeries` hold.
- The creator's lobby socket is still connected; an offer is withdrawn when its creator leaves.
- Neither player is in another unsettled series.

**Lock.**
1. The lobby sends `matched {a, b}` to both players.
2. It simulates `lock` with `eth_call`, then the relayer sends it.
3. On receipt (soft confirmation, under a second) it sends `locked {tx}` and initialises the room (`POST` internal:
   the offer terms, both Entries, the chain's `matchOf`).
4. If the relayer fails, either player can send `lock` with the two signed Entries it already has.

**Relayer queue.**
- One DO, a local nonce, EIP-1559 fees of 2 × the base fee.
- Receipts are polled every 250 ms with a 30 s timeout.
- On an error it resyncs the nonce from `pending`.

### 4.4 The series room

The phases are `waiting → between → playing → (between → playing)* → deciding → held | signed → settled | voided`
(`SeriesPhase`).

1. **Join.**
   - `hello {compat}`: the client's `simCompat` for the district must equal the referee's, otherwise `version` and
     "reload to update".
   - Then login. Only `playerA` and `playerB` (from `matchOf`) get a seat; anyone else gets `full`.
   - A player who reconnects takes their seat back.
2. **Before round 1** (`joinGraceMs` = 60 s from the lock):
   - Both players must connect and `pick` a Radbro (§4.6).
   - Each sends its `seed` share once, after the `series` message has shown the relay's `seedCommit`.
   - Each sends `ready`.
   - The relay-measured round trip must be ≤ `maxRttMs` (300 ms).
   - If not all of this happens in time, the series is **void, reason `noshow`**. Nobody loses anything.
3. **Each round.**
   - The relay sends 5 `PROBE`s and takes the minimum round trip per player.
   - `inputDelay = inputDelayFor(rttA + rttB)`, from relay measurements only (never client claims).
   - `start` (`WagerStartMsg`: the online `StartMsg` plus `matchId`, `slotOfA`, `score`, `lateMs`) is sent at
     `now + startDelayMs`.
   - The seed and the slots follow §5.5-5.6. Touch and easy assists are off for both slots.
   - The client runs the existing `OnlineSession` on it.
4. **Inputs.** Sealed release, deadlines and fills (§5.3).
5. **Round end.**
   - When the sealed step reaches the horn, the referee's match is over.
   - The relay sends `round {result, score, draws}`.
   - Clients send `end {step, hash}`. A hash that differs from the referee's is a `desync` flag on that side, and the
     referee's result stands.
6. **Between rounds** (`betweenRoundsMs` = 15 s): both READY starts the next round early; otherwise it starts when the
   timer ends.
7. **Disconnects.**
   - If a socket closes after round 1 has started, the relay sends `drop {side, graceMs}` and keeps filling that
     player's inputs.
   - A player who returns within `reconnectGraceMs` (20 s) gets `back`, the current `start` again, and every sealed
     word so far, and catches up.
   - A player who does not return **forfeits the series** (`forfeit`, `why: "disconnect"`). If both players are gone
     past the grace, the series is void (`error`).
8. **Relay failure.**
   - The room persists the series header at init and every finished round.
   - A room that restarts mid-round cannot recover that round's inputs, so the series is **void (`error`)**.
   - A relay fault never picks a winner.
   - Never deploy the wager Worker while series are live: the deploy tool checks `GET /health` first.
9. **Decision.** Covered in §5.7 (signing) and §6.3 (holds).

### 4.5 Records and ratings (the lobby's smurf protection)

Every card shows a `PlayerCard`:
- **Rating:** Elo, starting at 1200 with K = 32, over settled wins and losses. Forfeits count as losses.
- **Counts:** W-L, forfeits, voids, and series held for review.
- **Account:** the first-seen date, and a NEW tag below `NEW_ACCOUNT_SERIES` settled series.
- **Radbros:** the holder badge and owned Radbros.

Records live in the lobby DO's SQLite and are updated when a settle or void is confirmed on-chain. Creators can require
`minSeries`, and new accounts are held to `NEW_ACCOUNT_MAX_STAKE`.

### 4.6 Radbro holders (perks never touch gameplay)

- **Reads.** The relay reads Ethereum mainnet with public RPCs (`RADBRO.rpc`, override `ETH_RPC_URLS`; viem
  `fallback`), for the proven address only:
  - **Holder:** `balanceOf` on V2 `0xABCDB5710B88f456fED1e99025379e2969F29610` > 0, or on V1
    `0xE83C9F09B0992e4a34fAf125ed4FEdD3407c4a23` > 0.
  - **Owned ids:** `tokensOfOwner(address)` on V2.
  - **Owner, not renter:** `ownerOf` is used, never ERC-4907 `userOf`, so a rental earns no perk.
  - Results are cached for 10 minutes. If every RPC fails, the answer is "not a holder": no perk and no error.
- **Fee discount.** At signing time the referee re-reads the winner (a cache no older than 60 s). A holder winner
  gets `holderFeeBps`, within the captured bound (§3.5).
- **Own Radbro.**
  - The player sends `pick {radbro: <roster model>, own: <token id>}` and the relay checks `ownerOf(own) == player`.
  - An owned id that is one of the five rigged roster models plays as that model.
  - Any other owned id plays on the chosen roster body, with its token number as the name tag and the holder badge.
  - Anyone may still pick the roster Radbros as stock characters. The sim never reads the Radbro id.
- **Cosmetics.** Web colour and trail (`Cosmetic`) are render-only. The relay passes them on only for holders.
- **Later:** holder-only tables (`holdersOnly` offers).
- **Never:** stat boosts, tuning changes or anything in `TagSlot`.

### 4.7 Region block

- **Setting.** `REGION_BLOCK` is a comma-separated list of ISO 3166-1 alpha-2 codes. It is empty (off) by default.
- **Where it applies.** The Worker compares `request.cf.country` against it on `/config` (which reports
  `regionBlocked`), both socket upgrades and `/faucet`. The Node stand-in reads an `x-dev-country` header, but only
  when `DEV=1`.
- **What it never blocks.** The block never stands between a player and their funds: withdrawing is a direct contract
  call, and `refundExpired` needs no relay.

### 4.8 Faucet (test networks only)

- **Request.** `POST /faucet {address}` sends `FAUCET_TOKENS` test tokens, plus `FAUCET_ETH` (about 0.0005 test ETH)
  when the address holds less than that, from `FAUCET_KEY`.
- **Limits.** Once per address per day and 3 per IP per day.
- **Where it runs.** It is refused on `MAINNET_CHAIN_IDS` whatever the config, and it is 404 unless `FAUCET=1`.
- **Why tokens go to the wallet.** Testers then exercise the real approve → deposit flow.

### 4.9 Review (held series)

`POST /review {matchId, decision, logHash, sig}`, where:
- `sig` is EIP-712 `Review` under the relay domain, signed by the wallet that is `vault.owner()` (read on-chain).
- `decision` 1 means "settle as replayed": the referee signs the replayed Result.
- `decision` 2 voids the series (reason `review`).

The review page is `?wager&review=<matchId>`: the flags, the replay, and the two buttons. The review must happen before
`settleBy`. After that, anyone can refund.

### 4.10 Platform limits

| Limit | Value | Our use |
|---|---|---|
| DO CPU per request or WebSocket message (Free and Paid) | 30 s | Incremental replay costs 2.3-8.4 µs per step, about 0.3-1.0 ms of CPU per second of play. One 4-step INPUT costs about 30 µs of sim. A cold replay of a whole 3:00 round costs 0.3-0.9 s, and is only needed by the CLI or verify page |
| Stateless Worker CPU, Free | 10 ms | Routing only: never run the sim outside a DO |
| Workers Free requests (per account, **shared with `radrun-relay`**) | 100,000 a day, with incoming WS messages billed 20:1 | A 3 × 90 s series is about 21k messages ≈ 1,060 requests, so about 90 series a day on the free plan alongside the live relay. Move to Workers Paid, or a separate account, before a public launch |
| DO duration, Free | 13,000 GB-s a day | About 51 GB-s per series (128 MB × ~400 s) |
| DO SQLite storage, Free | 5 GB | A series log is about 0.4-0.6 MB as JSON, and about 40-120 KB stored gzipped |
| Script size | 3 MB (Free) | Sim + 5 districts + viem is well under that |

A Vercel function is **not** used for the referee. A DO has 30 s of CPU per message against a need of about 1 ms. The
independent re-checks are the browser verify page and `npm run wager:verify`.

### 4.11 Storage

| Store | Contents |
|---|---|
| `WagerLobby` SQLite | `players(address PK, name, rating, wins, losses, forfeits, voids, held, first_seen, last_seen, cosmetic)`, `offers(match_id PK, json, deadline)`, `matches(match_id PK, state, a, b, stake, lock_tx, settle_tx, ended_at)`, `radbro_cache(address PK, json, at)`, `faucet(address PK, at)`, `ip_counters` |
| `WagerRoom` SQLite | `series(json)` and `rounds(round PK, json)` while live. At the end, `log` holds the gzipped SeriesLog JSON |
| Serving | `GET /log/<id>` serves the stored gzip with `Content-Encoding: gzip`, `Content-Type: application/json`, a year of cache, and CORS `*` (public) |

---

## 5. The referee: authoritative replay

### 5.1 Where it runs

The WagerRoom DO steps the canonical `TagMatch` **incrementally**, as input steps are sealed, so the result exists at
the horn with no burst of work. The referee never uses what a client claims (standings, hashes or bag times). The same
code (`src/wager/replay.ts`) runs in:
- the room DO;
- the verify page, in the viewer's browser ("view source is the audit");
- `tools/wager-verify.ts <matchId>` (Node).

### 5.2 Sim identity

- `simCompat(assets) = {v: NET_VERSION, selftest: SELFTEST_HASH, tuning: tuningHash(tuning, tag), city: model.hash}`.
- `simId = keccak256("radrun-sim:v:selftest:tuning:city")` goes into `rules`.

So:
- A client on a different sim can't pair or join ("reload to update").
- Every settled series names the exact sim it was refereed on. The log also records the site `build`.
- A later sim change invalidates open offers, not settled matches: a settled series is re-verified by checking out its
  `build`.
- A deploy that changes the sim ships the site and the wager Worker together (the same coupling as the live relay,
  PLAY.md).

### 5.3 Input pipeline: sealed release, deadlines, fills

The wager room's changes to the live relay's input handling:

1. **Sealed release.** The relay forwards step `s` of any slot only once **every** slot's step-`s` word is in
   (received or filled). No client ever sees the opponent's input for a step before its own input for that step is
   committed. Honest players see each other with the slower player's delay; that is the only cost.
2. **Deadline.** The word for step `s` from slot `k` must arrive by
   `startAtMs + s × 8.333 ms + lateMs + min(oneWay_k, maxOneWayAllowMs)`, where:
   - `lateMs` is 100;
   - `oneWay` is half the relay-measured minimum round trip;
   - `maxOneWayAllowMs` is 150.

   An honest client sends step `s` at about step `s − inputDelay − 1` (plus at most about 40 ms of batching), so it
   has about 85-150 ms of slack whatever its ping.
3. **Fill.** A missed deadline makes the relay fill that step with `predictWord(last word used)`: held keys stay, and
   presses (jump, Yoink, zip, slide) are dropped.
   - It sends `FILL` (net/wire.ts `encodeFill`) to **both** clients, including the late one: its client must
     overwrite its own local word and roll back. That is the one Rollback change the client lane makes.
   - A late word for an already-filled step is dropped and counted.
   - An INPUT that overlaps filled steps is accepted from the first unfilled step. It is not a protocol error.
4. **Bounds.**
   - Words may run at most `aheadSteps` (600) ahead of the relay clock, and never past the horn.
   - Steps `1..inputDelay` are the empty word for both slots.
5. **What the log keeps.** The referee's buffers hold exactly the words its match consumed, whether received or
   filled. That is the log.

A lag-switcher can therefore never see the opponent's same-step input. Holding inputs back gains at most the deadline
slack (about 100-250 ms, the same as having a worse connection), costs them presses, and shows as a `late-inputs` flag
(§6.2).

### 5.4 The series log and `logHash` (`src/wager/log.ts`)

`SeriesLog` (`format: "radrun-wager-log/1"`) carries:
- the chain id, vault and match id;
- `[playerA, playerB]`, the stake and the captured fees;
- the round length, the rules and their hash;
- the referee's compat and build;
- the roster Radbros;
- the seed commit and reveal (`relaySecret`, both shares);
- `rounds[]`: round number, seed, `slotOfA`, `inputDelay`, `endStep`, `lastStep`, the words per **sim slot** (base64 of
  6-byte little-endian packed words, step 1 first), the result per **player**, and the fill counts;
- the outcome (`win` / `void`, winner, reason, score, and the forfeit if any);
- the flags;
- `logHash`.

The hash:
```
headerDigest = keccak256(abi.encode("radrun-wager-log/1", chainId, vault, matchId, playerA, playerB,
                                    rulesHash, roundSeconds, relaySecret, shareA, shareB))
roundDigest  = keccak256(u8 round · u32 seed · u8 slotOfA · u8 inputDelay · u32 endStep · u32 lastStep
                         · slot-0 word bytes · slot-1 word bytes)                       (integers big-endian)
logHash      = keccak256(headerDigest · roundDigest_1 · … · roundDigest_n)
```

- Results, flags and the outcome are **not** hashed. They are derived from the log, and the verify page recomputes
  them.
- A series with no rounds (a no-show) hashes the header alone.
- `Result.logHash` puts this commitment on-chain.

### 5.5 Seeds (commit-reveal)

1. At init the room draws `relaySecret` (32 random bytes) and shows `seedCommit = keccak256(relaySecret)` in `series`
   before any share exists.
2. Each player sends a 32-byte `seed` share. A missing share by round 1 is a no-show.
3. The seed of round `r` is `deriveSeed = first 4 bytes of keccak256(abi.encodePacked("radrun-seed", relaySecret,
   shareA, shareB, uint8 r))`.
4. The secret is revealed in the log.

Neither player can pick the seed, and the relay committed before seeing the shares. The seed decides the spawns and the
first holder.

### 5.6 Series rules

- **Best of 3:** first to 2 round wins.
- **Round result:** `standings()[0]`: less bag time, then fewer falls, then more tags. If all three are **equal**, the
  round is a **draw** and is replayed as a tie-break round with the next round number and a fresh seed.
- **Too many draws:** a 3rd draw voids the series (`draws`), so there are at most 5 rounds. Exact ties no longer go to
  slot 0.
- **First holder:** in round 1, player A takes slot 0 and the seed decides who starts with the bag. In round 2
  (`slotOfAFor`), the slots are arranged so that the player who did **not** start with the bag in round 1 does now.
  Round 3 and any tie-breaks put A in slot 0 again.
- **Round length:** `ROUND_SECONDS` = 60 / 90 / 120, default 90. It is fixed in both Entries; the relay ignores
  `config` messages. A 3 × 90 s series takes about 5-6 minutes with loads.
- **Assists:** touch aim and easy grab are off for both slots in wager rounds (`assist: 0` in the rules).

### 5.7 Signing

When the series ends and is not held (§6.3), the room signs `Result{matchId, outcome, winner, feeBps, logHash}` with
`REFEREE_KEY`:
- `winner` is the series winner's address, or 0 on a void;
- `feeBps` is chosen as in §3.5.

Then:
1. It stores the log and sends `outcome` and `settlement {result, sig}` to both players.
2. The lobby's relayer submits `settle`, and the room sends `settled {tx}`.
3. The lobby updates the records.

Clients can submit the same `settlement` themselves.

---

## 6. Anti-cheat

### 6.1 Threats and what stops each one

| Threat | What stops it |
|---|---|
| **False result report** (a client claims it won) | Clients' standings and hashes are ignored. The referee's replay of the relay-recorded inputs is the only result. A client whose final hash disagrees is flagged `desync` |
| **Modded physics or speed, altered tuning** | Inputs are quantised 41-bit words (move clamped to length ≤ 1). The canonical sim decides what they do. A modded client only desyncs its own screen and loses by the replay. The compat/simId check refuses mismatched sims up front |
| **Late inputs / lag switch** (waiting to see the opponent's input) | Sealed release: nobody gets the opponent's step-`s` input before their own step-`s` input is in. Relay-clock deadlines with fills cap how long anyone can hold back. Arrival slack is recorded and flagged (§6.2) |
| **Rollback abuse** (bursty late inputs to make the victim's screen jump) | The same deadlines. Filled steps are final. Input delay comes from relay-measured round trips, not client claims |
| **Rage-quit / disconnect** | After round 1 starts, leaving means a 20 s grace (inputs filled), then **forfeit of the series**. Before round 1 it is a void (nobody pays). There is never a free refund for a player who is losing |
| **Scripted bots / aimbot / triggerbot** | Referee-side metrics from the canonical replay (reaction time, aim error, periodicity, press cadence). A flagged winner holds the series for review instead of auto-signing (§6.2-6.3) |
| **Smurfs** | Public records, ratings and account age on every card. Stake caps for new accounts. Per-offer `minSeries` and `holdersOnly` |
| **Perk spoofing** (fake holder, somebody else's Radbro) | Holder status and ownership come from the relay's own Ethereum reads for the address proven at login, never from the client. Rentals don't count. The fee discount is bounded on-chain by the captured holder fee. Cosmetics are render-only |
| **Stranger taking a seat** (room codes, invites) | Room seats go only to the two addresses in `matchOf(matchId)`, proven by a Login signature. A named invite (`opponent` set) can't be joined by anyone else: the relay refuses it, and `lock` would revert |
| **Replayed signatures** | Covered in §3.3: domain binding, single-use match ids, Results only on `Locked`, SessionAuth nonces, single-use Login challenges |
| **House-picked seeds / first holder** | Commit-reveal seeds (§5.5) and first-holder alternation in round 2 (§5.6) |
| **Host-set match length, self-declared assists** | Terms are fixed in both signed Entries. Assists are off for both slots. The relay ignores `config` and `hello.touch/easy` |
| **Relay or referee misbehaviour** | Every Result commits to a public log that anyone can replay. A lying referee is provable. Stakes are capped per match. Nothing the relay holds can move free balances |
| **Quota exhaustion / spam** | Per-IP socket and message limits, per-player offer limits, offers need a funded vault balance and a signed Entry. It is a separate Worker (but the same account quota, see §4.10) |

### 6.2 Flags

Computed by the referee from its canonical match plus the relay's arrival times. The thresholds are starting values.
The relay lane calibrates them so that the repo's `TagBot` at `sharp` is flagged, and ordinary human play recorded on the
dev relay is not.

| Kind | Signal | Starting threshold |
|---|---|---|
| `reaction` | Steps from the moment the holder's ring turns red on the runner (`ringId === RING_RUNNER`) to the web press that Yoinks | median < 18 steps (150 ms) over ≥ 5 events, or ≥ 3 events < 10 steps |
| `aim` | Yaw error at Yoink/yank presses against the exact bearing to the target | median ≤ 1 yaw unit (0.35°) over ≥ 5 presses |
| `periodic` | Coefficient of variation of the intervals between presses | < 0.03 over ≥ 12 presses |
| `late-inputs` | Median arrival slack against the deadline, and the fraction filled | median slack < 10 ms, or > 5% of steps filled, with a relay-measured round trip < 150 ms |
| `desync` | The client's `end` hash differs from the referee's | any |
| `result-mismatch` | Both clients' final hashes agree with each other but not with the referee | any (this points to a referee or sim problem: always hold) |
| `rtt` | Reserved: probe round trips inconsistent with input timing | - |

### 6.3 Holds

- **Held:** flags against the **winner**, or any `result-mismatch`, put the series in `held` when `HOLD_ON_FLAGS=1`
  (the default).
- **Not held:** flags against the loser alone are recorded, but the series settles: a cheater who lost anyway just
  loses.
- **Resolving a held series:** it waits for the owner's review (§4.9). If nobody reviews it before `settleBy`, anyone
  can refund it.
- **Records:** a player's `held` count is public on their card.

---

## 7. Client (`?wager`, its own lazy chunk)

### 7.1 Route and chunk

- **Route.** Add `params.has("wager")` to `src/main.tsx` (before the `tag` route), with
  `const WagerPage = lazy(() => import("./wager/WagerPage.tsx"))`. That is the only change to the main chunk, and it
  must grow by no more than about 2 kB.
- **What stays out of the main chunk.** viem and everything wager-related live only in the lazy chunk and what it
  imports.
- **Reused code.** The series view reuses the existing SPIDER-TAG scene, HUD and online session through the TagPage
  pieces. No renderer changes except the holder cosmetics hook.
- **Sub-routes.** `?wager` is the lobby. `?wager&join=<matchId>` is an invite link. `?wager&match=<matchId>` is a
  locked series (the page opens it when a match of yours locks). `?wager&verify=<matchId>` is the public replay and
  verify page, which needs no wallet (`?verify=<matchId>` alone opens it too). `?wager&review=<matchId>` is for the
  owner. Add `&net=<id>` to pick another enabled deployment.

### 7.2 Wallet

- **Discovery.** EIP-6963 injected-wallet discovery, falling back to `window.ethereum`. There is no WalletConnect in the
  beta: it would need a project id.
- **Network.** `wallet_switchEthereumChain`, then `wallet_addEthereumChain` on error 4902, with the chain from the
  deployment (always named "Robinhood Chain", never shorthand).
- **Clients.** viem `createWalletClient(custom(provider))`, plus a `createPublicClient` with a `fallback` over the
  deployment's RPCs.
- **Amounts.** They use the token's own decimals and symbol, read from the chain.

### 7.3 Screens (pad-friendly: `ui/screens.tsx` `btn`/`panel` and PadRoot focus order)

- **Banner.** The deployment label ("BETA · TESTNET") is always visible, with the network name and the short address.
- **Wallet panel.**
  - Balances: the token in the wallet, free and locked in the vault.
  - **Deposit:** approve exactly the amount, then deposit, with each transaction's state shown.
  - **Withdraw:** an amount, or all.
  - **Faucet:** on test networks only.
  - **Session:** "play without popups" (sign a SessionAuth; the relayer submits it). It shows the limits,
    used/cap and expiry, and has **Revoke**.
  - "Submit it yourself" fallbacks for `lock`, `settle` and `refundExpired`.
- **Lobby.**
  - Open offers, with creator cards: name, rating, W-L, forfeits, NEW tag, holder badge. Each shows the stake, round
    length, district and the fee (with "1.5% if you win holding a Radbro").
  - **Create:** stake; round length (60/90/120); district; listed, invite link or named opponent; holders only; minimum
    series.
  - **My offers:** cancel, copy the invite link.
- **Series.**
  - Before round 1: both cards, the Radbro pick (the roster plus owned ids), READY, timers.
  - In a round: the existing HUD plus a series scoreboard ("ROUND 2 · 1-0") and the opponent's connection state.
  - Between rounds: the round result.
  - At the end: the winner, the payout credited, the fee and the settle state (signing → settled, with the
    transaction). A held series shows **"held for review"** with `settleBy`.
  - A "verify this match" link.
- **History.** Built from events (§3.9): date, opponent, stake, result, payout, transaction links and verify links.
- **Verify.**
  1. It fetches `/log/<matchId>` and the chain's `MatchSettled`/`MatchVoided` for that match.
  2. It checks that the log names this match, vault and chain, checks the log hash against the on-chain `logHash`
     and runs `verifySeries` against the district's model and tuning. A refund after the settle window (void reason
     3) stores no log hash, so that one reads as refunded instead. A held series voided on review keeps its rounds
     and outcome reason `review`, which verifies.
  3. It shows every round (the logged result against the replayed one, the seeds with commit and reveal), the flags and
     a clear verdict.
  4. **Watch:** replays a round in the 3D view through a `ReplayLink` that implements `NetLink`.
- **Copy.** Plain game language. The page carries no legal text, says "Robinhood Chain" in full, writes "pons" in
  lowercase, and implies no partnership.

### 7.4 Series netcode

- **Session.** `WagerStartMsg` is a `StartMsg`, so `OnlineSession` builds the round unchanged. The room socket is
  `Transport.connect(relayBase, matchId)` (the route is `/ws?room=<matchId>`).
- **Additions to `src/net/rollback.ts` / `session.ts`** (additive; the live mode never receives a FILL):
  - apply `FILL` for any slot, including its own (overwrite the word, rewind);
  - echo `PROBE`;
  - catch up from step 0 after a reconnect;
  - predict up to 72 steps (600 ms) ahead of the other player's newest word instead of the online 24. The sealed
    release delivers it a whole round trip later, and a stall would also hold back this player's own words past
    their deadlines (at a 280 ms round trip almost every step was filled);
  - send the words a frame sampled at that frame's last step (still at most one INPUT per 25 ms), so a low frame
    rate doesn't leave half of them waiting a frame past their deadlines.
- **Checks.** netsim gates 1-2 and the self-test must stay green.

### 7.5 Dev-only test wallet

- **What it is.** `src/wager/devWallet.ts` is an EIP-1193 provider that signs with anvil's well-known keys and is
  announced through EIP-6963 as "Dev wallet #n".
- **How it loads.** Only through
  `if (import.meta.env.MODE !== "production" && params.has("devwallet")) await import("./devWallet.ts")`, so a
  production build drops it.
- **What checks it.** A test builds for production and fails if `dist/` contains `devWallet`, any anvil key or any
  anvil address.

---

## 8. Configuration

**Deployments** (`src/wager/deployments.json`, read through `config.ts` `DEPLOYMENTS`):

| Deployment | Chain | Chain id | Relay | Vault / token |
|---|---|---|---|---|
| `local` | anvil | 31337 | `:5402` | set by the local deploy |
| `rh-testnet` | Robinhood Chain Testnet | 46630 | `radrun-wager-relay` | set by `npm run wager:deploy -- --net rh-testnet` |
| `rh-mainnet` | Robinhood Chain | 4663 | `radrun-wager-relay-main` | set only by the mainnet step (§11) |

**Env names** (the authoritative list is `config.ts` `WAGER_ENV`):

- **Site (Vite, build time).**
  - `VITE_WAGER_NETS`: comma-separated deployments this build offers, the first being the default. Unset turns the
    page off.
  - `VITE_WAGER_RELAY_URL` and `VITE_WAGER_RPC`: optional overrides.
  - Dev only: `&net=`, `&relay=`, `&rpc=`, `&devwallet=`.
- **Relay vars** (`relay/wager/wrangler.toml [vars]`):
  - `WAGER_NET`, `ALLOWED_ORIGINS`, `DEV`, `RPC_URLS`, `ETH_RPC_URLS`, `REGION_BLOCK`, `ROUND_SECONDS`, `DISTRICTS`
  - `NEW_ACCOUNT_MAX_STAKE`, `NEW_ACCOUNT_SERIES`, `LATE_MS`, `RECONNECT_GRACE_MS`, `JOIN_GRACE_MS`, `HOLD_ON_FLAGS`
  - `FAUCET`, `FAUCET_TOKENS`, `FAUCET_ETH`
- **Relay secrets** (`wrangler secret put`): `REFEREE_KEY`, `RELAYER_KEY`, `FAUCET_KEY` (test networks only), and an
  optional `RPC_URL_PRIVATE`.
- **Tools.** A 0600 env file outside the repo per deployment. It holds `DEPLOYER_KEY`, `REFEREE_KEY`, `RELAYER_KEY`,
  `FAUCET_KEY`, `WAGER_OWNER`, `WAGER_HOUSE`, `WAGER_TOKEN`, `WAGER_FEE_BPS`, `WAGER_HOLDER_FEE_BPS`,
  `WAGER_MAX_STAKE`, `WAGER_MAX_BALANCE`, `WAGER_SETTLE_WINDOW` and `RPC_URL_PRIVATE`.
- **Rules for keys.** No key ever enters the repo, a command line, a log or an output.

---

## 9. Test plan

### 9.1 Contracts (`npm run wager:contracts`: forge test, with a fuzz and invariant profile)

- **Unit tests:** every function, every revert (each error in `IGameVault`), and every event with its arguments.
- **Fuzz tests:**
  - Payout maths against §3.5 for any stake and fee.
  - Captured fees against `min` for any settings and caps.
  - Session limits (maxStake, cap, expiry, nonce) for any values.
- **Invariants** (handler-based: players, owner, referee, relayer and a random actor calling everything; warp time):
  - I1: `token.balanceOf(vault) ≥ totalLiabilities`.
  - I2: `totalLiabilities == Σfree + Σlocked + houseAccrued`.
  - I3: `Σlocked == Σ over Locked matches of 2 × stake`.
  - I4: a ghost check that a player's free balance only drops through their own withdraw or a lock carrying their
    signature.
  - I5: after `warp(settleBy + 1)`, `refundExpired` succeeds for every Locked match.
  - I6: withdrawing the full free balance succeeds (a well-behaved token), paused or not.
  - I7: `houseAccrued` only ever leaves to `house`.
- **Signatures:**
  - Replay on a second vault, and under another `chainId`.
  - A Result applied to a different match.
  - A reused match id.
  - A high-s signature.
  - An ERC-1271 wallet (mock) for SessionAuth, Entry and mutual settles.
  - A session key trying `settleMutual`.
  - The holder fee in `settleMutual` (reverts).
- **Quirk tokens (mocks):**
  - fee-on-transfer (deposit reverts);
  - positive and negative rebasing (insolvency guard);
  - blacklist: the blocked player uses `withdrawTo`, and the opponent's settle and withdraw are unaffected;
  - pausable token: settles still work, and withdrawals succeed after the token unpauses;
  - locked-until-graduation: the deposit reverts, then works after the unlock;
  - max-wallet: a large withdraw reverts, and smaller ones work.
- **Owner:** can't touch balances; fee bounds; what pause does and does not stop; referee rotation takes effect on
  live matches.
- **Gas report** against §3.10.

### 9.2 Relay (`node --test test/wager-relay*.test.ts`, fake clock, sockets and chain like `test/relay.test.ts`)

- **Results:**
  - Both clients agree: a signed win with the right `logHash` (checked with `seriesLogHash`), `settle` submitted.
  - A client's hash mismatches: `desync` flag, and the referee's result stands.
  - Both clients disagree with the referee: held.
- **Seats and entries:**
  - A stranger opening a room socket, or joining a named invite: refused.
  - Entries that don't pair (stake, round length, rules, opponent, deadline, caps, new account, holders-only,
    min-series): refused before any transaction.
- **Login:** a replayed challenge, an expired one, a wrong signer, a revoked or expired session: refused.
- **Inputs:**
  - Sealed release: a client never receives the opponent's step `s` before its own step `s` is in.
  - Deadline edges: fill on the deadline, and a late word dropped.
  - An overlapping INPUT is accepted.
  - `FILL` reaches both clients.
- **Series:**
  - no-show → void; a disconnect within grace → back; a disconnect past grace → forfeit; both gone → void;
  - draw → tie-break round, 3 draws → void;
  - round 2 first-holder alternation.
- **Perks and settings:**
  - The holder fee is chosen for a holder winner (mocked Ethereum reads). An RPC failure means no perk.
  - Region block on and off.
  - The faucet is refused on a mainnet chain id.
- **Relayer:** the queue serialises nonces, and a failed transaction resyncs.
- **Flags:** `TagBot` sharp is flagged (held); ordinary recorded play is not.
- **Measured and reported:** per-message referee CPU and a cold whole-series re-verify, in `wrangler dev` (workerd)
  and in Node.

### 9.3 Client (`node --test test/wager-client*.test.ts`)

- **Units:** config parsing; amount parsing and formatting with decimals; session defaults and limits; EIP-6963
  discovery (mock events); chain add/switch fallback.
- **Rollback:** the FILL own-slot override passes the netsim harness (gates 1 and 2 still pass) and the
  `OnlineSession` tests.
- **A fake wager room:** a best-of-3 in `session.test.ts` style.
- **Bundle:** `npm run build` keeps the main chunk within about 2 kB of `main`'s. The production `dist/` contains no
  dev wallet, anvil keys or anvil addresses.

### 9.4 End to end (`npm run wager:e2e`: local, no testnet)

Ports: anvil 5401 (`--chain-id 31337`), wager relay stand-in 5402, site 5403 (a `build:test` preview).

1. **Deploy.** `forge script` deploys `TestSpiderTag` and `GameVault` with anvil keys (referee #8, relayer #9, house
   #7). The tool writes the `local` deployment.
2. **Browsers.** Two headless Chromiums (`--headless=new`, throwaway profiles) open
   `?wager&net=local&devwallet=1` and `&devwallet=2` with `&bot=normal`.
3. **Play and settle.**
   - Each gets tokens from the faucet, approves and deposits 1,000, and authorises a session key.
   - One creates a 100-token invite with 20 s rounds (the local relay allows `ROUND_SECONDS=20,60,90,120`); the other
     joins by the link.
   - They play the full best-of-3, and the series is settled (`HOLD_ON_FLAGS=0` for this run).
   - Check: winner free = 1,094, loser 900, house 6 (97/3 of the 200 pot); `totalLiabilities` = token balance.
   - Both withdraw, and the wallet balances are checked.
4. **Verify.** A third page opens `?wager&verify=<matchId>`: verdict OK, the same winner, `logHash` equal to the
   chain's.
5. **Other paths:**
   - an offer cancelled: no lock;
   - a lock where player B never connects: void, and balances restored;
   - a lock with the relay stopped, anvil `evm_increaseTime` past `settleBy`, then `refundExpired`: balances restored;
   - a mid-series tab close: forfeit after the grace;
   - `HOLD_ON_FLAGS=1` with `&bot=sharp`: held, then an owner-signed review settles it.
6. **Cleanup.** Every process is stopped by its own PID.

---

## 10. Branches and file ownership

The three builders branch from `feat/wager` at the commit that adds this file and work in parallel. The shared files
are **frozen**. If one must change, the change lands as a new commit on `feat/wager`, and all three lanes rebase onto it.

| Lane (branch) | Owns |
|---|---|
| `feat/wager` (this design) | `docs/WAGER.md`, `contracts/foundry.toml`, `contracts/src/interfaces/IGameVault.sol`, `src/wager/{eip712,log,replay,protocol,config}.ts`, `src/wager/deployments.json` (after this, only the deploy tool writes it), `test/wager-shared.test.ts`, `package.json` / `package-lock.json` (the viem and OpenZeppelin deps and every `wager:*` script are already in), `.gitignore` |
| `feat/wager-contracts` | `contracts/src/GameVault.sol`, `contracts/src/TestSpiderTag.sol`, `contracts/test/**`, `contracts/script/**`, `contracts/lib/**` + `.gitmodules` (forge-std), `tools/wager-deploy.ts` (local / testnet deploy, the token probe, source verification, writing the deployment; the mainnet mode only runs with an explicit go-ahead flag) |
| `feat/wager-relay` | `relay/wager/**` (wrangler.toml, `src/*`, `dev.ts`, types), `test/wager-relay*.test.ts`, `tools/wager-verify.ts` |
| `feat/wager-client` | `src/wager/**` except the shared files above, the one route in `src/main.tsx`, additive FILL/PROBE/reconnect support in `src/net/rollback.ts` and `src/net/session.ts`, series HUD and cosmetics hooks in `src/app/TagPage.tsx` and the tag render files, `test/wager-client*.test.ts`, `tools/wager-e2e.ts` |
| Nobody | `relay/src/**`, `relay/wrangler.toml`, `relay/dev.ts` (the live relay), `src/net/wire.ts`, `src/game/tagMatch.ts` and the sim, `public/levels/**`, README/PLAY (no link to `?wager`) |

Every commit keeps `npm test`, `npm run typecheck` and `npm run build` green.

---

## 11. Deploying

- **Test network (after the lanes merge):**
  1. Make the keys with `cast wallet new`, into a 0600 file outside the repo.
  2. Claim test ETH by hand once into the deployer (the official faucet has a browser check). The deployer funds the
     relayer and the faucet.
  3. `npm run wager:deploy -- --net rh-testnet` deploys `TestSpiderTag` (the supply goes to the faucet wallet) and
     `GameVault`, verifies both on the testnet explorer (Blockscout or Sourcify), and writes `deployments.json`.
  4. Deploy the wager Worker and put its secrets.
  5. Set `VITE_WAGER_NETS=rh-testnet` for the site build.
- **Mainnet: only on the owner's explicit go-ahead, with the owner's own token.**
  - The same tool with `--net rh-mainnet --token <address>`. It probes the token on a mainnet fork first: exact
    deposit and withdraw, no rebasing, decimals and symbol.
  - It deploys one vault for that token with the owner's house and owner addresses and beta caps, verifies the source
    publicly, and writes the `rh-mainnet` deployment.
  - It deploys `radrun-wager-relay-main`, and the site is rebuilt with `VITE_WAGER_NETS=rh-mainnet,rh-testnet`.
  - Without the explicit go-ahead flag it only simulates on a fork.
  - Nothing in this repo mints, launches or trades the real token.

---

## 12. Open items

- **Robinhood Wallet on the testnet:** support for chain 46630 is unknown. MetaMask and Rabby work through
  add-network.
- **Public RPC limits:** the numbers are unknown, and a burst returned 429. Relay traffic should use a keyed RPC
  (`RPC_URL_PRIVATE`).
- **Cross-engine determinism:** Safari on iPhone is still unchecked (PLAY.md). The referee is authoritative anyway: an
  engine that disagrees only shows its player a wrong screen, and the self-test gate refuses it at join.
- **Flag thresholds:** they need calibration on real human sessions (§6.2).
- **Per-token Radbro models:** only the five rigged ids have models. Other holders play on a roster body with their
  badge and id.
