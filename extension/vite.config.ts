import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { cpSync, existsSync, copyFileSync, readFileSync, writeFileSync } from "fs";

// Localhost host_permissions are kept OUT of the committed manifest (issue #37:
// shipping them in a production extension grants any visited page the ability to
// reach the user's local FastAPI / Ollama). They get injected at build time only
// when running `vite build --mode development`.
const DEV_LOCALHOST_HOSTS = [
  "http://localhost:8000/*",
  "http://localhost:11434/*",
];

function copyStaticAssets(mode: string) {
  return {
    name: "copy-static-assets",
    closeBundle() {
      const root = resolve(__dirname);
      const out = resolve(__dirname, "dist");
      const manifestDest = resolve(out, "manifest.json");
      cpSync(resolve(root, "manifest.json"), manifestDest);

      if (mode === "development") {
        // Dev build: inject localhost host_permissions so the unpacked extension
        // can talk to localhost:8000 (backend) and localhost:11434 (Ollama).
        const manifest = JSON.parse(readFileSync(manifestDest, "utf-8"));
        const existing = new Set<string>(manifest.host_permissions || []);
        for (const h of DEV_LOCALHOST_HOSTS) existing.add(h);
        manifest.host_permissions = Array.from(existing);
        writeFileSync(manifestDest, JSON.stringify(manifest, null, 2) + "\n");
      }

      if (existsSync(resolve(root, "icons"))) {
        cpSync(resolve(root, "icons"), resolve(out, "icons"), { recursive: true });
      }
      // AudioWorklet processor — must be served as a plain script at the
      // extension root so chrome.runtime.getURL('audio-processor.js') resolves.
      // Vite does not bundle it (AudioWorklet scripts can't have ESM imports).
      const audioProc = resolve(root, "src/offscreen/audio-processor.js");
      if (existsSync(audioProc)) {
        copyFileSync(audioProc, resolve(out, "audio-processor.js"));
      }
    },
  };
}

// Wrap meet-transponder.js in an IIFE so re-injecting it (via
// chrome.scripting.executeScript when the original copy was loaded by a now-
// reloaded extension instance) doesn't crash with
// "Identifier 'X' has already been declared" — re-running the bundle in the
// same isolated world otherwise collides on its top-level let/const.
//
// Strategy: IIFE-scope every declaration so each injection's lets are
// independent, and clean up any stale DOM/styles from the previous instance
// so we don't end up with two transponder UIs side-by-side.
function idempotentTransponder() {
  return {
    name: "idempotent-transponder",
    generateBundle(_opts: unknown, bundle: Record<string, { type: string; code?: string }>) {
      const file = bundle["meet-transponder.js"];
      if (file && file.type === "chunk" && file.code) {
        const cleanup =
          "try{var __o=document.getElementById('clientlens-transponder');if(__o)__o.remove();" +
          "var __p=document.getElementById('clientlens-start-prompt');if(__p)__p.remove();" +
          "var __s=document.getElementById('clientlens-transponder-css');if(__s)__s.remove();" +
          "var __f=document.getElementById('clientlens-fonts');if(__f)__f.remove();}catch(_){}";
        file.code = "(function(){" + cleanup + "\n" + file.code + "\n})();";
      }
    },
  };
}


export default defineConfig(({ mode }) => ({
  plugins: [react(), copyStaticAssets(mode), idempotentTransponder()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidebar: resolve(__dirname, "sidebar.html"),
        popup: resolve(__dirname, "popup.html"),
        offscreen: resolve(__dirname, "offscreen.html"),
        background: resolve(__dirname, "src/background/service-worker.ts"),
        content: resolve(__dirname, "src/content/content-script.ts"),
        "meet-transponder": resolve(__dirname, "src/content/meet-transponder.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(mode),
  },
}));
