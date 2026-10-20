import { resolve } from "node:path";
import { defineConfig, normalizePath, type Plugin } from "vite";
import { AshRendererDirectory } from "../../../src/ash/code/common/application.js";
import { codeSessionsProfile } from '../../../src/ash/code/common/codeSessionsProfile.js';
import { desktopBuildPath } from "../paths.ts";
import { buildMetricsPlugin } from './buildMetricsPlugin.ts';
import { desktopStartupTracePlugin } from './desktopStartupTracePlugin.ts';
import { rendererOutput } from './rendererOutput.ts';
import { rendererDependencyAliases } from './rendererDependencies.ts';
import { hotReloadPlugin } from "./hotReloadPlugin.ts";
import { productIconsPlugin } from "./productIconsPlugin.ts";
import { webAppServerVitePlugin } from "./webAppServerPlugin.ts";
import { workbenchEntryPlugin } from "./workbenchEntryPlugin.ts";
import { webUpdatePlugin } from './webUpdatePlugin.ts';
import { browserExtensionsPlugin } from './extensionsPlugin.ts';
import { CSSDevelopmentService } from '../../../src/ash/platform/cssDev/node/cssDevService.ts';
import { installChatGPTVerification } from '../../../src/ash/sessions/contrib/chatgptweb/browser/chatGPTVerification.ts';

