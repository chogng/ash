import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, firefox } from '@playwright/test';

const resultsDirectory = process.env.ASH_STANZA_RUN_DIRECTORY ?? resolve(import.meta.dirname, '../../.build/desktop/playwright/stanza');
const installedFirefox = firefox.executablePath();
// MSIX redirects AppData access, but Windows' SxS loader probes the image's
// physical directory for Firefox's mozglue assembly. Resolve that same installed
// image before launch; listing tests must still work before browser installation.
const physicalFirefox = process.platform === 'win32' && existsSync(installedFirefox) ? realpathSync.native(installedFirefox) : undefined;

export default defineConfig({
	testDir: '.',
	testMatch: '*.spec.ts',
	forbidOnly: !!process.env.CI,
	fullyParallel: false,
	workers: 1,
	use: {
		baseURL: process.env.ASH_STANZA_BASE_URL,
		viewport: { width: 1000, height: 700 },
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
	},
	projects: [
		{ name: 'chromium', use: { browserName: 'chromium' } },
		{
			name: 'firefox', use: {
				browserName: 'firefox',
				launchOptions: physicalFirefox && physicalFirefox !== installedFirefox ? { executablePath: physicalFirefox } : undefined,
			},
		},
	],
	outputDir: resolve(resultsDirectory, 'results'),
	reporter: [['list'], ['html', { outputFolder: resolve(resultsDirectory, 'report'), open: 'never' }]],
});
