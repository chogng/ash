import { localizationPlugin } from "../../resources/localization.ts";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { AshRendererDirectory, AshSessionsRendererEntry } from "../../../src/ash/code/common/application.js";
import { desktopBuildPath } from "../paths.ts";
import { buildMetricsPlugin } from './buildMetricsPlugin.ts';
import { desktopStartupTracePlugin } from './desktopStartupTracePlugin.ts';
import { rendererOutput } from './rendererOutput.ts';
import { hotReloadPlugin } from "./hotReloadPlugin.ts";
import { productIconsPlugin } from "./productIconsPlugin.ts";
import { webAppServerVitePlugin } from "./webAppServerPlugin.ts";
import { workbenchEntryPlugin } from "./workbenchEntryPlugin.ts";
import { browserExtensionsPlugin } from './extensionsPlugin.ts';

export default defineConfig(({ mode }) => {
	const desktopRoot = resolve(import.meta.dirname, "../../..");
	const repositoryRoot = desktopRoot;
	const webAppServerEnabled = process.env.ASH_WEB_APP_SERVER === "1";
	const webOnly = mode === "web";
	const developmentPort = webAppServerEnabled ? 5174 : 5173;
	const sourceRoot = resolve(desktopRoot, "src/ash/code");
	const browserEntryPath = process.env.ASH_DEV_AGENTS_WINDOW === '1'
		? `/browser/sessions/${AshSessionsRendererEntry}.html`
		: '/browser/workbench/workbench.html';
	const browserEntry = "browser/workbench/workbench";
	const electronEntry = "electron-browser/workbench/workbench";
	const browserInputs = {
		[browserEntry]: resolve(sourceRoot, `${browserEntry}.html`),
		[`browser/sessions/${AshSessionsRendererEntry}`]: resolve(sourceRoot, `browser/sessions/${AshSessionsRendererEntry}.html`),
	};
	const sessionsInputs = {
		[`browser/sessions/${AshSessionsRendererEntry}`]: resolve(sourceRoot, `browser/sessions/${AshSessionsRendererEntry}.html`),
		[`electron-browser/sessions/${AshSessionsRendererEntry}`]: resolve(sourceRoot, `electron-browser/sessions/${AshSessionsRendererEntry}.html`),
	};
	const remoteRuntimeInstallInput = {
		"electron-browser/remote-runtime-install/remoteRuntimeInstall": resolve(sourceRoot, "electron-browser/remote-runtime-install/remoteRuntimeInstall.html"),
	};
	const inputs = webOnly ? browserInputs : {
		...browserInputs,
		[electronEntry]: resolve(sourceRoot, `${electronEntry}.html`),
		...sessionsInputs,
		...remoteRuntimeInstallInput,
	};

	return {
		base: "./",
		root: sourceRoot,
		publicDir: resolve(repositoryRoot, "resources/server"),
		define: {
			__ASH_WEB_APP_SERVER__: JSON.stringify(webAppServerEnabled),
		},
		plugins: [
			buildMetricsPlugin(),
			localizationPlugin(),
			hotReloadPlugin({ desktopRoot }),
			workbenchEntryPlugin(browserEntryPath),
			productIconsPlugin(),
			browserExtensionsPlugin(),
			{
				name: "ash-electron-file-html",
				apply: "build",
				transformIndexHtml: {
					order: "post",
					handler(html, context) {
						if (!context.filename.replaceAll("\\", "/").includes("/electron-browser/")) return;
						// File-URL module preloads can prevent Linux Electron from loading its stylesheets.
						return html.replace(/<link rel="modulepreload"[^>]*>\s*/g, "");
					},
				},
			},
			...(process.env.ASH_DESKTOP_STARTUP_TRACE === '1' ? [desktopStartupTracePlugin()] : []),
			...(webAppServerEnabled ? [webAppServerVitePlugin(browserEntryPath)] : []),
		],
		optimizeDeps: {
			// The dependency scanner parses source before Vite transforms parameter decorators.
			noDiscovery: true,
			include: ["vscode-oniguruma", "vscode-textmate", "@xterm/xterm", "@xterm/addon-fit", "pdfjs-dist"],
		},
		server: {
			host: "127.0.0.1",
			port: developmentPort,
			strictPort: true,
			// Transform the product entry graphs while the host starts, before its first navigation.
			warmup: { clientFiles: Object.entries(inputs).filter(([entry]) => !entry.startsWith('electron-browser/remote-runtime-install/')).map(([, path]) => path) },
		},
		build: {
			outDir: desktopBuildPath(repositoryRoot, webOnly ? "web" : "renderer", AshRendererDirectory),
			emptyOutDir: true,
			rolldownOptions: {
				output: rendererOutput,
				input: inputs,
			},
		},
	};
});
