// The ABIs the relay uses: the vault's is the contracts' generated src/wager/vaultAbi.ts (the forge build of
// GameVault: every call, event and custom error, so reverts decode by name), plus the ERC-20 and ERC-721 calls for the
// token, the faucet and the Radbro reads.
import { parseAbi } from "viem";
import { gameVaultAbi } from "../../../src/wager/vaultAbi.ts";

export const VAULT_ABI = gameVaultAbi;

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
/** The creator cancelled the id before any lock: it can never lock. */
export const MS_CANCELLED = 4;
