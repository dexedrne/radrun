// The build id baked in by vite.config.ts (git short SHA; "dev" in Node tests and when git is missing).
declare const __BUILD_ID__: string | undefined;
export const BUILD_ID: string = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";
