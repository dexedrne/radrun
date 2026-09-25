// Round 4 billboard art: painted ad textures (public/textures/billboards/<id>.webp, 7:3) used as decor.json
// materials, so ?editor=decor can swap a board's materialId to any of them. Every district's decor.json
// carries all eight materials; DISTRICT_ADS picks the four its generated billboards start with.
import type { GameObject, PrefabMaterial } from "react-three-game";
import type { DistrictId } from "./districts.ts";

export const AD_IDS = ["wagmi", "ngmi", "hodl", "gm", "wenmoon", "rugs", "nothing", "buyhigh"] as const;
export type AdId = (typeof AD_IDS)[number];

const AD_NAME: Record<AdId, string> = {
  wagmi: "WAGMI", ngmi: "NGMI", hodl: "HODL", gm: "gm", wenmoon: "WEN MOON?", rugs: "RUGS 50% OFF", nothing: "probably nothing", buyhigh: "BUY HIGH. SELL LOW.",
};

export const DISTRICT_ADS: Readonly<Record<DistrictId, readonly AdId[]>> = {
  downtown: ["wagmi", "hodl", "gm", "rugs"],
  market: ["ngmi", "wenmoon", "nothing", "buyhigh"],
  docks: ["gm", "buyhigh", "wagmi", "wenmoon"],
  towers: ["rugs", "ngmi", "hodl", "nothing"],
  vertigo: ["wenmoon", "buyhigh", "gm", "ngmi"],
};

export const adMaterialId = (id: AdId): string => `ad_${id}`;

/** The eight ad materials (unlit, so the paint reads the same in every district's light). */
export function adMaterials(): Record<string, PrefabMaterial> {
  const out: Record<string, PrefabMaterial> = {};
  for (const id of AD_IDS) {
    out[adMaterialId(id)] = { name: `billboard ${AD_NAME[id]}`, color: "#ffffff", texture: `/textures/billboards/${id}.webp`, materialType: "basic" };
  }
  return out;
}

/** A billboard's face: a thin unit box in front of its backing board (the +Z face shows the whole ad). */
export function adFace(id: string, ad: AdId): GameObject {
  return {
    id,
    components: {
      transform: { type: "Transform", properties: { position: [0, 4.7, 0.13], scale: [7, 3, 0.04] } },
      geometry: { type: "Geometry", properties: { geometryType: "box", args: [1, 1, 1] } },
      material: { type: "Material", properties: { materialId: adMaterialId(ad) } },
      mesh: { type: "Mesh", properties: { castShadow: false, receiveShadow: false } },
      data: { type: "Data", properties: { data: { kind: "ad" } } },
    },
  };
}
