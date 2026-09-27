// The playable Radbros (ids = their token numbers). A tiny module on its own so the relay can check the ids players
// send without pulling in the game.
export type RadbroId = "652" | "4764" | "2564" | "723" | "3171";
export const RADBROS: readonly RadbroId[] = ["652", "4764", "2564", "723", "3171"];
export const isRadbroId = (s: unknown): s is RadbroId => typeof s === "string" && (RADBROS as readonly string[]).includes(s);
