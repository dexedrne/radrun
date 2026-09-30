// The GameVault ABI the relay uses, from the frozen interface (contracts/src/interfaces/IGameVault.sol), plus the
// ERC-20 and ERC-721 calls for the token, the faucet and the Radbro reads. Human-readable so no build artifact is needed.
import { parseAbi } from "viem";

export const VAULT_ABI = parseAbi([
  "struct SessionAuth { address player; address sessionKey; uint128 maxStake; uint128 cap; uint64 expiry; uint64 nonce; }",
  "struct Entry { bytes32 matchId; address player; address opponent; uint128 stake; uint16 feeCapBps; uint16 roundSeconds; bytes32 rules; uint64 deadline; }",
  "struct Result { bytes32 matchId; uint8 outcome; address winner; uint16 feeBps; bytes32 logHash; }",
  "struct Session { address key; uint64 expiry; uint128 maxStake; uint128 cap; uint128 used; }",
  "struct Match { address playerA; uint16 feeBps; uint16 holderFeeBps; uint16 roundSeconds; uint8 state; address playerB; uint64 lockedAt; uint128 stake; uint64 settleBy; bytes32 rules; }",
  "function openSession(SessionAuth auth, bytes walletSig)",
  "function lock(Entry a, bytes sigA, Entry b, bytes sigB)",
  "function settle(Result r, bytes refereeSig)",
  "function refundExpired(bytes32 matchId)",
  "function token() view returns (address)",
  "function house() view returns (address)",
  "function referee() view returns (address)",
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function houseFeeBps() view returns (uint16)",
  "function holderFeeBps() view returns (uint16)",
  "function maxStake() view returns (uint128)",
  "function maxBalance() view returns (uint128)",
  "function settleWindow() view returns (uint32)",
  "function freeOf(address player) view returns (uint256)",
  "function lockedOf(address player) view returns (uint256)",
  "function sessionOf(address player) view returns (Session)",
  "function sessionNonce(address player) view returns (uint64)",
  "function matchOf(bytes32 matchId) view returns (Match)",
  "event MatchSettled(bytes32 indexed matchId, address indexed winner, address indexed loser, uint256 payout, uint256 fee, uint16 feeBps, bytes32 logHash, bool mutual)",
  "event MatchVoided(bytes32 indexed matchId, address indexed playerA, address indexed playerB, uint8 reason, bytes32 logHash)",
  "error ZeroAddress()",
  "error ZeroAmount()",
  "error TransferMismatch(uint256 expected, uint256 received)",
  "error BalanceCapExceeded(address player, uint256 cap)",
  "error InsufficientFree(address player, uint256 free, uint256 needed)",
  "error BadSignature(address expectedSigner)",
  "error BadNonce(uint64 expected, uint64 got)",
  "error BadSession()",
  "error SessionLimit(address player)",
  "error MatchExists(bytes32 matchId)",
  "error EntryMismatch()",
  "error EntryExpired(address player, uint64 deadline)",
  "error StakeOutOfRange(uint256 stake, uint256 maxStake)",
  "error FeeTooHigh(uint16 feeBps)",
  "error NotLocked(bytes32 matchId)",
  "error SettleWindowClosed(bytes32 matchId, uint64 settleBy)",
  "error SettleWindowOpen(bytes32 matchId, uint64 settleBy)",
  "error BadResult()",
  "error Insolvent(uint256 balance, uint256 liabilities)",
  "error BadConfig()",
  "error EnforcedPause()",
]);

export const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

export const RADBRO_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokensOfOwner(address owner) view returns (uint256[])",
]);

/** IGameVault.MatchState */
export const MS_NONE = 0;
export const MS_LOCKED = 1;
export const MS_SETTLED = 2;
export const MS_VOIDED = 3;
