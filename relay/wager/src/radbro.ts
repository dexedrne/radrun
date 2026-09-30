// Radbro holder reads (docs/WAGER.md §4.6): Ethereum mainnet, public RPCs only, no keys, for the address a player
// proved at login. Holder = a V2 or V1 balance; owned ids = V2 tokensOfOwner; "own Radbro" = V2 ownerOf (owner, never
// the ERC-4907 renter). Answers are cached (10 min by default, 60 s for the fee discount at signing), and any RPC
// failure means "not a holder": no perk, no error. Perks never touch the sim.
import { createPublicClient, fallback, http, type Address, type PublicClient } from "viem";
import { RADBRO_ABI } from "./abi.ts";
import type { Sql } from "./base.ts";

export type HolderInfo = { holder: boolean; ids: number[] };

/** Where the answers come from: Ethereum mainnet through viem, or a DEV mock collection. */
export interface RadbroSource {
  balance(owner: Address): Promise<{ v2: bigint; v1: bigint }>;
  tokensOfOwner(owner: Address): Promise<number[]>;
  ownerOf(id: number): Promise<Address | null>;
}

export class ViemRadbroSource implements RadbroSource {
  private readonly c: PublicClient;
  private readonly v2: Address;
  private readonly v1: Address;
  constructor(o: { rpcUrls: string[]; v2: Address; v1: Address }) {
    const t = o.rpcUrls.map(u => http(u, { timeout: 6_000, retryCount: 0 }));
    this.c = createPublicClient({ transport: t.length === 1 ? t[0] : fallback(t) }) as PublicClient;
    this.v2 = o.v2;
    this.v1 = o.v1;
  }
  async balance(owner: Address): Promise<{ v2: bigint; v1: bigint }> {
    const [v2, v1] = await Promise.all([
      this.c.readContract({ address: this.v2, abi: RADBRO_ABI, functionName: "balanceOf", args: [owner] }),
      this.c.readContract({ address: this.v1, abi: RADBRO_ABI, functionName: "balanceOf", args: [owner] }).catch(() => 0n),
    ]);
    return { v2, v1 };
  }
  async tokensOfOwner(owner: Address): Promise<number[]> {
    const ids = await this.c.readContract({ address: this.v2, abi: RADBRO_ABI, functionName: "tokensOfOwner", args: [owner] });
    return ids.slice(0, 50).map(Number);
  }
  async ownerOf(id: number): Promise<Address | null> {
    try {
      return await this.c.readContract({ address: this.v2, abi: RADBRO_ABI, functionName: "ownerOf", args: [BigInt(id)] });
    } catch {
      return null;
    }
  }
}

/** DEV_RADBRO_HOLDERS: a fixed collection for local tests (address -> V2 ids; an empty list = a V1-only holder). */
export class MockRadbroSource implements RadbroSource {
  private readonly holders: Map<string, number[]>;
  constructor(holders: Map<string, number[]>) {
    this.holders = holders;
  }
  async balance(owner: Address) {
    const ids = this.holders.get(owner.toLowerCase());
    return { v2: BigInt(ids?.length ?? 0), v1: ids && ids.length === 0 ? 1n : 0n };
  }
  async tokensOfOwner(owner: Address) {
    return (this.holders.get(owner.toLowerCase()) ?? []).slice(0, 50);
  }
  async ownerOf(id: number) {
    for (const [a, ids] of this.holders) if (ids.includes(id)) return a as Address;
    return null;
  }
}

/** Cached holder lookups. The lobby persists its cache (radbro_cache); rooms keep theirs in memory. */
export class RadbroReader {
  private readonly src: RadbroSource;
  private readonly now: () => number;
  private readonly cacheMs: number;
  private readonly sql: Sql | null;
  private readonly mem = new Map<string, { at: number; v: HolderInfo }>();
  private readonly inflight = new Map<string, Promise<HolderInfo>>();

  constructor(o: { src: RadbroSource; now: () => number; cacheMs: number; sql?: Sql | null }) {
    this.src = o.src;
    this.now = o.now;
    this.cacheMs = o.cacheMs;
    this.sql = o.sql ?? null;
    this.sql?.exec("CREATE TABLE IF NOT EXISTS radbro_cache (address TEXT PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL)");
  }

  private cached(k: string): { at: number; v: HolderInfo } | null {
    const m = this.mem.get(k);
    if (m) return m;
    const row = this.sql?.exec("SELECT json, at FROM radbro_cache WHERE address = ?", k)[0];
    if (!row) return null;
    const v = { at: Number(row.at), v: JSON.parse(String(row.json)) as HolderInfo };
    this.mem.set(k, v);
    return v;
  }

  /** Holder status and owned V2 ids of a proven address, at most `maxAgeMs` old. Failures: not a holder. */
  holder(a: Address, maxAgeMs = this.cacheMs): Promise<HolderInfo> {
    const k = a.toLowerCase();
    const c = this.cached(k);
    if (c && this.now() - c.at <= maxAgeMs) return Promise.resolve(c.v);
    let p = this.inflight.get(k);
    if (!p) {
      p = (async () => {
        let v: HolderInfo;
        try {
          const b = await this.src.balance(a);
          const ids = b.v2 > 0n ? await this.src.tokensOfOwner(a).catch(() => []) : [];
          v = { holder: b.v2 > 0n || b.v1 > 0n, ids };
        } catch {
          // Every RPC failed: no perk, no error, and no caching of the failure.
          return { holder: false, ids: [] };
        }
        const at = this.now();
        this.mem.set(k, { at, v });
        this.sql?.exec("INSERT OR REPLACE INTO radbro_cache (address, json, at) VALUES (?, ?, ?)", k, JSON.stringify(v), at);
        return v;
      })().finally(() => this.inflight.delete(k));
      this.inflight.set(k, p);
    }
    return p;
  }

  /** Does `a` own Radbro V2 #id right now (ownerOf; a rental never counts)? */
  async owns(a: Address, id: number): Promise<boolean> {
    if (!Number.isInteger(id) || id < 0 || id > 1_000_000) return false;
    try {
      const o = await this.src.ownerOf(id);
      return !!o && o.toLowerCase() === a.toLowerCase();
    } catch {
      return false;
    }
  }
}
