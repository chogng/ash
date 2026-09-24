import { resolve } from "node:path";
import { defineConfig } from "vite";
import { AshRendererDirectory } from "../../../app-ts/src/ash/code/common/application.js";
import { WorkbenchModeRegistry } from "../../../app-ts/src/ash/workbench/common/workbenchMode.js";
import { appTsBuildPath } from "../paths.ts";
import { buildMetricsPlugin } from './buildMetricsPlugin.ts';
import { rendererOutput } from './rendererOutput.ts';
import { hotReloadPlugin } from "./hotReloadPlugin.ts";
import { productIconsPlugin } from "./productIconsPlugin.ts";
import { webAppServerVitePlugin } from "./webAppServerPlugin.ts";
import { workbenchEntryPlugin } from "./workbenchEntryPlugin.ts";

export default defineConfig(() => {
  const desktopRoot = resolve(import.meta.dirname, "../../../app-ts");
  const repositoryRoot = resolve(desktopRoot, "..");
  const workbenchModeId = WorkbenchModeRegistry.resolveModeId(process.env.ASH_WORKBENCH_MODE);
  const webAppServerEnabled = process.env.ASH_WEB_APP_SERVER === "1";
  const developmentPort = webAppServerEnabled ? 5174 : 5173;
  const sourceRoot = resolve(desktopRoot, "src/ash/code");
  const browserEntry = "browser/workbench/workbench";
  const electronEntry = "electron-browser/workbench/workbench";
  const dedicatedSessionsEntries = WorkbenchModeRegistry.definitions.flatMap(mode => mode.dedicatedSessions ? [mode.dedicatedSessions.rendererEntry] : []);
  const sessionsInputs = Object.fromEntries(dedicatedSessionsEntries.flatMap(rendererEntry => [
    [`browser/sessions/${rendererEntry}`, resolve(sourceRoot, `browser/sessions/${rendererEntry}.html`)],
    [`electron-browser/sessions/${rendererEntry}`, resolve(sourceRoot, `electron-browser/sessions/${rendererEntry}.html`)],
  ]));
  const remoteRuntimeInstallInput = {
    "electron-browser/remote-runtime-install/remoteRuntimeInstall": resolve(sourceRoot, "electron-browser/remote-runtime-install/remoteRuntimeInstall.html"),
  };

  return {
    base: "./",
    root: sourceRoot,
    publicDir: resolve(repositoryRoot, "resources/server"),
    define: {
      __ASH_WORKBENCH_MODE__: JSON.stringify(workbenchModeId),
      __ASH_WEB_APP_SERVER__: JSON.stringify(webAppServerEnabled),
    },
    plugins: [buildMetricsPlugin(), hotReloadPlugin({ desktopRoot }), workbenchEntryPlugin(), productIconsPlugin(), ...(webAppServerEnabled ? [webAppServerVitePlugin()] : [])],
    optimizeDeps: {
      include: ["vscode-oniguruma"],
    },
    server: {
      host: "127.0.0.1",
      port: developmentPort,
      strictPort: true,
    },
    build: {
      outDir: appTsBuildPath(repositoryRoot, "renderer", AshRendererDirectory),
      emptyOutDir: true,
      rolldownOptions: {
		output: rendererOutput,
        input: {
          [browserEntry]: resolve(sourceRoot, `${browserEntry}.html`),
          [electronEntry]: resolve(sourceRoot, `${electronEntry}.html`),
          ...sessionsInputs,
          ...remoteRuntimeInstallInput,
        },
      },
    },
  };
});
