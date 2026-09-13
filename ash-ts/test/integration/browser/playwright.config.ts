import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "*.integration.spec.ts",
	outputDir: "../../../../.build/desktop/playwright/editor-results",
	fullyParallel: false,
	workers: 1,
	use: { baseURL: "http://127.0.0.1:5185" },
	projects: [
		{ name: "chromium", testIgnore: "gpuText.integration.spec.ts", use: { browserName: "chromium" } },
		{ name: "chrome-gpu", testMatch: "gpuText.integration.spec.ts", use: { browserName: "chromium", channel: "chrome", deviceScaleFactor: 1.25 } },
	],
	webServer: process.env.ASH_EDITOR_BROWSER_EXTERNAL_SERVER ? undefined : {
		command: "node ../../../node_modules/vite/bin/vite.js --config vite.config.ts",
		url: "http://127.0.0.1:5185/textModel.html",
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
	reporter: [["list"], ["html", { outputFolder: "../../../../.build/desktop/playwright/editor-report", open: "never" }]],
});
