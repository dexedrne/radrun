// The playable roster: the Radbros (ids = their token numbers) and, since 2026-10-02, the owner's two Retardios
// (ids "retardio555" / "retardio85", never a bare number, so they can't be mistaken for Radbro tokens). A tiny module
// on its own so the relay can check the ids players send without pulling in the game.
export type RadbroId = "652" | "4764" | "2564" | "723" | "3171" | "retardio555" | "retardio85";
export const RADBROS: readonly RadbroId[] = ["652", "4764", "2564", "723", "3171", "retardio555", "retardio85"];
export const isRadbroId = (s: unknown): s is RadbroId => typeof s === "string" && (RADBROS as readonly string[]).includes(s);

/** A Retardio (Retardio Cousin #555, Retardio Classic #85), not a Radbro token. */
export const isRetardio = (id: string): boolean => id.startsWith("retardio");
/** The character's file stem under public/models and public/ui: radbro652, retardio555. */
export const charFile = (id: string): string => (isRetardio(id) ? id : `radbro${id}`);
/** Short tag for cards, HUD rows and the kill feed: #652, #555. */
export const charTag = (id: string): string => `#${isRetardio(id) ? id.slice(8) : id}`;
/** The title-card portrait (npm run portraits). */
export const portraitPath = (id: string): string => `/ui/${charFile(id)}.webp`;
/** Full name: Radbro #652, Retardio #555. */
export const charName = (id: string): string => `${isRetardio(id) ? "Retardio" : "Radbro"} ${charTag(id)}`;
