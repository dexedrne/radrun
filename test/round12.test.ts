// Round 12 (docs/specs/2026-09-26-round12-spider-tag.md): web-slinger tag. Step 0: floating solids in the
// CityIndex queries (a model without y0 answers exactly as before).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CityIndex, pointBoxDist, RIG0, type CityModel, type Solid } from "../src/world/cityModel.ts";

const box = (id: number, x0: number, z0: number, x1: number, z1: number, top: number, y0?: number): Solid =>
  ({ id, kind: y0 === undefined ? "roof" : "fixture", landable: true, x0, z0, x1, z1, top, ...(y0 === undefined ? {} : { y0, sub: "skybridge" as const }) });

const modelOf = (solids: Solid[]): CityModel => ({
  version: 1, config: null as unknown as CityModel["config"], bounds: { x0: -50, z0: -50, x1: 50, z1: 50 }, lowestRoof: 10, solids,
  adjacency: [], wallGaps: [], junctionCandidates: [], spawn: { roofId: 0, x: 0, y: 11, z: 0, yaw: 0 }, rigs: [], hash: "t",
});

test("step 0: a floating box blocks segments only between its bottom and top", () => {
  const idx = new CityIndex(modelOf([box(0, -30, -30, -20, -20, 10), box(1, -2, -2, 2, 2, 23.5, 20)]));
  // Under the bridge: clear. Through it: blocked. Over it: clear.
  assert.equal(idx.segmentHit(-10, 10, 0, 10, 10, 0), -1);
  assert.ok(Math.abs(idx.segmentHit(-10, 21, 0, 10, 21, 0) - 0.4) < 1e-9);
  assert.equal(idx.segmentHit(-10, 24, 0, 10, 24, 0), -1);
  // Straight up from under it: hits its underside.
  assert.ok(Math.abs(idx.segmentHit(0, 10, 0, 0, 30, 0) - 0.5) < 1e-9);
  // pointBoxDist measures from the bottom.
  const s = idx.solids[1];
  assert.equal(pointBoxDist(0, 15, 0, s), 5);
  assert.equal(pointBoxDist(0, 22, 0, s), 0);
  assert.equal(pointBoxDist(0, 25.5, 0, s), 2);
  // groundBelow: the bridge top is the floor above it, the street below it.
  assert.equal(idx.groundBelow(0, 0, 30), 23.5);
  assert.equal(idx.groundBelow(0, 0, 15), 0);
  // A ground-rooted box is unchanged (y0 missing = 0).
  assert.equal(pointBoxDist(-25, 5, -25, idx.solids[0]), 0);
  assert.ok(RIG0 > 1000000);
});