export default defineConfig(({ mode, command }) => {
	const desktopRoot = resolve(import.meta.dirname, "../../..");
	const repositoryRoot = desktopRoot;
	const webAppServerEnabled = process.env.ASH_WEB_APP_SERVER === "1";
	const webOnly = mode === "web";
	const developmentPort = webAppServerEnabled ? 5174 : 5173;
	const sourceRoot = resolve(desktopRoot, "src/ash/code");
	const sessionsWebEntry = 'browser/sessions/sessions';
	const moduleUrl = (path: string): string => `/@fs/${normalizePath(resolve(repositoryRoot, 'src/ash', path))}`;
	// The host supplies the page and product identity; Sessions owns the embedded Web application.
	const sessionsWebHtml = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width,initial-scale=1" />
		<link rel="apple-touch-icon" href="/ash-192.png" />
		<link rel="icon" href="/favicon.ico" type="image/x-icon" />
		<link rel="manifest" href="/manifest.json" />
		<title>Ash Code Sessions</title>
	</head>
	<body>
		<main id="app"></main>
		<script type="module">
			import { IndexedDBFileSystemProvider } from '${moduleUrl('platform/files/browser/indexedDBFileSystemProvider.ts')}';
			import { FileService } from '${moduleUrl('platform/files/common/fileService.ts')}';
			import { URI } from '${moduleUrl('base/common/uri.ts')}';
			import { Schemas } from '${moduleUrl('base/common/network.ts')}';
			import { migrateLegacyBrowserSettings } from '${moduleUrl('workbench/services/userData/browser/userDataInit.ts')}';
			import { BrowserLanguagePackStore } from '${moduleUrl('platform/languagePacks/browser/languagePackStore.ts')}';
			import { initializeBrowserLocalization } from '${moduleUrl('workbench/services/localization/browser/localizationBootstrap.ts')}';
			import { showStartupError } from '${moduleUrl('workbench/browser/startupError.ts')}';
			import { readBrowserPartsSplash, showPartsSplash } from '${moduleUrl('workbench/contrib/splash/browser/splash.ts')}';
			try {
				showPartsSplash(document, readBrowserPartsSplash(window));
				{
					using provider = await IndexedDBFileSystemProvider.create(window.indexedDB, Schemas.vscodeUserData);
					await migrateLegacyBrowserSettings(window.indexedDB, provider, URI.from({ scheme: Schemas.vscodeUserData, path: '/user/settings.json' }));
					using files = new FileService();
					using registration = files.registerProvider(Schemas.vscodeUserData, provider);
					await initializeBrowserLocalization(files, new BrowserLanguagePackStore());
				}
				const { create } = await import('${moduleUrl('sessions/sessions.web.main.internal.ts')}');
				create(document.getElementById('app'), import.meta.env.ASH_SESSIONS_PROFILE);
			} catch (error) {
				showStartupError(error, text => navigator.clipboard.writeText(text));
			}
		</script>
	</body>
</html>`;
	const browserEntryPath = process.env.ASH_DEV_AGENTS_WINDOW === '1'
		? `/${sessionsWebEntry}.html`
		: '/browser/workbench/workbench.html';
	const browserEntry = "browser/workbench/workbench";
	const electronEntry = "electron-browser/workbench/workbench";
	const browserInputs = {
		[browserEntry]: resolve(sourceRoot, `${browserEntry}.html`),
		[sessionsWebEntry]: resolve(sourceRoot, `${sessionsWebEntry}.html`),
		'browser/theme-preview/themePreview': resolve(sourceRoot, 'browser/theme-preview/themePreview.html'),
		'browser/theme-preview/sessionsThemePreview': resolve(sourceRoot, 'browser/theme-preview/sessionsThemePreview.html'),
	};
	const sessionsInputs = {
		'sessions/electron-browser/sessions': resolve(sourceRoot, 'sessions/electron-browser/sessions.html'),
	};
	const remoteRuntimeInstallInput = {
		"electron-browser/remote-runtime-install/remoteRuntimeInstall": resolve(sourceRoot, "electron-browser/remote-runtime-install/remoteRuntimeInstall.html"),
	};
	const verificationScript = `(${installChatGPTVerification.toString()})();`;
	const inputs = webOnly ? browserInputs : {
		...browserInputs,
		[electronEntry]: resolve(sourceRoot, `${electronEntry}.html`),
		...sessionsInputs,
		...remoteRuntimeInstallInput,
		'electron-browser/screenshot/screenshot': resolve(sourceRoot, 'electron-browser/screenshot/screenshot.html'),
	};

	return {
		base: "./",
		root: sourceRoot,
		publicDir: resolve(repositoryRoot, "resources/server"),
		define: {
			__ASH_WEB_APP_SERVER__: JSON.stringify(webAppServerEnabled || command === "build" && !webOnly),
			'import.meta.env.ASH_SESSIONS_PROFILE': JSON.stringify(codeSessionsProfile),
		},
		plugins: [
			...(webOnly ? [webUpdatePlugin()] : []),
			...(webOnly ? [] : [{
				name: 'ash-chatgpt-verification',
				generateBundle() { this.emitFile({ type: 'asset' as const, fileName: 'browser/chatgpt/verification.js', source: verificationScript }); },
				configureServer(server) {
					server.middlewares.use('/browser/chatgpt/verification.js', (request, response, next) => {
						if (request.method !== 'GET') { next(); return; }
						response.setHeader('Content-Type', 'text/javascript');
						response.setHeader('Cache-Control', 'no-store');
						response.end(verificationScript);
					});
				},
			} satisfies Plugin]),
			buildMetricsPlugin(),
			hotReloadPlugin({ desktopRoot }),
			workbenchEntryPlugin(browserEntryPath, [{
				url: `/${sessionsWebEntry}.html`,
				inputFile: browserInputs[sessionsWebEntry],
				html: sessionsWebHtml,
			}, {
				url: '/browser/theme-preview/themePreview.html',
				inputFile: browserInputs['browser/theme-preview/themePreview'],
				sourceFile: resolve(repositoryRoot, 'src/ash/workbench/contrib/themeEditor/browser/themePreview.html'),
			}, {
				url: '/browser/theme-preview/sessionsThemePreview.html',
				inputFile: browserInputs['browser/theme-preview/sessionsThemePreview'],
				sourceFile: resolve(repositoryRoot, 'src/ash/sessions/contrib/themeEditor/browser/sessionsThemePreview.html'),
			}, ...(webOnly ? [] : [{
				url: '/sessions/electron-browser/sessions.html',
				sourceFile: resolve(sourceRoot, '../sessions/electron-browser/sessions.html'),
				inputFile: sessionsInputs['sessions/electron-browser/sessions'],
			}])], {
				sourceRoot: resolve(repositoryRoot, 'src'),
				service: new CSSDevelopmentService({ sourceRoot: resolve(repositoryRoot, 'src'), isBuilt: command === 'build' }),
			}),
			productIconsPlugin(),
			// Extension preparation publishes localization first and owns the shared resource watcher.
			browserExtensionsPlugin(),
			{
				name: "ash-electron-file-html",
				apply: "build",
				transformIndexHtml: {
					order: "post",
					handler(html, context) {
						const file = context.filename.replaceAll("\\", "/");
						if (!file.includes("/electron-browser/") && !file.includes('/browser/theme-preview/')) return;
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
			include: ["@xterm/xterm", "@xterm/addon-fit"],
		},
		resolve: { alias: rendererDependencyAliases },
		server: {
			host: "127.0.0.1",
			port: developmentPort,
			strictPort: true,
			// Transform the product entry graphs while the host starts, before its first navigation.
			warmup: {
				clientFiles: Object.entries(inputs)
					.filter(([entry]) => !entry.startsWith('electron-browser/remote-runtime-install/'))
					.map(([entry, path]) => {
						// HTML warmup reads disk directly, bypassing the virtual product-page loader.
						if (entry === sessionsWebEntry) return resolve(repositoryRoot, 'src/ash/sessions/sessions.web.main.internal.ts');
						if (entry === 'browser/theme-preview/sessionsThemePreview') return resolve(repositoryRoot, 'src/ash/sessions/contrib/themeEditor/browser/themePreviewPage.ts');
						if (entry === 'browser/theme-preview/themePreview') return resolve(repositoryRoot, 'src/ash/workbench/contrib/themeEditor/browser/themePreviewPage.ts');
						if (entry === 'sessions/electron-browser/sessions') return resolve(repositoryRoot, 'src/ash/sessions/electron-browser/sessions.ts');
						return path;
					}),
			},
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
