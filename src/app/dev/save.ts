// Save a level file: POST to the dev server's /__rugrun/save (writes public/levels/<file>; for
// city.json it also re-runs `npm run level`), or fall back to a browser download outside `npm run dev`.
export async function saveLevelFile(file: "city.json" | "decor.json" | "tuning.json", data: unknown): Promise<string> {
  const body = JSON.stringify(data, null, file === "tuning.json" ? 2 : 1) + "\n";
  if (import.meta.env.DEV) {
    try {
      const r = await fetch(`/__rugrun/save?file=${file}`, { method: "POST", headers: { "content-type": "application/json" }, body });
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
  return `downloaded ${file} - copy it into public/levels/ and run npm run level`;
}
