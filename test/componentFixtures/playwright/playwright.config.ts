import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import { readFixtureOptions } from '../cssOrderShared.mts';

const options = readFixtureOptions();
const runDirectory = process.env.ASH_EDITOR_BROWSER_RUN_DIRECTORY ?? resolve(import.meta.dirname, '../../../.build/desktop/playwright/component-fixtures');

export default defineConfig({
	testDir: './tests', testMatch: '*.spec.ts', forbidOnly: !!process.env.CI,
	workers: 1, fullyParallel: false, timeout: options.budgetMs + 60_000,
	metadata: { fixtureOptions: options },
	outputDir: resolve(runDirectory, 'results'),
	use: {
		baseURL: process.env.ASH_EDITOR_BROWSER_BASE_URL,
		viewport: { width: 1100, height: 900 }, contextOptions: { reducedMotion: 'reduce' }, trace: 'retain-on-failure',
	},
	projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
	reporter: [['list'], ['html', { outputFolder: resolve(runDirectory, 'report'), open: 'never' }]],
});
