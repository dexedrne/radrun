// Save a level file: POST to the dev server's /__rugrun/save (writes the page district's level dir;
// tuning.json is shared at public/levels/; for city.json it also re-runs `npm run level`), or fall back to a browser download outside `npm run dev`.
import { PAGE, PAGE_DISTRICT } from "../district.ts";
export async function saveLevelFile(file: "city.json" | "decor.json" | "tuning.json", data: unknown): Promise<string> {
  const body = JSON.stringify(data, null, file === "tuning.json" ? 2 : 1) + "\n";
  if (import.meta.env.DEV) {
    try {
      const r = await fetch(`/__rugrun/save?file=${file}&map=${PAGE_DISTRICT}`, { method: "POST", headers: { "content-type": "application/json" }, body });
      const j = (await r.json()) as { ok: boolean; message: string };
      return j.message;
    } catch (e) {
      return `save failed: ${String(e)}`;
    }
  }
  const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = file;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return `downloaded ${file} - copy it into public/${file === "tuning.json" ? "levels/" : PAGE.dir} and run npm run level -- --map ${PAGE_DISTRICT}`;
}
