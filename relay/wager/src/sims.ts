// The referee's sims: each allowed district's city model and the shared tuning.json, the sim identity (simCompat,
// simId, the rules hash Entries must carry) and the startup self-test (docs/WAGER.md §4.1, §5.2). The level files come
// from the runtime: bundled JSON in the Worker (levels.ts), the repo's public/levels in Node.
import type { Hex } from "viem";
import { applyTuningJson, type Tuning, type TuningJson } from "../../../src/sim/tuning.ts";
import { CityIndex, type CityModel } from "../../../src/world/cityModel.ts";
import { TAG, type TagTable } from "../../../src/game/tagMatch.ts";
import { SELFTEST_HASH, selfTestHash } from "../../../src/net/selftest.ts";
import { makeRules, rulesHash, simId, type Rules, type SimCompat } from "../../../src/wager/eip712.ts";
import { simCompat, type SimAssets } from "../../../src/wager/replay.ts";

export type LevelFiles = {
  /** public/levels/tuning.json (parsed). */
  tuning(): Promise<unknown>;
  /** The district's city.model.json (parsed). */
  model(district: string): Promise<CityModel>;
};

export type DistrictSim = {
  district: string;
  assets: SimAssets & { index: CityIndex };
  compat: SimCompat;
  simId: Hex;
  rules: Rules;
  rulesHash: Hex;
};

export class Sims {
  readonly districts: string[];
  private readonly files: LevelFiles;
  private tuning: { player: Tuning; tag: Partial<TagTable> | undefined } | null = null;
  private readonly cache = new Map<string, Promise<DistrictSim>>();
  /** The self-test result on this runtime (false: the relay refuses to referee). */
  readonly selfTestOk: boolean;
  readonly selfTest: number;

  constructor(files: LevelFiles, districts: string[]) {
    this.files = files;
    this.districts = districts;
    this.selfTest = selfTestHash() >>> 0;
    this.selfTestOk = this.selfTest === SELFTEST_HASH >>> 0;
  }

  private async tune(): Promise<{ player: Tuning; tag: Partial<TagTable> | undefined }> {
    if (!this.tuning) {
      const json = (await this.files.tuning()) as TuningJson & { tag?: Partial<TagTable> };
      // As the client does at boot: this also sets the global mechanics table the sim reads.
      this.tuning = { player: applyTuningJson(json).player, tag: json?.tag };
    }
    return this.tuning;
  }

  /** The referee's sim for an allowed district (null for any other). */
  district(id: string): Promise<DistrictSim> | null {
    if (!this.districts.includes(id)) return null;
    let p = this.cache.get(id);
    if (!p) {
      p = (async () => {
        const [t, model] = await Promise.all([this.tune(), this.files.model(id)]);
        const assets = { model, index: new CityIndex(model), tuning: t.player, tag: t.tag };
        const compat = simCompat(assets);
        const rules = makeRules(id, compat);
        return { district: id, assets, compat, simId: simId(compat), rules, rulesHash: rulesHash(rules) };
      })();
      p.catch(() => this.cache.delete(id));
      this.cache.set(id, p);
    }
    return p;
  }

  /** The allowed district whose rules hash this is (Entries commit to the district and the exact sim). */
  async byRules(rules: Hex): Promise<DistrictSim | null> {
    for (const d of this.districts) {
      const s = await this.district(d)!;
      if (s.rulesHash.toLowerCase() === rules.toLowerCase()) return s;
    }
    return null;
  }

  async compats(): Promise<Record<string, SimCompat>> {
    const out: Record<string, SimCompat> = {};
    for (const d of this.districts) out[d] = (await this.district(d)!).compat;
    return out;
  }

  /** The tag table the referee plays (tuning.json's "tag" section over the built-in one). */
  async tagTable(): Promise<TagTable> {
    return { ...TAG, ...(await this.tune()).tag };
  }
}
