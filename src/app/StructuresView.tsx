// Round 12 (docs/specs/2026-09-26-round12-spider-tag.md §2.5): the structures between the buildings, drawn from
// the model (never from city.json) with instanced meshes only: cables (a sagging line of 0.12 m cylinders with a
// lighter upper edge), one box mesh for every steel part (gantry trusses, poles and signal heads, skybridge frames,
// tank legs, board frames, scaffolding / fire-escape lattices), the skybridge glass, tank bodies and roofs, and the
// board panels (the billboard art we already ship). At most 9 draw calls, nothing downloaded but one ad texture.
// Low quality never hides a structure (they are gameplay): it only drops the signal glow, the board lighting
// (panels go flat) and the cable highlights.
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  BoxGeometry, Color, ConeGeometry, CylinderGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, MeshStandardMaterial, Object3D,
  PlaneGeometry, Quaternion, SRGBColorSpace, TextureLoader, Vector3, DoubleSide,
} from "three";
import type { CityModel, Rig, Solid } from "../world/cityModel.ts";
import { rigPoint } from "../world/structures.ts";
import { lowQuality } from "./quality.tsx";
import { DISTRICT_ADS } from "../world/billboards.ts";
import type { DistrictId } from "../world/districts.ts";

/** Cable segments per cable (the sag is drawn as a polyline), radius (m). */
const SEG = 6;
const CABLE_R = 0.06;

type Palette = { steel: string; trim: string; cable: string; hi: string; glass: string; tank: string; stack: string };
const PALETTE: Record<DistrictId, Palette> = {
  downtown: { steel: "#5d6670", trim: "#7d8792", cable: "#2b3036", hi: "#aab4bf", glass: "#9fd3ff", tank: "#6a5a4a", stack: "#c9a23a" },
  towers: { steel: "#5a636e", trim: "#8a94a0", cable: "#262b31", hi: "#b8c2cc", glass: "#a8dcff", tank: "#5f6670", stack: "#c9a23a" },
  market: { steel: "#3a3346", trim: "#ff4fd8", cable: "#221c2c", hi: "#5ef3ff", glass: "#ff9be8", tank: "#4a3b56", stack: "#3c3c44" },
  docks: { steel: "#7a4a32", trim: "#a8643c", cable: "#3a2418", hi: "#c98a5a", glass: "#b9d6e0", tank: "#8a5236", stack: "#6b3f2a" },
  vertigo: { steel: "#5d6670", trim: "#8fc4c8", cable: "#2b3036", hi: "#c4e6e8", glass: "#bff0ee", tank: "#62707a", stack: "#5d6670" },
};

type Box = { x: number; y: number; z: number; sx: number; sy: number; sz: number; c: string };

