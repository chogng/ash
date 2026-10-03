import { defineConfig } from "@playwright/test";

const browserServerMode = process.env.ASH_PLAYWRIGHT_SERVER;
const browserProjects = browserServerMode === "disconnected"
	? [{ name: "browser-ui", use: { baseURL: `http://127.0.0.1:${process.env.ASH_SMOKE_BROWSER_PORT ?? 5173}` } }]
	: browserServerMode === "full"
		? [{ name: "browser-app-server" }]
		: [];

export default defineConfig({
	testDir: "./test/smoke",
	outputDir: "../.build/app-ts/playwright/test-results",
	fullyParallel: false,
	workers: 1,
	projects: [
		...[
			...browserProjects,
			{ name: "electron-ui" },
			{ name: "electron-app-server" },
			{
				name: "electron-editor-app-server",
				testMatch: ["**/areas/editor/academic-open.spec.ts", "**/areas/editor/editor-open.spec.ts"],
			},
			{ name: "electron-pdf-corpus-app-server", testMatch: "**/areas/pdf/pdf-academic-corpus.spec.ts" },
		].map(project => ({
			...project,
			// Publisher downloads have their own opt-in corpus project. Ordinary
			// smoke runs use the PDF fixture created by the shared workspace.
			testIgnore: project.name === 'electron-pdf-corpus-app-server'
				? '**/release-package.spec.ts'
				: ['**/release-package.spec.ts', '**/pdf-academic-corpus.spec.ts'],
		})),
		{ name: 'electron-release', testMatch: '**/release-package.spec.ts', testIgnore: '', timeout: 600_000 },
	],
	webServer: browserServerMode === "disconnected"
		? {
				// The browser smoke preparation script builds the renderer before Playwright starts.
				command: `node ../build/app_ts/launch/web.ts ../.build/app-ts/renderer/ash ${process.env.ASH_SMOKE_BROWSER_PORT ?? 5173}`,
				url: `http://127.0.0.1:${process.env.ASH_SMOKE_BROWSER_PORT ?? 5173}/`,
				reuseExistingServer: false,
				timeout: 120_000,
			}
		: undefined,
	timeout: 45_000,
	expect: {
		timeout: 10_000,
	},
	reporter: [
		["list"],
		["html", { outputFolder: "../.build/app-ts/playwright/report", open: "never" }],
	],
});
