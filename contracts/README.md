# SPIDERTAG wager contracts

The SPIDERTAG wager vault (1v1 TAG for tokens) and its test token. The game was called RadRun when these were deployed:
the EIP-712 domain stays `"RadRun GameVault"`, version `"1"` (a deployed vault's signatures depend on it). The design, the trust model and the numbers are in
[`docs/WAGER.md`](../docs/WAGER.md) §3; this file is how to build, test and deploy them.

| Path | What |
|---|---|
| `src/interfaces/IGameVault.sol` | The frozen interface: structs, events, errors, EIP-712 typehashes |
| `src/GameVault.sol` | The vault. One per token, no proxy, no admin withdrawal, withdrawals never paused |
| `src/TestSpiderTag.sol` | `tSPIDERTAG`, the test networks' token (1e9 supply, 18 decimals, burn; no owner, mint, tax or pause) |
| `test/` | Unit, signature, fuzz, token-quirk, scenario, invariant and gas tests; mocks in `test/mocks/` |
| `script/Deploy.s.sol` | The deploy script (driven by `tools/wager-deploy.ts`) |
| `snapshots/GameVault.json` | Whole-transaction gas of the calls players and the relayer send (rewritten by `forge test`) |

## Dependencies (from a fresh clone)

```sh
npm ci                                            # OpenZeppelin Contracts 5.6.1 (pinned in package.json)
git submodule update --init contracts/lib/forge-std   # forge-std v1.16.2 (pinned in foundry.lock)
```

- OpenZeppelin comes from the repo's own npm install (`../node_modules`, remapped in `foundry.toml`), so the site
  and the contracts can never disagree on its version.
- forge-std is a git submodule rather than an npm package: an npm git dependency would put a `git+ssh` URL into
  `package-lock.json` and break `npm ci` on the site's build.
- Foundry 1.8.x (`forge`, `cast`, `anvil`). The tools look in `PATH`, then in `~/.foundry/bin`.

## Build and test

```sh
npm run wager:contracts          # forge build && forge test (all suites)
cd contracts && forge fmt --check && forge lint
```

| Suite | Covers |
|---|---|
| `GameVault.t.sol` | Every function, every revert of `IGameVault` in the spec's order, every event with its arguments, the owner's limits |
| `Signatures.t.sol` | Replay on another vault or chain, results bound to their match, reused match ids, high-s and malformed signatures, ERC-1271 wallets, EIP-7702 accounts, session keys refused for mutual settles, named seats |
| `Eip712Vectors.t.sol` | The vault's digests equal viem's (`src/wager/eip712.ts`) and Foundry's EIP-712 encoder; a viem signature opens a session |
| `Fuzz.t.sol` | Payout maths, captured fees, session limits, deposit/withdraw and void round trips |
| `TokenQuirks.t.sol` | Fee-on-transfer and sender-taxed tokens, rebasing both ways, blacklist (a blocked house sends its fees elsewhere), pausable, locked-until-graduation, max-wallet/max-tx, no-return and false-returning tokens, re-entry through a token hook |
| `Hardening.t.sol` | The security review's findings, each as the property it showed broken: a copied session key loses at most its cap, voids give the cap back, match ids bound to their creator, open vs named Entries and `cancel`, fee caps can't remove the house fee, referee rotation, `reclaim`, a tax or reflection switched on later, fees past a max-tx, tokens sent straight to the vault |
| `Scenario.t.sol` | Whole flows: the e2e numbers (1,094 / 900 / 6), a Radbro-holder winner at 1.5%, many matches then everyone leaves |
| `invariant/` | I1-I9 of docs/WAGER.md §9.1 on a token that switches on a pause, a blacklist and a sender tax, with a handler for players, session keys, owner, rotating referees, the house, the token's owner and a stranger (about 5 locks, 2 settles and 1-2 voids per run; one lock in three is defective and must fail) |
| `Gas.t.sol` | The §3.10 targets as whole transactions |
| `DeployScript.t.sol` | The deploy script, including its mainnet refusal |

`test/wager-contracts.test.ts` (run by `npm test`) checks what doesn't need Foundry: the generated ABI module against
the build (when there is one), the Solidity EIP-712 vectors against `eip712.ts`, and the deploy tool's helpers.

Gas (whole transactions, forge's default isolated mode; `snapshots/GameVault.json`):

| Call | Gas | Target |
|---|---|---|
| `deposit` (a player's first) | 70k | 90k |
| `openSession` (a player's first) | 85k | 90k |
| `lock` (session keys, first lock of each session) | 219k | 220k |
| `lock` (session keys, later) | 184k | 220k |
| `settle` (win) | 63k (80k for the vault's first fee) | 90k |

The same numbers come back as receipts from anvil (`wager:deploy --smoke`). On Robinhood Chain the L1 data fee is
added on top.

Static analysis: Slither 0.11 reports no findings on `src/` beyond informational ones (block.timestamp comparisons,
which the design requires; the frozen interface's parameter names; ignored `tryRecover` error arguments).

## The ABI the client imports

`src/wager/vaultAbi.ts` is generated from the build. Regenerate it after any change to `GameVault.sol`:

```sh
npm run wager:deploy -- --abi          # write it
npm run wager:deploy -- --abi-check    # fail if it differs from the build
```

## Deploying (docs/WAGER.md §11)

`tools/wager-deploy.ts` drives `script/Deploy.s.sol`. Keys never go on a command line: forge gets the deployer's key
through its environment, and the referee's key only becomes an address.

```sh
# Local anvil (chain 31337). anvil's public dev keys: deployer/owner #0, players #1 #2 (session keys #3 #4),
# faucet #6, house #7, referee #8, relayer #9. On a fresh anvil the token is 0x5FbD..0aa3 and the vault 0xe7f1..0512.
npm run wager:deploy -- --net local [--rpc http://127.0.0.1:5401] [--smoke] [--out <file>]

# Robinhood Chain Testnet: make the 0600 key file once, fund the deployer with test ETH by hand, then deploy.
npm run wager:deploy -- --net rh-testnet --init-keys
npm run wager:deploy -- --net rh-testnet --fork-only      # rehearsal on an anvil fork, nothing sent
npm run wager:deploy -- --net rh-testnet                  # rehearsal, deploy, verify, write deployments.json

# Robinhood Chain mainnet, with the owner's own coin. Without --send-it this is a dry run on a mainnet fork: the
# token probe, the forge script and a whole match. --send-it is for the owner's explicit go-ahead only.
npm run wager:deploy -- --net rh-mainnet --token <coin> --house <address> --owner <address> \
  --max-stake <tokens> --max-balance <tokens> [--fee-bps 300] [--holder-fee-bps 150] [--settle-window 86400] [--send-it]

# Just probe a token on a fork (exact deposit/withdraw of 1 unit and 1 token, no rebasing).
npm run wager:deploy -- --probe --net rh-mainnet --token <coin> [--holder <address holding it>]
```

Every run against a real network first rehearses on an anvil fork (`--fork-port`, default 8546) with dev keys: it
probes the token, runs the forge script, plays a whole match (deposit, session, lock, settle, withdraw) and checks every
balance. Source verification uses Blockscout on the testnet and Sourcify, then Blockscout, on mainnet; by hand:

```sh
forge verify-contract <vault> src/GameVault.sol:GameVault --chain <id> --constructor-args <hex> \
  --verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api/
```
