import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const LEVEL_FILES = new Set(["city.json", "decor.json", "tuning.json"]);

/** Dev-only: POST /__rugrun/save?file=<city|decor|tuning>.json writes public/levels/<file>. */
function devSave(): Plugin {
  return {
    name: "rugrun-dev-save",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__rugrun/save", (req, res) => {
        const reply = (code: number, ok: boolean, message: string) => {
          res.statusCode = code;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok, message }));
        };
        if (req.method !== "POST") return reply(405, false, "POST only");
        const file = new URL(req.url ?? "", "http://localhost").searchParams.get("file") ?? "";
        if (!LEVEL_FILES.has(file)) return reply(400, false, `not a level file: ${file}`);
        let body = "";
        req.on("data", c => (body += c));
        req.on("end", () => {
          try {
            JSON.parse(body);
          } catch (e) {
            return reply(400, false, `invalid JSON: ${String(e)}`);
          }
          const root = server.config.root;
          fs.writeFileSync(path.join(root, "public", "levels", file), body);
          let message = `saved public/levels/${file}`;
          if (file === "city.json" || file === "tuning.json") {
            try {
              const out = execFileSync(process.execPath, [path.join(root, "tools", "level.ts")], { cwd: root, encoding: "utf8" });
              message += `\n${out.trim()}\nreload the game page to play the new layout / runner bake`;
            } catch (e) {
              return reply(500, false, `${message}, but npm run level failed:\n${String((e as { stdout?: string }).stdout ?? e)}`);
            }
          }
          reply(200, true, message);
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devSave()],
  server: { port: 4870, strictPort: false },
  preview: { port: 4871 },
  build: { chunkSizeWarningLimit: 4000 },
});