/** Every box-shaped steel part of the fixtures (centre + size + colour). */
function steelBoxes(solids: Solid[], pal: Palette): { boxes: Box[]; glass: Box[]; tanks: Solid[]; boards: Solid[]; lights: Box[] } {
  const boxes: Box[] = [], glass: Box[] = [], tanks: Solid[] = [], boards: Solid[] = [], lights: Box[] = [];
  const B = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: string) => boxes.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2, sx: x1 - x0, sy: y1 - y0, sz: z1 - z0, c });
  for (const s of solids) {
    if (s.kind !== "fixture") continue;
    const y0 = s.y0 ?? 0, alongX = s.x1 - s.x0 > s.z1 - s.z0; // the long axis
    if (s.sub === "gantry") {
      // Truss: top and bottom chords + a mid web; poles 1.5 m out from each face down to the street; two signal heads.
      const t = 0.18;
      B(s.x0, s.top - t, s.z0, s.x1, s.top, s.z1, pal.steel);
      B(s.x0, y0, s.z0, s.x1, y0 + t, s.z1, pal.steel);
      if (alongX) B(s.x0, y0, (s.z0 + s.z1) / 2 - 0.05, s.x1, s.top, (s.z0 + s.z1) / 2 + 0.05, pal.trim);
      else B((s.x0 + s.x1) / 2 - 0.05, y0, s.z0, (s.x0 + s.x1) / 2 + 0.05, s.top, s.z1, pal.trim);
      const cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2;
      for (const e of [0, 1]) {
        const px = alongX ? (e ? s.x1 - 1.5 : s.x0 + 1.5) : cx, pz = alongX ? cz : (e ? s.z1 - 1.5 : s.z0 + 1.5);
        B(px - 0.14, 0, pz - 0.14, px + 0.14, y0, pz + 0.14, pal.steel);
        const hx = alongX ? (e ? s.x1 - 5 : s.x0 + 5) : cx, hz = alongX ? cz : (e ? s.z1 - 5 : s.z0 + 5);
        B(hx - 0.3, y0 - 1.1, hz - 0.3, hx + 0.3, y0, hz + 0.3, "#1c1f24");
        lights.push({ x: hx, y: y0 - 0.35, z: hz, sx: 0.36, sy: 0.22, sz: 0.62, c: e ? "#ff3b30" : "#34c759" });
      }
    } else if (s.sub === "skybridge") {
      // Frame (floor slab, roof slab, corner posts) around a glass box.
      B(s.x0, y0, s.z0, s.x1, y0 + 0.35, s.z1, pal.steel);
      B(s.x0, s.top - 0.3, s.z0, s.x1, s.top, s.z1, pal.steel);
      const n = Math.max(2, Math.round(Math.max(s.x1 - s.x0, s.z1 - s.z0) / 4));
      for (let i = 0; i <= n; i++) {
        const f = i / n;
        if (alongX) { const x = s.x0 + (s.x1 - s.x0) * f; for (const z of [s.z0, s.z1]) B(x - 0.1, y0, z - 0.1, x + 0.1, s.top, z + 0.1, pal.trim); }
        else { const z = s.z0 + (s.z1 - s.z0) * f; for (const x of [s.x0, s.x1]) B(x - 0.1, y0, z - 0.1, x + 0.1, s.top, z + 0.1, pal.trim); }
      }
      glass.push({ x: (s.x0 + s.x1) / 2, y: (y0 + s.top) / 2, z: (s.z0 + s.z1) / 2, sx: s.x1 - s.x0 - 0.02, sy: s.top - y0 - 0.6, sz: s.z1 - s.z0 - 0.02, c: pal.glass });
    } else if (s.sub === "tank") {
      tanks.push(s);
    } else if (s.sub === "board") {
      boards.push(s);
    } else if (s.sub === "stack") {
      // Lattice: rails every 2 m up the face, posts at the ends and the middle; drawn from 3 m up.
      const lo = 3, depthX = !alongX;
      for (let y = lo; y <= s.top + 1e-6; y += 2) B(s.x0, y - 0.08, s.z0, s.x1, y + 0.08, s.z1, pal.stack);
      const n = 2;
      for (let i = 0; i <= n; i++) {
        const f = i / n;
        if (depthX) { const z = s.z0 + (s.z1 - s.z0) * f; B(s.x0, lo, z - 0.08, s.x1, s.top, z + 0.08, pal.stack); }
        else { const x = s.x0 + (s.x1 - s.x0) * f; B(x - 0.08, lo, s.z0, x + 0.08, s.top, s.z1, pal.stack); }
      }
    }
  }
  // (Tank legs and board frames need their host roof: added by the caller.)
  return { boxes, glass, tanks, boards, lights };
}

/** The host roof top under a rooftop fixture (the highest non-fixture solid top below it covering its centre). */
function hostTop(solids: Solid[], f: Solid): number {
  const cx = (f.x0 + f.x1) / 2, cz = (f.z0 + f.z1) / 2;
  let best = 0;
  for (const s of solids) {
    if (s.kind === "fixture" || cx < s.x0 || cx > s.x1 || cz < s.z0 || cz > s.z1) continue;
    if (s.top < f.top && s.top > best) best = s.top;
  }
  return best;
}

