import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

// CLI file filters are ORed together. Keep the editor scope in testMatch so a
// user-supplied file filter narrows that scope instead of adding to it.
const editorSpecs = [
	"academic.integration.spec.ts",
	"diff.integration.spec.ts",
	"gpuText.integration.spec.ts",
	"iPadShowKeyboard.integration.spec.ts",
	"language.integration.spec.ts",
	"loading.integration.spec.ts",
	"standalone.integration.spec.ts",
	"textModel.integration.spec.ts",
	"themes.integration.spec.ts",
	"tokenization.integration.spec.ts",
];

const runDirectory = process.env.ASH_EDITOR_BROWSER_RUN_DIRECTORY;

export default defineConfig({
	testDir: ".",
	testMatch: process.env.ASH_EDITOR_BROWSER_ONLY === "1" ? editorSpecs : "*.integration.spec.ts",
	outputDir: runDirectory ? resolve(runDirectory, "results") : "../../../.build/desktop/playwright/editor-results",
	fullyParallel: false,
	workers: 1,
	use: { baseURL: process.env.ASH_EDITOR_BROWSER_BASE_URL ?? "http://127.0.0.1:5185" },
	projects: [
		{ name: "chromium", testIgnore: "gpuText.integration.spec.ts", use: { browserName: "chromium" } },
		{ name: "chrome-gpu", testMatch: "gpuText.integration.spec.ts", use: { browserName: "chromium", channel: "chrome", deviceScaleFactor: 1.25 } },
	],
	webServer: process.env.ASH_EDITOR_BROWSER_EXTERNAL_SERVER ? undefined : {
		command: "node ../../../node_modules/vite/bin/vite.js build --config vite.config.ts && node ../../../build/desktop/launch/web.ts ../../../.build/desktop/editor-browser 5185",
		url: "http://127.0.0.1:5185/textModel.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
	reporter: [["list"], ["html", { outputFolder: runDirectory ? resolve(runDirectory, "report") : "../../../.build/desktop/playwright/editor-report", open: "never" }]],
});
