import { resolve } from "node:path";
import { defineConfig } from "vite";
import { buildMetricsPlugin } from './buildMetricsPlugin.ts';
import { rendererOutput } from './output.ts';
import { hotReloadPlugin } from "./hotReloadPlugin.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const desktopRoot = resolve(repositoryRoot, "ash-ts");

export default defineConfig({
  base: "./",
  root: repositoryRoot,
  plugins: [buildMetricsPlugin(), hotReloadPlugin({ desktopRoot })],
  server: {
    host: "127.0.0.1",
    port: 5199,
    strictPort: true,
  },
  build: {
    outDir: resolve(repositoryRoot, ".build/desktop/stanza"),
    emptyOutDir: true,
    rolldownOptions: {
      output: rendererOutput,
      input: {
        stanza: resolve(import.meta.dirname, "stanza/index.html"),
      },
    },
  },
});