export function StructuresView({ model, district }: { model: CityModel; district: DistrictId }) {
  const pal = PALETTE[district] ?? PALETTE.downtown;
  const built = useMemo(() => {
    const solids = model.solids, rigs: Rig[] = model.rigs ?? [];
    const { boxes, glass, tanks, boards, lights } = steelBoxes(solids, pal);
    const tankParts: { x: number; z: number; r: number; y0: number; h: number; top: number }[] = [];
    for (const t of tanks) {
      const host = hostTop(solids, t), r = (t.x1 - t.x0) / 2, cx = (t.x0 + t.x1) / 2, cz = (t.z0 + t.z1) / 2;
      // Four legs up to 45 % of its height, then the drum (a cone roof on top).
      const legTop = host + (t.top - host) * 0.45;
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const lx = cx + dx * r * 0.7, lz = cz + dz * r * 0.7;
        boxes.push({ x: lx, y: (host + legTop) / 2, z: lz, sx: 0.2, sy: legTop - host, sz: 0.2, c: pal.steel });
      }
      tankParts.push({ x: cx, z: cz, r, y0: legTop, h: t.top - legTop - 1.2, top: t.top });
    }
    const panels: { x: number; y: number; z: number; w: number; h: number; ry: number }[] = [];
    for (const b of boards) {
      const host = hostTop(solids, b), alongX = b.x1 - b.x0 > b.z1 - b.z0;
      const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, len = alongX ? b.x1 - b.x0 : b.z1 - b.z0;
      const ph = Math.min(4.2, (b.top - host) * 0.6);
      // Frame: the panel's border box + two legs.
      boxes.push({ x: cx, y: b.top - ph / 2, z: cz, sx: b.x1 - b.x0, sy: ph, sz: b.z1 - b.z0, c: pal.steel });
      for (const e of [-1, 1]) {
        const lx = alongX ? cx + e * len * 0.35 : cx, lz = alongX ? cz : cz + e * len * 0.35;
        boxes.push({ x: lx, y: (host + b.top - ph) / 2, z: lz, sx: 0.3, sy: b.top - ph - host, sz: 0.3, c: pal.steel });
      }
      // Panels on both faces.
      for (const e of [-1, 1]) {
        const off = (alongX ? b.z1 - b.z0 : b.x1 - b.x0) / 2 + 0.02;
        panels.push({ x: alongX ? cx : cx + e * off, y: b.top - ph / 2, z: alongX ? cz + e * off : cz, w: len - 0.3, h: ph - 0.3, ry: alongX ? (e > 0 ? 0 : Math.PI) : (e > 0 ? Math.PI / 2 : -Math.PI / 2) });
      }
    }
    // Cables: SEG straight pieces along the sag.
    const pieces: { a: Vector3; b: Vector3 }[] = [];
    const p = { x: 0, y: 0, z: 0 };
    for (const g of rigs) {
      let prev = new Vector3(g.ax, g.ay, g.az);
      for (let i = 1; i <= SEG; i++) {
        rigPoint(g, i / SEG, p);
        const cur = new Vector3(p.x, p.y, p.z);
        pieces.push({ a: prev, b: cur });
        prev = cur;
      }
    }
    return { boxes, glass, tankParts, panels, pieces, lights };
  }, [model, pal]);

  const geo = useMemo(() => ({
    box: new BoxGeometry(1, 1, 1),
    cyl: new CylinderGeometry(1, 1, 1, 8, 1, true),
    drum: new CylinderGeometry(1, 1, 1, 16),
    cone: new ConeGeometry(1, 1, 16),
    plane: new PlaneGeometry(1, 1),
  }), []);
  const mats = useMemo(() => {
    const ad = DISTRICT_ADS[district]?.[0] ?? "wagmi";
    const tex = new TextureLoader().load(`/textures/billboards/${ad}.webp`);
    tex.colorSpace = SRGBColorSpace;
    return {
      steel: new MeshStandardMaterial({ color: "#ffffff", roughness: 0.6, metalness: 0.4 }),
      cable: new MeshStandardMaterial({ color: pal.cable, roughness: 0.5, metalness: 0.6 }),
      hi: new MeshBasicMaterial({ color: pal.hi }),
      glass: new MeshStandardMaterial({ color: "#ffffff", transparent: true, opacity: 0.35, roughness: 0.1, metalness: 0.2, depthWrite: false }),
      tank: new MeshStandardMaterial({ color: pal.tank, roughness: 0.85, metalness: 0.1 }),
      panelLit: new MeshBasicMaterial({ map: tex, side: DoubleSide }),
      panelFlat: new MeshStandardMaterial({ map: tex, roughness: 0.9, side: DoubleSide }),
      light: new MeshBasicMaterial({ color: "#ffffff", toneMapped: false }),
    };
  }, [district, pal]);

  const refs = {
    boxes: useRef<InstancedMesh>(null), cables: useRef<InstancedMesh>(null), hi: useRef<InstancedMesh>(null), glass: useRef<InstancedMesh>(null),
    drums: useRef<InstancedMesh>(null), cones: useRef<InstancedMesh>(null), panels: useRef<InstancedMesh>(null), lights: useRef<InstancedMesh>(null),
  };

  useEffect(() => {
    const o = new Object3D(), up = new Vector3(0, 1, 0), d = new Vector3(), q = new Quaternion(), m = new Matrix4(), col = new Color();
    const boxes = (mesh: InstancedMesh | null, list: Box[]) => {
      if (!mesh) return;
      list.forEach((b, i) => {
        o.position.set(b.x, b.y, b.z); o.quaternion.identity(); o.scale.set(Math.max(1e-3, b.sx), Math.max(1e-3, b.sy), Math.max(1e-3, b.sz)); o.updateMatrix();
        mesh.setMatrixAt(i, o.matrix);
        mesh.setColorAt(i, col.set(b.c));
      });
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    };
    boxes(refs.boxes.current, built.boxes);
    boxes(refs.glass.current, built.glass);
    boxes(refs.lights.current, built.lights);
    const cable = (mesh: InstancedMesh | null, lift: number, r: number) => {
      if (!mesh) return;
      built.pieces.forEach((pc, i) => {
        const len = pc.a.distanceTo(pc.b);
        q.setFromUnitVectors(up, d.copy(pc.b).sub(pc.a).normalize());
        m.compose(d.copy(pc.a).add(pc.b).multiplyScalar(0.5).setY((pc.a.y + pc.b.y) / 2 + lift), q, new Vector3(r, len, r));
        mesh.setMatrixAt(i, m);
      });
      mesh.count = built.pieces.length;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    };
    cable(refs.cables.current, 0, CABLE_R);
    cable(refs.hi.current, CABLE_R * 0.7, CABLE_R * 0.45);
    const dm = refs.drums.current, cm = refs.cones.current;
    if (dm && cm) {
      built.tankParts.forEach((t, i) => {
        o.quaternion.identity();
        o.position.set(t.x, t.y0 + t.h / 2, t.z); o.scale.set(t.r, t.h, t.r); o.updateMatrix(); dm.setMatrixAt(i, o.matrix);
        o.position.set(t.x, t.top - 0.6, t.z); o.scale.set(t.r * 1.05, 1.2, t.r * 1.05); o.updateMatrix(); cm.setMatrixAt(i, o.matrix);
      });
      dm.count = cm.count = built.tankParts.length;
      dm.instanceMatrix.needsUpdate = cm.instanceMatrix.needsUpdate = true;
      dm.computeBoundingSphere(); cm.computeBoundingSphere();
    }
    const pm = refs.panels.current;
    if (pm) {
      built.panels.forEach((p, i) => {
        o.position.set(p.x, p.y, p.z); o.rotation.set(0, p.ry, 0); o.scale.set(p.w, p.h, 1); o.updateMatrix(); pm.setMatrixAt(i, o.matrix);
      });
      pm.count = built.panels.length;
      pm.instanceMatrix.needsUpdate = true;
      pm.computeBoundingSphere();
    }
  }, [built]);

  // Low quality: no cable highlights, no signal glow, flat board panels. Structures themselves always show.
  useFrame(() => {
    const low = lowQuality();
    if (refs.hi.current) refs.hi.current.visible = !low;
    if (refs.lights.current) refs.lights.current.visible = !low;
    if (refs.panels.current) refs.panels.current.material = low ? mats.panelFlat : mats.panelLit;
  });

  const n = (k: number) => Math.max(1, k);
  return (
    <group name="structures">
      <instancedMesh ref={refs.boxes} args={[geo.box, mats.steel, n(built.boxes.length)]} frustumCulled={false} />
      <instancedMesh ref={refs.cables} args={[geo.cyl, mats.cable, n(built.pieces.length)]} frustumCulled={false} />
      <instancedMesh ref={refs.hi} args={[geo.cyl, mats.hi, n(built.pieces.length)]} frustumCulled={false} />
      <instancedMesh ref={refs.glass} args={[geo.box, mats.glass, n(built.glass.length)]} frustumCulled={false} renderOrder={2} />
      <instancedMesh ref={refs.drums} args={[geo.drum, mats.tank, n(built.tankParts.length)]} frustumCulled={false} />
      <instancedMesh ref={refs.cones} args={[geo.cone, mats.tank, n(built.tankParts.length)]} frustumCulled={false} />
      <instancedMesh ref={refs.panels} args={[geo.plane, mats.panelLit, n(built.panels.length)]} frustumCulled={false} />
      <instancedMesh ref={refs.lights} args={[geo.box, mats.light, n(built.lights.length)]} frustumCulled={false} />
    </group>
  );
}
