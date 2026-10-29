import { chromium, expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('files browser component', () => {
	const browserTests = useBrowserTests();

	test('picked-folder file streams preserve the requested byte range', async function () {
		const { page } = browserTests;

		await page.goto('/files.html');
		await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
		await page.evaluate(() => window.ashFilesIntegration.prepareBrowserWatch('unavailable'));
		await page.evaluate(() => window.ashFilesIntegration.changeBrowserFile('range.txt', '0123456789'));
		expect(await page.evaluate(() => window.ashFilesIntegration.readBrowserStream('range.txt', 2, 5))).toEqual([50, 51, 52, 53, 54]);
	});

	test('picked-folder observation maps both moved paths, filters excludes and recovers from missed or invalid observations', async function () {
		const { page } = browserTests;

		await page.goto('/files.html');
		const root = await page.evaluate(() => window.ashFilesIntegration.prepareBrowserWatch('available', true, ['**/*.tmp']));
		await expect.poll(() => page.evaluate(() => window.ashFilesIntegration.observations)).toEqual([{ disconnected: 0, recursive: true }]);
		await expect.poll(() => page.evaluate(() => window.ashFilesIntegration.browserWatchEvents)).toEqual([null]);
		await page.evaluate(() => {
			window.ashFilesIntegration.releaseFirstBrowserWatch();
			window.ashFilesIntegration.clearBrowserEvents();
			window.ashFilesIntegration.emitObservation(0, [
				{ type: 'appeared', relativePathComponents: ['src', 'created.ts'] },
				{ type: 'modified', relativePathComponents: ['src', 'created.ts'] },
				{ type: 'disappeared', relativePathComponents: ['removed.ts'] },
				{ type: 'moved', relativePathComponents: ['new.ts'], relativePathMovedFrom: ['old.ts'] },
				{ type: 'modified', relativePathComponents: ['ignored.tmp'] },
			]);
		});
		expect(await page.evaluate(() => window.ashFilesIntegration.browserWatchEvents)).toEqual([
			['src/created.ts', 'removed.ts', 'new.ts', 'old.ts'].map(path => `${root}/${path}`),
		]);
		expect(await page.evaluate(() => window.ashFilesIntegration.observations[0]?.disconnected)).toBe(0);
		expect(await page.evaluate(() => window.ashFilesIntegration.foregroundSubscriptions)).toBe(2);
		await page.evaluate(() => window.ashFilesIntegration.emitObservation(0, [{ type: 'unknown', relativePathComponents: [] }]));
		expect((await page.evaluate(() => window.ashFilesIntegration.browserWatchEvents)).at(-1)).toBeNull();
		await page.evaluate(() => window.ashFilesIntegration.emitObservation(0, [{ type: 'errored', relativePathComponents: [] }]));
		expect(await page.evaluate(() => window.ashFilesIntegration.observations)).toEqual([{ disconnected: 1, recursive: true }]);
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await expect.poll(() => page.evaluate(() => window.ashFilesIntegration.observations.length)).toBe(2);
		await page.evaluate(() => {
			window.ashFilesIntegration.clearBrowserEvents();
			window.ashFilesIntegration.emitObservation(0, [{ type: 'modified', relativePathComponents: ['stale.ts'] }]);
			window.ashFilesIntegration.closeBrowserWatch();
			window.ashFilesIntegration.emitObservation(1, [{ type: 'modified', relativePathComponents: ['late.ts'] }]);
		});
		expect(await page.evaluate(() => window.ashFilesIntegration.browserWatchEvents)).toEqual([]);
		expect(await page.evaluate(() => window.ashFilesIntegration.observations.map(item => item.disconnected))).toEqual([1, 1]);
		expect(await page.evaluate(() => window.ashFilesIntegration.foregroundSubscriptions)).toBe(0);
	});

	test('an offline extension retains configured folder identities without reading backend roots', async function () {
		const { page } = browserTests;

		await page.goto('/files.html');
		await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
		expect(await page.evaluate(() => window.ashFilesIntegration.offlineExtensionFolders())).toEqual(['ash-userdata:/offline-project', 'file:///disconnected-workspace', 'unregistered:///workspace']);
	});

	test('comparison groups update their accessible names and release source listeners before reload', async function () {
		const { page } = browserTests;

		await page.goto('/files.html');
		await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
		await page.evaluate(() => window.ashFilesIntegration.showComparisonGroups(false));
		await expect(page.getByRole('tab', { name: 'Before ↔ After', exact: true })).toHaveCount(2);
		await page.evaluate(() => window.ashFilesIntegration.renameComparison('Renamed'));
		await expect(page.getByRole('tab', { name: 'Renamed ↔ After', exact: true })).toHaveCount(2);
		await page.evaluate(() => window.ashFilesIntegration.closeFirstComparisonGroup());
		await page.evaluate(() => window.ashFilesIntegration.renameComparison('Still open'));
		await expect(page.getByRole('tab', { name: 'Still open ↔ After', exact: true })).toHaveCount(1);
		expect(await page.evaluate(() => window.ashFilesIntegration.saveAndCloseComparisons())).toBe(false);
		await expect(page.getByRole('tab')).toHaveCount(0);
		await page.reload();
		await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
		await page.evaluate(() => window.ashFilesIntegration.showComparisonGroups(true));
		await expect(page.getByRole('tab', { name: 'Still open ↔ After', exact: true })).toHaveCount(1);
		await expect(page.locator('#comparison-groups .ash-binary-editor-content').last()).toContainText('48 69 ff');
	});

	test('text groups share provider content and release it only after the last view closes', async function () {
		const { page } = browserTests;

		await page.goto('/files.html');
		await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
		await page.evaluate(() => window.ashFilesIntegration.showTextGroups());
		expect(await page.evaluate(() => window.ashFilesIntegration.getTextState())).toEqual({ disposed: false, resolutions: 2, values: ['Provider content', 'Provider content'], sameModel: true });
		await expect(page.getByRole('tab', { name: 'Provider text', exact: true })).toHaveCount(2);
		const controls = page.locator('#text-groups .stanza-editor-input');
		await controls.last().focus();
		await page.keyboard.insertText('must not change');
		expect((await page.evaluate(() => window.ashFilesIntegration.getTextState())).values).toEqual(['Provider content', 'Provider content']);
		await page.evaluate(() => window.ashFilesIntegration.closeFirstTextGroup());
		await expect.poll(() => page.evaluate(() => window.ashFilesIntegration.getTextState())).toEqual({ disposed: false, resolutions: 2, values: ['Remaining view'], sameModel: true });
		await expect(page.locator('#text-groups .view-lines')).toContainText('Remaining view');
		await page.evaluate(() => window.ashFilesIntegration.closeTextGroups());
		expect((await page.evaluate(() => window.ashFilesIntegration.getTextState())).disposed).toBe(true);
		await expect(page.getByRole('tab')).toHaveCount(0);
		await page.evaluate(() => window.ashFilesIntegration.reopenText());
		await expect(page.locator('#text-groups .view-lines')).toContainText('Provider content');
		expect(await page.evaluate(() => window.ashFilesIntegration.getTextState())).toEqual({ disposed: false, resolutions: 3, values: ['Provider content'], sameModel: true });
	});


	test('async file tree separates focus from reveal and restores unloaded expansion', async function () {
		const { page } = browserTests;

		await page.goto('/files.html');
		await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
		const result = await page.evaluate(() => window.ashFilesIntegration.treeFocusAndRestore());
		expect(result.beforeReveal).toBe(0);
		expect(result.saved.scrollTop).toBeGreaterThan(1000);
		expect(result.restored).toEqual(result.saved);
		expect(result.afterSelection).toBe(result.saved.scrollTop);
	});
});
