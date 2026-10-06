// Shared by the offline generator and the level material adapter. Scales are intentionally modest.
export const PBR_PROFILES = {
  facade_grid: { roughness: 0.85, strength: 4, normalScale: 0.7 },
  facade_brick: { roughness: 0.9, strength: 4, normalScale: 0.7 },
  facade_glass: { roughness: 0.72, strength: 3, normalScale: 0.5 },
  roof: { roughness: 0.94, strength: 3, normalScale: 0.6 },
  street: { roughness: 0.96, strength: 2, normalScale: 0.5 },
  water: { roughness: 0.12, strength: 2, normalScale: 0.4 },
} as const;
