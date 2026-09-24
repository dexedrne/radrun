import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import SandboxPage from "./app/SandboxPage.tsx";

window.addEventListener("error", e => console.error("[window.error]", e.message));
window.addEventListener("unhandledrejection", e => console.error("[unhandledrejection]", String(e.reason)));

const EditorPage = import.meta.env.MODE !== "production" ? lazy(() => import("./app/dev/EditorPage.tsx")) : null;
const params = new URLSearchParams(location.search);

// No StrictMode: the game lives outside React and the canvas is mounted exactly once.
function App() {
  if (EditorPage && params.has("editor")) {
    return (
      <Suspense fallback={<div style={{ padding: 20 }}>loading editor…</div>}>
        <EditorPage />
      </Suspense>
    );
  }
  // M1: the free-swing sandbox is the only game page (title/round arrive in M3).
  return <SandboxPage />;
}

createRoot(document.getElementById("root")!).render(<App />);
