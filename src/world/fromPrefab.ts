// city.json (the hand-editable r3g prefab) -> solids + manual hooks + config. Nodes are recognised by
// their Data {kind}: "roof" (landable solid), "tower" (solid, never landable), "hook" (a manual balloon
// at the node's world position), "city" (root config). Transforms compose translation and scale down the
// tree; solids must be unrotated and ground-rooted (warned and normalised if not).
import type { GameObject, Prefab } from "react-three-game";
import type { CityConfig, Solid } from "./cityModel.ts";
import type { ManualHook } from "./derive.ts";

type Xf = { px: number; py: number; pz: number; sx: number; sy: number; sz: number };

export type ReadCity = { config: CityConfig | null; solids: Solid[]; manualHooks: ManualHook[]; warnings: string[] };

function comp(node: GameObject, type: string): Record<string, unknown> | null {
  for (const c of Object.values(node.components ?? {})) if (c && c.type === type) return c.properties as Record<string, unknown>;
  return null;
}

export function readCityPrefab(prefab: Prefab): ReadCity {
  const solids: Solid[] = [];
  const manualHooks: ManualHook[] = [];
  const warnings: string[] = [];
  let config: CityConfig | null = null;
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

  const walk = (node: GameObject, parent: Xf) => {
    if (node.disabled) return;
    const t = comp(node, "Transform");
    const pos = (t?.position as number[] | undefined) ?? [0, 0, 0];
    const scl = (t?.scale as number[] | undefined) ?? [1, 1, 1];
    const rot = (t?.rotation as number[] | undefined) ?? [0, 0, 0];
    const xf: Xf = {
      px: parent.px + parent.sx * pos[0], py: parent.py + parent.sy * pos[1], pz: parent.pz + parent.sz * pos[2],
      sx: parent.sx * scl[0], sy: parent.sy * scl[1], sz: parent.sz * scl[2],
    };
    const data = (comp(node, "Data")?.data ?? null) as Record<string, unknown> | null;
    const kind = data?.kind;
    if (kind === "city" && data?.config) config = data.config as CityConfig;
    if (kind === "roof" || kind === "tower") {
      if (rot.some(r => Math.abs(r) > 1e-6)) warnings.push(`${node.id}: rotation ignored (solids are unrotated boxes)`);
      const w = Math.abs(xf.sx), h = Math.abs(xf.sy), d = Math.abs(xf.sz);
      const bottom = xf.py - h / 2;
      if (Math.abs(bottom) > 0.05) warnings.push(`${node.id}: bottom at y=${bottom.toFixed(2)}, treated as ground-rooted`);
      solids.push({
        id: solids.length,
        kind,
        landable: kind === "roof",
        x0: r6(xf.px - w / 2), x1: r6(xf.px + w / 2),
        z0: r6(xf.pz - d / 2), z1: r6(xf.pz + d / 2),
        top: r6(xf.py + h / 2),
        node: node.id,
      });
    }
    if (kind === "hook") manualHooks.push({ x: xf.px, y: xf.py, z: xf.pz });
    for (const c of node.children ?? []) walk(c, xf);
  };
  walk(prefab.root, { px: 0, py: 0, pz: 0, sx: 1, sy: 1, sz: 1 });
  return { config, solids, manualHooks, warnings };
}

/** Lint helpers for test 4: geometry signatures and batch keys (instanced meshes only). */
export function prefabBatchStats(prefab: Prefab): { nodes: number; geometrySignatures: number; batchKeys: number } {
  const sigs = new Set<string>();
  const keys = new Set<string>();
  let nodes = 0;
  const walk = (node: GameObject) => {
    nodes++;
    const g = comp(node, "Geometry");
    const m = comp(node, "Mesh");
    const mat = comp(node, "Material");
    if (g && m && m.instanced !== false) {
      const sig = `${g.geometryType}:${JSON.stringify(g.args ?? [])}`;
      sigs.add(sig);
      keys.add(`${sig}|${mat?.materialId ?? "default"}|${m.castShadow !== false}|${m.receiveShadow !== false}`);
    }
    for (const c of node.children ?? []) walk(c);
  };
  walk(prefab.root);
  return { nodes, geometrySignatures: sigs.size, batchKeys: keys.size };
}
