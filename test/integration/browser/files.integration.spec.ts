import { chromium, expect, test } from '@playwright/test';

test('picked-folder file streams preserve the requested byte range', async ({ page }) => {
	await page.goto('/files.html');
	await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
	await page.evaluate(() => window.ashFilesIntegration.prepareBrowserWatch('unavailable'));
	await page.evaluate(() => window.ashFilesIntegration.changeBrowserFile('range.txt', '0123456789'));
	expect(await page.evaluate(() => window.ashFilesIntegration.readBrowserStream('range.txt', 2, 5))).toEqual([50, 51, 52, 53, 54]);
});

test('closing browser storage aborts pending writes and rejects new transactions', async ({ page }) => {
	await page.goto('/files.html');
	expect(await page.evaluate(() => window.ashFilesIntegration.abortDatabaseWrite())).toEqual({ pendingBefore: true, pendingAfter: false, rejected: true, persisted: false, closed: true });
});

test('browser files notify another window through storage events when BroadcastChannel is unavailable', async ({ page, context }) => {
	await context.addInitScript(() => Object.defineProperty(window, 'BroadcastChannel', { configurable: true, value: undefined }));
	await page.goto('/files.html');
	const other = await context.newPage();
	try {
		await other.goto('/files.html');
		await expect.poll(() => other.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
		const baseline = await other.evaluate(() => window.ashFilesIntegration.changes);
		await page.evaluate(() => window.ashFilesIntegration.write('first notification'));
		await expect.poll(() => other.evaluate(() => window.ashFilesIntegration.changes)).toBeGreaterThan(baseline);
		const first = await other.evaluate(() => window.ashFilesIntegration.changes);
		await page.evaluate(() => window.ashFilesIntegration.write('second notification'));
		await expect.poll(() => other.evaluate(() => window.ashFilesIntegration.changes)).toBeGreaterThan(first);
		expect((await other.evaluate(() => window.ashFilesIntegration.read())).content).toBe('second notification');
	} finally { await other.close(); }
});

test('picked-folder foreground fallback revalidates after external create, update and delete and stops with the watch', async ({ page }) => {
	await page.goto('/files.html');
	await page.evaluate(() => window.ashFilesIntegration.prepareBrowserWatch('unavailable'));
	expect(await page.evaluate(() => window.ashFilesIntegration.foregroundSubscriptions)).toBe(2);
	await page.evaluate(async () => {
		await window.ashFilesIntegration.changeBrowserFile('external.txt', 'first');
		window.dispatchEvent(new Event('focus'));
		document.dispatchEvent(new Event('visibilitychange'));
	});
	expect(await page.evaluate(() => window.ashFilesIntegration.browserWatchEvents)).toEqual([null]);
	expect(await page.evaluate(() => window.ashFilesIntegration.readBrowserFile('external.txt'))).toBe('first');
	await page.evaluate(async () => {
		await window.ashFilesIntegration.changeBrowserFile('external.txt', 'second');
		window.dispatchEvent(new Event('focus'));
	});
	expect(await page.evaluate(() => window.ashFilesIntegration.readBrowserFile('external.txt'))).toBe('second');
	await page.evaluate(async () => {
		await window.ashFilesIntegration.changeBrowserFile('external.txt', null);
		document.dispatchEvent(new Event('visibilitychange'));
	});
	expect(await page.evaluate(() => window.ashFilesIntegration.browserWatchEvents)).toHaveLength(3);
	await page.evaluate(() => {
		window.ashFilesIntegration.closeBrowserWatch();
		window.ashFilesIntegration.clearBrowserEvents();
		window.dispatchEvent(new Event('focus'));
		document.dispatchEvent(new Event('visibilitychange'));
	});
	expect(await page.evaluate(() => window.ashFilesIntegration.browserWatchEvents)).toEqual([]);
	expect(await page.evaluate(() => window.ashFilesIntegration.foregroundSubscriptions)).toBe(0);
});

test('picked-folder observation maps both moved paths, filters excludes and recovers from missed or invalid observations', async ({ page }) => {
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

test('picked-folder observation failure preserves foreground refresh and an in-flight watch stays cancelled', async ({ page }) => {
	await page.goto('/files.html');
	await page.evaluate(() => window.ashFilesIntegration.prepareBrowserWatch('rejected'));
	await expect.poll(() => page.evaluate(() => window.ashFilesIntegration.observations[0]?.disconnected)).toBe(1);
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect.poll(() => page.evaluate(() => window.ashFilesIntegration.browserWatchEvents)).toEqual([null]);
	await page.evaluate(() => window.ashFilesIntegration.prepareBrowserWatch('pending'));
	await expect.poll(() => page.evaluate(() => window.ashFilesIntegration.observations[0]?.recursive)).toBe(true);
	await page.evaluate(() => {
		window.ashFilesIntegration.closeBrowserProvider();
		window.ashFilesIntegration.finishObservation();
		window.dispatchEvent(new Event('focus'));
	});
	await expect.poll(() => page.evaluate(() => window.ashFilesIntegration.observations[0]?.disconnected)).toBe(2);
	expect(await page.evaluate(() => window.ashFilesIntegration.browserWatchEvents)).toEqual([]);
	expect(await page.evaluate(() => window.ashFilesIntegration.foregroundSubscriptions)).toBe(0);
});

test('picked-folder shallow watches ignore descendants and suspend invalidations while the page is hidden', async ({ page, context }) => {
	await page.goto('/files.html');
	const root = await page.evaluate(() => window.ashFilesIntegration.prepareBrowserWatch('available', false));
	await expect.poll(() => page.evaluate(() => window.ashFilesIntegration.browserWatchEvents)).toEqual([null]);
	await page.evaluate(() => {
		window.ashFilesIntegration.clearBrowserEvents();
		window.ashFilesIntegration.emitObservation(0, [
			{ type: 'modified', relativePathComponents: ['deep', 'child.ts'] },
			{ type: 'modified', relativePathComponents: ['top.ts'] },
		]);
	});
	expect(await page.evaluate(() => window.ashFilesIntegration.browserWatchEvents)).toEqual([[`${root}/top.ts`]]);
	const other = await context.newPage();
	try {
		await other.goto('/files.html');
		await other.bringToFront();
		// Headless tabs do not consistently change visibility, so set the browser boundary explicitly.
		await page.evaluate(() => {
			Object.defineProperty(document, 'hidden', { configurable: true, value: true });
			window.ashFilesIntegration.clearBrowserEvents();
			window.dispatchEvent(new Event('focus'));
			document.dispatchEvent(new Event('visibilitychange'));
			window.ashFilesIntegration.emitObservation(0, [{ type: 'modified', relativePathComponents: ['top.ts'] }]);
		});
		expect(await page.evaluate(() => window.ashFilesIntegration.browserWatchEvents)).toEqual([]);
		await page.evaluate(() => {
			Reflect.deleteProperty(document, 'hidden');
			document.dispatchEvent(new Event('visibilitychange'));
		});
		expect(await page.evaluate(() => window.ashFilesIntegration.browserWatchEvents)).toEqual([null]);
	} finally { await other.close(); }
});

test('picked-folder permission revocation stops observation without prompting and resumes after permission is restored', async ({ page }) => {
	await page.goto('/files.html');
	await page.evaluate(() => window.ashFilesIntegration.prepareBrowserWatch('available'));
	await expect.poll(() => page.evaluate(() => window.ashFilesIntegration.browserWatchEvents)).toEqual([null]);
	await page.evaluate(() => {
		window.ashFilesIntegration.setBrowserPermission('denied');
		window.ashFilesIntegration.emitObservation(0, [{ type: 'errored', relativePathComponents: [] }]);
		window.dispatchEvent(new Event('focus'));
	});
	await expect.poll(() => page.evaluate(() => window.ashFilesIntegration.permissionQueries)).toBe(1);
	expect(await page.evaluate(() => window.ashFilesIntegration.permissionRequests)).toBe(0);
	expect(await page.evaluate(() => window.ashFilesIntegration.observations)).toEqual([{ disconnected: 1, recursive: true }]);
	await page.evaluate(() => {
		window.ashFilesIntegration.setBrowserPermission('granted');
		window.dispatchEvent(new Event('focus'));
	});
	await expect.poll(() => page.evaluate(() => window.ashFilesIntegration.observations.length)).toBe(2);
	expect(await page.evaluate(() => window.ashFilesIntegration.permissionRequests)).toBe(0);
});

test('picked-folder watches receive real browser filesystem observation events', async ({ baseURL }) => {
	const browser = await chromium.launch({ args: ['--enable-blink-features=FileSystemObserver'] });
	try {
		const context = await browser.newContext({ baseURL });
		const page = await context.newPage();
		await page.goto('/files.html');
		expect(await page.evaluate(() => typeof (window as Window & { FileSystemObserver?: unknown; }).FileSystemObserver)).toBe('function');
		const root = await page.evaluate(() => window.ashFilesIntegration.prepareBrowserWatch('real'));
		await expect.poll(() => page.evaluate(() => window.ashFilesIntegration.browserWatchEvents)).toEqual([null]);
		await page.evaluate(() => window.ashFilesIntegration.changeBrowserFile('observed.txt', 'outside provider'));
		await expect.poll(() => page.evaluate(() => window.ashFilesIntegration.browserWatchEvents.flat())).toContain(`${root}/observed.txt`);
		expect(await page.evaluate(() => window.ashFilesIntegration.readBrowserFile('observed.txt'))).toBe('outside provider');
		await context.close();
	} finally { await browser.close(); }
});

test('an offline extension sees accessible browser roots and excludes registered inaccessible backend roots', async ({ page }) => {
	await page.goto('/files.html');
	await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
	expect(await page.evaluate(() => window.ashFilesIntegration.offlineExtensionFolders())).toEqual(['ash-userdata:/offline-project']);
});

test('browser files persist through reload and reject competing saves from two windows', async ({ page, context }) => {
	await page.goto('/files.html');
	await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
	expect(await page.evaluate(() => window.ashFilesIntegration.write('// initial\n[]'))).toBe('saved');
	const baseline = await page.evaluate(() => window.ashFilesIntegration.read());
	const other = await context.newPage();
	try {
		await other.goto('/files.html');
		await expect.poll(() => other.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
		const results = await Promise.all([
			page.evaluate(revision => window.ashFilesIntegration.write('// first\n[]', revision), baseline.revision),
			other.evaluate(revision => window.ashFilesIntegration.write('// second\n[]', revision), baseline.revision),
		]);
		expect(results.sort()).toEqual(['FileRevisionConflictError', 'saved']);
		await expect.poll(() => other.evaluate(() => window.ashFilesIntegration.changes)).toBeGreaterThan(0);
		const result = await page.evaluate(() => window.ashFilesIntegration.read());
		expect(result.content).toMatch(/first|second/u);
		await page.reload();
		await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
		expect((await page.evaluate(() => window.ashFilesIntegration.read())).content).toBe(result.content);
		expect(await page.evaluate(() => window.ashFilesIntegration.copyAndRename())).toEqual([result.content, result.content]);
	} finally { await other.close(); }
});


test('binary imports retain exact bytes after reload and never replace an existing empty file', async ({ page }) => {
	await page.goto('/files.html');
	await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
	expect(await page.evaluate(() => window.ashFilesIntegration.importBytes('empty.bin', []))).toBe('saved');
	expect(await page.evaluate(() => window.ashFilesIntegration.importBytes('empty.bin', [255]))).toBe('File already exists');
	expect(await page.evaluate(() => window.ashFilesIntegration.readBytes('empty.bin'))).toEqual([]);
	expect(await page.evaluate(() => window.ashFilesIntegration.importBytes('binary.bin', [0, 255, 239, 187, 191]))).toBe('saved');
	await page.reload();
	await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
	expect(await page.evaluate(() => window.ashFilesIntegration.readBytes('binary.bin'))).toEqual([0, 255, 239, 187, 191]);
});

test('binary comparison reloads both byte previews and resolves their file paths', async ({ page }) => {
	await page.goto('/files.html');
	await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
	for (const restored of [false, true]) {
		if (restored) {
			await page.reload();
			await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
		}
		expect(await page.evaluate(restored => window.ashFilesIntegration.showBinaryComparison(restored), restored)).toEqual({ primary: '/binary/after.bin', secondary: '/binary/before.bin' });
		const sides = page.locator('#binary-comparison .ash-side-by-side-editor > section');
		await expect(sides).toHaveCount(2);
		await expect(sides.first().locator('.ash-binary-editor-content')).toContainText('48 69');
		await expect(sides.last().locator('.ash-binary-editor-content')).toContainText('48 69 00 ff');
		await expect(sides.last().getByRole('region')).toBeFocused();
		// This page imports the pane directly; its styles must not depend on product contributions.
		expect(await sides.last().getByRole('region').evaluate(element => ({
			display: getComputedStyle(element).display,
			direction: getComputedStyle(element).flexDirection,
			font: getComputedStyle(element.querySelector('.ash-binary-editor-content')!).fontFamily,
		}))).toEqual({ display: 'flex', direction: 'column', font: 'monospace' });
		const boxes = await sides.evaluateAll(elements => elements.map(element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right })));
		expect(boxes[1]!.left).toBeGreaterThanOrEqual(boxes[0]!.right);
	}
});

test('comparison groups update their accessible names and release source listeners before reload', async ({ page }) => {
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

test('text groups share provider content and release it only after the last view closes', async ({ page }) => {
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
