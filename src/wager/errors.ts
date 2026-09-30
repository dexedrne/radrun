// SPIDER-TAG wager client: every failure as one plain sentence and a kind the page can act on (docs/WAGER.md §7.3:
// wrong chain, not enough tokens, allowance, a rejected signature, the relay down, a dispute, region blocked). Viem's
// errors are walked for the wallet's code and the contract's custom error name. Pure TS; no DOM.
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";

export type WagerErrorKind =
  | "rejected" // the player said no in the wallet
  | "wrong-chain"
  | "no-wallet"
  | "funds" // not enough tokens (wallet or vault)
  | "gas" // not enough ETH for gas
  | "allowance"
  | "relay" // the wager relay can't be reached
  | "region"
  | "version" // reload to update
  | "session"
  | "paused"
  | "contract" // any other revert
  | "network"
  | "unknown";

export type WagerError = { kind: WagerErrorKind; message: string };

/** The vault's and the token's custom errors, as the page says them. */
const REVERTS: Record<string, [WagerErrorKind, string]> = {
  ZeroAddress: ["contract", "an address was empty"],
  ZeroAmount: ["contract", "the amount must be above zero"],
  TransferMismatch: ["contract", "the token moved a different amount than asked (a transfer tax or a rebase): deposits are refused while it does; to withdraw, take out a little less than everything (the tax comes out of your own balance)"],
  BalanceCapExceeded: ["contract", "that would take your vault balance past the beta cap"],
  InsufficientFree: ["funds", "not enough free balance in the vault"],
  BadSignature: ["session", "a signature didn't check out (an expired or replaced session key?)"],
  BadNonce: ["session", "that authorisation is out of date: sign a new one"],
  BadSession: ["session", "the session limits were refused (stake, total or expiry)"],
  SessionLimit: ["session", "your session key's limits don't cover this stake"],
  MatchExists: ["contract", "that match is already locked"],
  EntryMismatch: ["contract", "the two entries don't match"],
  EntryExpired: ["contract", "an entry expired before the lock"],
  StakeOutOfRange: ["contract", "that stake is outside the vault's limits"],
  FeeTooHigh: ["contract", "that fee is above the limit"],
  NotLocked: ["contract", "that match isn't locked (already settled or refunded?)"],
  SettleWindowClosed: ["contract", "the settle window has closed: anyone can refund the match now"],
  SettleWindowOpen: ["contract", "the settle window is still open: a refund is possible only after it"],
  BadResult: ["contract", "the result was refused"],
  Insolvent: ["contract", "the vault holds less than it owes (a rebasing token?), so new matches are refused"],
  BadConfig: ["contract", "bad vault settings"],
  EnforcedPause: ["paused", "the vault is paused for new deposits and matches (withdrawals always work)"],
  BadMatchId: ["contract", "that match id belongs to another player (only its creator can open or cancel it)"],
  FeeAboveCap: ["version", "the house fee changed since this was signed: reload to update"],
  NothingToReclaim: ["contract", "there's no stake of yours left in that match"],
  NotHouse: ["contract", "only the house can do that"],
  SurplusExceeded: ["contract", "that's more than the vault holds beyond what it owes"],
  RenounceDisabled: ["contract", "the vault always keeps an owner"],
  ERC20InsufficientBalance: ["funds", "not enough tokens in your wallet"],
  ERC20InsufficientAllowance: ["allowance", "the vault isn't approved for that amount yet"],
  SafeERC20FailedOperation: ["contract", "the token refused the transfer (locked, limited or blocked right now?)"],
};

type Walkable = { code?: unknown; name?: unknown; message?: unknown; shortMessage?: unknown; cause?: unknown; data?: unknown };

function codes(e: unknown): number[] {
  const out: number[] = [];
  let cur = e as Walkable | undefined;
  for (let i = 0; cur && i < 8; i++) {
    if (typeof cur.code === "number") out.push(cur.code);
    const d = cur.data as { originalError?: { code?: unknown } } | undefined;
    if (d && typeof d.originalError?.code === "number") out.push(d.originalError.code);
    cur = cur.cause as Walkable | undefined;
  }
  return out;
}

/** The wallet said the chain isn't added (EIP-3085 / MetaMask 4902, sometimes wrapped in -32603). */
export const isUnknownChain = (e: unknown): boolean => codes(e).includes(4902) || /unrecognized chain|unknown chain|chain .*not.* added/i.test(String((e as Walkable)?.message ?? ""));

export function classifyError(e: unknown): WagerError {
  if (e && typeof e === "object" && "kind" in e && "message" in e && typeof (e as WagerError).message === "string") return e as WagerError;
  const cs = codes(e);
  const msg = String((e as Walkable)?.shortMessage ?? (e as Walkable)?.message ?? e ?? "");
  if (cs.includes(4001) || e instanceof UserRejectedRequestError || (e instanceof BaseError && e.walk(x => x instanceof UserRejectedRequestError)) || /user (rejected|denied)|rejected the request/i.test(msg)) {
    return { kind: "rejected", message: "you cancelled it in the wallet" };
  }
  if (e instanceof BaseError) {
    const rev = e.walk(x => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = rev?.data?.errorName;
    if (name && REVERTS[name]) return { kind: REVERTS[name][0], message: REVERTS[name][1] };
    if (rev) return { kind: "contract", message: rev.reason ? `the contract refused it: ${rev.reason}` : "the contract refused it" };
  }
  if (/insufficient funds/i.test(msg)) return { kind: "gas", message: "not enough ETH in your wallet for the network fee" };
  if (cs.includes(4902) || /chain.*mismatch|does not match the target chain|wrong network/i.test(msg)) return { kind: "wrong-chain", message: "your wallet is on another network" };
  if (/failed to fetch|network ?error|fetch failed|timed? ?out|HTTP request failed/i.test(msg)) return { kind: "network", message: "the network didn't answer: try again in a moment" };
  return { kind: "unknown", message: msg.split("\n")[0].slice(0, 200) || "something went wrong" };
}

export const errorText = (e: unknown): string => classifyError(e).message;

export const wagerError = (kind: WagerErrorKind, message: string): WagerError => ({ kind, message });
