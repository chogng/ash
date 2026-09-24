import { defineConfig } from "@playwright/test";

const browserServerMode = process.env.ASH_PLAYWRIGHT_SERVER;
if (browserServerMode === 'full' && !process.env.ASH_SMOKE_BROWSER_EXTERNAL_SERVER) {
	throw new Error('Run pnpm run test:smoke:browser:full to create an authenticated Web session.');
}
const workbenchMode = process.env.ASH_WORKBENCH_MODE === "academic" ? "academic" : "code";
const browserProjects = browserServerMode === "disconnected"
	? [{ name: "browser-ui", use: { baseURL: "http://127.0.0.1:5173" } }]
	: browserServerMode === "full"
		? [{ name: "browser-app-server", use: { baseURL: "http://127.0.0.1:5174" } }]
		: [];

export default defineConfig({
	testDir: "./test/smoke",
	outputDir: "../.build/app-ts/playwright/test-results",
	fullyParallel: false,
	workers: 1,
	projects: [
		...browserProjects,
		{ name: "electron-ui" },
		{ name: "electron-academic-ui", testMatch: "**/areas/academic/academic-workbench.spec.ts" },
		{ name: "electron-app-server" },
		{
			name: "electron-editor-app-server",
			testMatch: workbenchMode === "academic" ? "**/areas/editor/academic-open.spec.ts" : "**/areas/editor/editor-open.spec.ts",
		},
		{ name: "electron-pdf-corpus-app-server", testMatch: "**/areas/pdf/pdf-academic-corpus.spec.ts" },
	],
	webServer: process.env.ASH_SMOKE_BROWSER_EXTERNAL_SERVER
		? undefined
		: browserServerMode === "disconnected"
		? {
				command: "pnpm run build:renderer && node ../build/app_ts/launch/web.ts ../.build/app-ts/renderer/ash 5173",
				url: "http://127.0.0.1:5173/",
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
