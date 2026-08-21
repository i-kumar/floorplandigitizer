import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { docStore } from "./core/store";
import { loadAutosave, startAutosave } from "./core/persist";
import "./styles.css";

async function boot() {
  const saved = await loadAutosave();
  if (saved) docStore.replace(saved);
  startAutosave();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
