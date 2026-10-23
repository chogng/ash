import { defineConfig } from "@playwright/test";
import { testTargetExclusions } from './test/automation/testTarget.js';

const browserServerMode = process.env.ASH_PLAYWRIGHT_SERVER;
const browserUi = browserServerMode === "disconnected" || browserServerMode === "development";
const browserProjects = browserUi
	? [{ name: "browser-ui", use: { baseURL: `http://127.0.0.1:${process.env.ASH_SMOKE_BROWSER_PORT ?? 5173}` } }]
	: browserServerMode === "full"
		? [{ name: "browser-app-server" }]
		: [];

export default defineConfig({
	forbidOnly: !!process.env.CI,
	testDir: "./test/smoke",
	outputDir: ".build/desktop/playwright/test-results",
	fullyParallel: false,
	workers: 1,
	projects: [
		...[
			...browserProjects,
			{ name: "electron-ui" },
			{ name: "electron-app-server" },
			{
				name: "electron-editor-app-server",
				testMatch: ["**/areas/editor/academy-open.spec.ts", "**/areas/editor/editor-open.spec.ts", "**/areas/chat/chat-editing.spec.ts"],
			},
			{ name: "electron-pdf-corpus-app-server", testMatch: "**/areas/pdf/pdf-academy-corpus.spec.ts" },
		].map(project => ({
			...project,
			grepInvert: testTargetExclusions(project.name, process.platform),
			// Installing the optional PDF Viewer and downloading publisher documents
			// belong to the opt-in project. Ordinary profiles exercise the fallback.
			testIgnore: project.name === 'electron-pdf-corpus-app-server'
				? '**/release-package.spec.ts'
				: ['**/release-package.spec.ts', '**/pdf-academy-corpus.spec.ts'],
		})),
		{ name: 'electron-release', testMatch: '**/release-package.spec.ts', testIgnore: '', timeout: 600_000 },
	],
	webServer: browserUi
		? {
			// The browser smoke preparation script builds the renderer before Playwright starts.
			command: browserServerMode === "development"
				? `pnpm run dev:web --port ${process.env.ASH_SMOKE_BROWSER_PORT ?? 5173}`
				: `node build/desktop/launch/web.ts .build/desktop/web/ash ${process.env.ASH_SMOKE_BROWSER_PORT ?? 5173}`,
			// Playwright owns shutdown; the standalone launcher's detached child would outlive it.
			env: { ASH_WEB_APP_SERVER: '0', ASH_WEB_LAUNCH_WORKER: '1' },
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
		["html", { outputFolder: ".build/desktop/playwright/report", open: "never" }],
	],
});
