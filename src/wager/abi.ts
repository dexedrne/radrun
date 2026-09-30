// SPIDER-TAG wager: the GameVault ABI the client and the tools call through viem. The IGameVault part is generated from
// the frozen interface (contracts/src/interfaces/IGameVault.sol) with
//   cd contracts && forge inspect src/interfaces/IGameVault.sol:IGameVault abi --json
// (internalType kept only for structs and enums); test/wager-client.test.ts checks it against the .sol signatures.
// OpenZeppelin adds owner / pendingOwner / paused and its errors (Ownable2Step, Pausable, ReentrancyGuard, SafeERC20).
// Pure data; no DOM.

export const IGAME_VAULT_ABI = [
  {"type":"function","name":"MAX_FEE_BPS","inputs":[],"outputs":[{"name":"","type":"uint16"}],"stateMutability":"view"},
  {"type":"function","name":"MAX_SESSION_TTL","inputs":[],"outputs":[{"name":"","type":"uint64"}],"stateMutability":"view"},
  {"type":"function","name":"deposit","inputs":[{"name":"amount","type":"uint256"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"depositFor","inputs":[{"name":"player","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"freeOf","inputs":[{"name":"player","type":"address"}],"outputs":[{"name":"","type":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"hashEntry","inputs":[{"name":"e","type":"tuple","internalType":"struct IGameVault.Entry","components":[{"name":"matchId","type":"bytes32"},{"name":"player","type":"address"},{"name":"opponent","type":"address"},{"name":"stake","type":"uint128"},{"name":"feeCapBps","type":"uint16"},{"name":"roundSeconds","type":"uint16"},{"name":"rules","type":"bytes32"},{"name":"deadline","type":"uint64"}]}],"outputs":[{"name":"","type":"bytes32"}],"stateMutability":"view"},
  {"type":"function","name":"hashResult","inputs":[{"name":"r","type":"tuple","internalType":"struct IGameVault.Result","components":[{"name":"matchId","type":"bytes32"},{"name":"outcome","type":"uint8"},{"name":"winner","type":"address"},{"name":"feeBps","type":"uint16"},{"name":"logHash","type":"bytes32"}]}],"outputs":[{"name":"","type":"bytes32"}],"stateMutability":"view"},
  {"type":"function","name":"hashSessionAuth","inputs":[{"name":"auth","type":"tuple","internalType":"struct IGameVault.SessionAuth","components":[{"name":"player","type":"address"},{"name":"sessionKey","type":"address"},{"name":"maxStake","type":"uint128"},{"name":"cap","type":"uint128"},{"name":"expiry","type":"uint64"},{"name":"nonce","type":"uint64"}]}],"outputs":[{"name":"","type":"bytes32"}],"stateMutability":"view"},
  {"type":"function","name":"holderFeeBps","inputs":[],"outputs":[{"name":"","type":"uint16"}],"stateMutability":"view"},
  {"type":"function","name":"house","inputs":[],"outputs":[{"name":"","type":"address"}],"stateMutability":"view"},
  {"type":"function","name":"houseAccrued","inputs":[],"outputs":[{"name":"","type":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"houseFeeBps","inputs":[],"outputs":[{"name":"","type":"uint16"}],"stateMutability":"view"},
  {"type":"function","name":"lock","inputs":[{"name":"a","type":"tuple","internalType":"struct IGameVault.Entry","components":[{"name":"matchId","type":"bytes32"},{"name":"player","type":"address"},{"name":"opponent","type":"address"},{"name":"stake","type":"uint128"},{"name":"feeCapBps","type":"uint16"},{"name":"roundSeconds","type":"uint16"},{"name":"rules","type":"bytes32"},{"name":"deadline","type":"uint64"}]},{"name":"sigA","type":"bytes"},{"name":"b","type":"tuple","internalType":"struct IGameVault.Entry","components":[{"name":"matchId","type":"bytes32"},{"name":"player","type":"address"},{"name":"opponent","type":"address"},{"name":"stake","type":"uint128"},{"name":"feeCapBps","type":"uint16"},{"name":"roundSeconds","type":"uint16"},{"name":"rules","type":"bytes32"},{"name":"deadline","type":"uint64"}]},{"name":"sigB","type":"bytes"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"lockedOf","inputs":[{"name":"player","type":"address"}],"outputs":[{"name":"","type":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"matchOf","inputs":[{"name":"matchId","type":"bytes32"}],"outputs":[{"name":"","type":"tuple","internalType":"struct IGameVault.Match","components":[{"name":"playerA","type":"address"},{"name":"feeBps","type":"uint16"},{"name":"holderFeeBps","type":"uint16"},{"name":"roundSeconds","type":"uint16"},{"name":"state","type":"uint8","internalType":"enum IGameVault.MatchState"},{"name":"playerB","type":"address"},{"name":"lockedAt","type":"uint64"},{"name":"stake","type":"uint128"},{"name":"settleBy","type":"uint64"},{"name":"rules","type":"bytes32"}]}],"stateMutability":"view"},
  {"type":"function","name":"maxBalance","inputs":[],"outputs":[{"name":"","type":"uint128"}],"stateMutability":"view"},
  {"type":"function","name":"maxStake","inputs":[],"outputs":[{"name":"","type":"uint128"}],"stateMutability":"view"},
  {"type":"function","name":"openSession","inputs":[{"name":"auth","type":"tuple","internalType":"struct IGameVault.SessionAuth","components":[{"name":"player","type":"address"},{"name":"sessionKey","type":"address"},{"name":"maxStake","type":"uint128"},{"name":"cap","type":"uint128"},{"name":"expiry","type":"uint64"},{"name":"nonce","type":"uint64"}]},{"name":"walletSig","type":"bytes"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"pause","inputs":[],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"referee","inputs":[],"outputs":[{"name":"","type":"address"}],"stateMutability":"view"},
  {"type":"function","name":"refundExpired","inputs":[{"name":"matchId","type":"bytes32"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"revokeSession","inputs":[],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"sessionNonce","inputs":[{"name":"player","type":"address"}],"outputs":[{"name":"","type":"uint64"}],"stateMutability":"view"},
  {"type":"function","name":"sessionOf","inputs":[{"name":"player","type":"address"}],"outputs":[{"name":"","type":"tuple","internalType":"struct IGameVault.Session","components":[{"name":"key","type":"address"},{"name":"expiry","type":"uint64"},{"name":"maxStake","type":"uint128"},{"name":"cap","type":"uint128"},{"name":"used","type":"uint128"}]}],"stateMutability":"view"},
  {"type":"function","name":"setCaps","inputs":[{"name":"maxStake","type":"uint128"},{"name":"maxBalance","type":"uint128"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"setHouseFees","inputs":[{"name":"feeBps","type":"uint16"},{"name":"holderFeeBps","type":"uint16"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"setReferee","inputs":[{"name":"referee","type":"address"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"settle","inputs":[{"name":"r","type":"tuple","internalType":"struct IGameVault.Result","components":[{"name":"matchId","type":"bytes32"},{"name":"outcome","type":"uint8"},{"name":"winner","type":"address"},{"name":"feeBps","type":"uint16"},{"name":"logHash","type":"bytes32"}]},{"name":"refereeSig","type":"bytes"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"settleMutual","inputs":[{"name":"r","type":"tuple","internalType":"struct IGameVault.Result","components":[{"name":"matchId","type":"bytes32"},{"name":"outcome","type":"uint8"},{"name":"winner","type":"address"},{"name":"feeBps","type":"uint16"},{"name":"logHash","type":"bytes32"}]},{"name":"sigA","type":"bytes"},{"name":"sigB","type":"bytes"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"settleWindow","inputs":[],"outputs":[{"name":"","type":"uint32"}],"stateMutability":"view"},
  {"type":"function","name":"token","inputs":[],"outputs":[{"name":"","type":"address"}],"stateMutability":"view"},
  {"type":"function","name":"totalLiabilities","inputs":[],"outputs":[{"name":"","type":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"unpause","inputs":[],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"withdraw","inputs":[{"name":"amount","type":"uint256"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"withdrawHouse","inputs":[],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"withdrawTo","inputs":[{"name":"amount","type":"uint256"},{"name":"to","type":"address"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"event","name":"CapsSet","inputs":[{"name":"maxStake","type":"uint128","indexed":false},{"name":"maxBalance","type":"uint128","indexed":false}],"anonymous":false},
  {"type":"event","name":"Deposited","inputs":[{"name":"player","type":"address","indexed":true},{"name":"from","type":"address","indexed":true},{"name":"amount","type":"uint256","indexed":false}],"anonymous":false},
  {"type":"event","name":"HouseFeesSet","inputs":[{"name":"feeBps","type":"uint16","indexed":false},{"name":"holderFeeBps","type":"uint16","indexed":false}],"anonymous":false},
  {"type":"event","name":"HouseWithdrawn","inputs":[{"name":"house","type":"address","indexed":true},{"name":"amount","type":"uint256","indexed":false}],"anonymous":false},
  {"type":"event","name":"MatchLocked","inputs":[{"name":"matchId","type":"bytes32","indexed":true},{"name":"playerA","type":"address","indexed":true},{"name":"playerB","type":"address","indexed":true},{"name":"stake","type":"uint128","indexed":false},{"name":"feeBps","type":"uint16","indexed":false},{"name":"holderFeeBps","type":"uint16","indexed":false},{"name":"roundSeconds","type":"uint16","indexed":false},{"name":"rules","type":"bytes32","indexed":false},{"name":"settleBy","type":"uint64","indexed":false}],"anonymous":false},
  {"type":"event","name":"MatchSettled","inputs":[{"name":"matchId","type":"bytes32","indexed":true},{"name":"winner","type":"address","indexed":true},{"name":"loser","type":"address","indexed":true},{"name":"payout","type":"uint256","indexed":false},{"name":"fee","type":"uint256","indexed":false},{"name":"feeBps","type":"uint16","indexed":false},{"name":"logHash","type":"bytes32","indexed":false},{"name":"mutual","type":"bool","indexed":false}],"anonymous":false},
  {"type":"event","name":"MatchVoided","inputs":[{"name":"matchId","type":"bytes32","indexed":true},{"name":"playerA","type":"address","indexed":true},{"name":"playerB","type":"address","indexed":true},{"name":"reason","type":"uint8","indexed":false},{"name":"logHash","type":"bytes32","indexed":false}],"anonymous":false},
  {"type":"event","name":"RefereeSet","inputs":[{"name":"referee","type":"address","indexed":true}],"anonymous":false},
  {"type":"event","name":"SessionOpened","inputs":[{"name":"player","type":"address","indexed":true},{"name":"sessionKey","type":"address","indexed":true},{"name":"maxStake","type":"uint128","indexed":false},{"name":"cap","type":"uint128","indexed":false},{"name":"expiry","type":"uint64","indexed":false},{"name":"nonce","type":"uint64","indexed":false}],"anonymous":false},
  {"type":"event","name":"SessionRevoked","inputs":[{"name":"player","type":"address","indexed":true},{"name":"nonce","type":"uint64","indexed":false}],"anonymous":false},
  {"type":"event","name":"Withdrawn","inputs":[{"name":"player","type":"address","indexed":true},{"name":"to","type":"address","indexed":true},{"name":"amount","type":"uint256","indexed":false}],"anonymous":false},
  {"type":"error","name":"BadConfig","inputs":[]},
  {"type":"error","name":"BadNonce","inputs":[{"name":"expected","type":"uint64"},{"name":"got","type":"uint64"}]},
  {"type":"error","name":"BadResult","inputs":[]},
  {"type":"error","name":"BadSession","inputs":[]},
  {"type":"error","name":"BadSignature","inputs":[{"name":"expectedSigner","type":"address"}]},
  {"type":"error","name":"BalanceCapExceeded","inputs":[{"name":"player","type":"address"},{"name":"cap","type":"uint256"}]},
  {"type":"error","name":"EntryExpired","inputs":[{"name":"player","type":"address"},{"name":"deadline","type":"uint64"}]},
  {"type":"error","name":"EntryMismatch","inputs":[]},
  {"type":"error","name":"FeeTooHigh","inputs":[{"name":"feeBps","type":"uint16"}]},
  {"type":"error","name":"Insolvent","inputs":[{"name":"balance","type":"uint256"},{"name":"liabilities","type":"uint256"}]},
  {"type":"error","name":"InsufficientFree","inputs":[{"name":"player","type":"address"},{"name":"free","type":"uint256"},{"name":"needed","type":"uint256"}]},
  {"type":"error","name":"MatchExists","inputs":[{"name":"matchId","type":"bytes32"}]},
  {"type":"error","name":"NotLocked","inputs":[{"name":"matchId","type":"bytes32"}]},
  {"type":"error","name":"SessionLimit","inputs":[{"name":"player","type":"address"}]},
  {"type":"error","name":"SettleWindowClosed","inputs":[{"name":"matchId","type":"bytes32"},{"name":"settleBy","type":"uint64"}]},
  {"type":"error","name":"SettleWindowOpen","inputs":[{"name":"matchId","type":"bytes32"},{"name":"settleBy","type":"uint64"}]},
  {"type":"error","name":"StakeOutOfRange","inputs":[{"name":"stake","type":"uint256"},{"name":"maxStake","type":"uint256"}]},
  {"type":"error","name":"TransferMismatch","inputs":[{"name":"expected","type":"uint256"},{"name":"received","type":"uint256"}]},
  {"type":"error","name":"ZeroAddress","inputs":[]},
  {"type":"error","name":"ZeroAmount","inputs":[]},
] as const;

/** OpenZeppelin 5.6 pieces of GameVault that are not in IGameVault (owner reads for the review page, error names). */
export const VAULT_OZ_ABI = [
  { type: "function", name: "owner", inputs: [], outputs: [{ name: "", type: "address" }], stateMutability: "view" },
  { type: "function", name: "pendingOwner", inputs: [], outputs: [{ name: "", type: "address" }], stateMutability: "view" },
  { type: "function", name: "paused", inputs: [], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
  { type: "event", name: "Paused", inputs: [{ name: "account", type: "address", indexed: false }], anonymous: false },
  { type: "event", name: "Unpaused", inputs: [{ name: "account", type: "address", indexed: false }], anonymous: false },
  { type: "error", name: "EnforcedPause", inputs: [] },
  { type: "error", name: "ExpectedPause", inputs: [] },
  { type: "error", name: "OwnableUnauthorizedAccount", inputs: [{ name: "account", type: "address" }] },
  { type: "error", name: "OwnableInvalidOwner", inputs: [{ name: "owner", type: "address" }] },
  { type: "error", name: "ReentrancyGuardReentrantCall", inputs: [] },
  { type: "error", name: "SafeERC20FailedOperation", inputs: [{ name: "token", type: "address" }] },
] as const;

export const GAME_VAULT_ABI = [...IGAME_VAULT_ABI, ...VAULT_OZ_ABI] as const;

/** The ERC-20 calls the client makes (and OpenZeppelin 5 ERC-20 errors, for plain messages). */
export const ERC20_ABI = [
  { type: "function", name: "name", inputs: [], outputs: [{ name: "", type: "string" }], stateMutability: "view" },
  { type: "function", name: "symbol", inputs: [], outputs: [{ name: "", type: "string" }], stateMutability: "view" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ name: "", type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "allowance", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "transfer", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" },
  { type: "event", name: "Transfer", inputs: [{ name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "value", type: "uint256", indexed: false }], anonymous: false },
  { type: "error", name: "ERC20InsufficientBalance", inputs: [{ name: "sender", type: "address" }, { name: "balance", type: "uint256" }, { name: "needed", type: "uint256" }] },
  { type: "error", name: "ERC20InsufficientAllowance", inputs: [{ name: "spender", type: "address" }, { name: "allowance", type: "uint256" }, { name: "needed", type: "uint256" }] },
  { type: "error", name: "ERC20InvalidSender", inputs: [{ name: "sender", type: "address" }] },
  { type: "error", name: "ERC20InvalidReceiver", inputs: [{ name: "receiver", type: "address" }] },
  { type: "error", name: "ERC20InvalidApprover", inputs: [{ name: "approver", type: "address" }] },
  { type: "error", name: "ERC20InvalidSpender", inputs: [{ name: "spender", type: "address" }] },
] as const;

/** For simulating vault calls: the token's errors bubble up through SafeERC20 (a deposit short of allowance). */
export const VAULT_CALL_ABI = [...GAME_VAULT_ABI, ...ERC20_ABI.filter(e => e.type === "error")] as const;
