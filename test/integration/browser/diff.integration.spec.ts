import { attachRustGit } from '../../fixtures/browser/rustGitProcessFixture.js';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

let stopRust: (() => Promise<void>) | undefined;
test.beforeEach(async ({ page }) => { stopRust = await attachRustGit(page); });
test.afterEach(async () => { await stopRust?.(); stopRust = undefined; });

type DiffTestLocale = 'en' | 'zh-CN';

function localized(locale: DiffTestLocale, english: string, chinese: string): string {
	return locale === 'zh-CN' ? chinese : english;
}

async function openDiffPage(page: Page, locale: DiffTestLocale = 'en'): Promise<void> {
	await page.goto(`/diff.html?locale=${locale}`);
	await page.waitForFunction(() => !!window.ashDiffIntegration);
}

async function clickFileAction(section: Locator, name: string): Promise<void> {
	// File actions become interactive on hover or keyboard focus.
	await section.locator('.stanza-multi-diff-editor-header').hover();
	await section.getByRole('button', { name, exact: true }).click();
}

test('diff highlights name hyphens continuously while retaining subtraction in both view modes', async ({ page }, testInfo) => {
	await openDiffPage(page, 'zh-CN');
	for (const sideBySide of [true, false]) {
		await page.evaluate(sideBySide => {
			window.ashDiffIntegration.setTheme('vs');
			window.ashDiffIntegration.setViewMode(sideBySide, false, 900);
			window.ashDiffIntegration.setComparisonText(
				'.ash-chat-body.sessions-sidebar-visible > .ash-chat-pane-host {',
				'.ash-chat-body.sessions-side-by-side > .ash-chat-sessions-sidebar {',
				'css',
			);
		}, sideBySide);
		await expect.poll(() => page.evaluate(() => [
			window.ashDiffIntegration.readCharacterChanges('original'),
			window.ashDiffIntegration.readCharacterChanges('modified'),
		])).toEqual([['sidebar-visible', 'pane-host'], ['side-by-side', 'sessions-sidebar']]);
		// Live editors paint background rectangles; inline deleted rows decorate text spans.
		const added = page.locator('#single .modified .cdr.stanza-diff-inline-added');
		await expect(added).toHaveCount(2);
		for (const highlight of await added.all()) {
			await expect(highlight).toBeVisible();
		}
		if (sideBySide) {
			await expect(page.locator('#single .original .cdr.stanza-diff-inline-removed')).toHaveCount(2);
		} else {
			await expect.poll(async () => (await page.locator('#single .stanza-diff-inline-original-line .stanza-diff-inline-removed').allTextContents()).join('')).toBe('sidebar-visiblepane-host');
		}
		await testInfo.attach(`name-hyphens-${sideBySide ? 'side-by-side' : 'inline'}`, { body: await page.locator('#single').screenshot(), contentType: 'image/png' });

		await page.evaluate(() => window.ashDiffIntegration.setComparisonText('const value = first-second;', 'const value = alpha-beta;', 'javascript'));
		await expect.poll(() => page.evaluate(() => [
			window.ashDiffIntegration.readCharacterChanges('original'),
			window.ashDiffIntegration.readCharacterChanges('modified'),
		])).toEqual([['first', 'second'], ['alpha', 'beta']]);
		await expect(added).toHaveCount(2);
		const bounds = await added.evaluateAll(nodes => nodes.map(node => {
			const rect = node.getBoundingClientRect();
			return { left: rect.left, right: rect.right };
		}));
		expect(bounds[1]!.left).toBeGreaterThan(bounds[0]!.right);
		if (!sideBySide) {
			await expect.poll(async () => (await page.locator('#single .stanza-diff-inline-original-line .stanza-diff-inline-removed').allTextContents()).join('')).toBe('firstsecond');
		}
	}
});

test('sash dragging under CPU throttling retains inline diff zones and skips unaffected grid leaves', async ({ page }, testInfo) => {
	await openDiffPage(page, 'zh-CN');
	const shared = Array.from({ length: 200 }, (_, index) => `shared ${index}`).join('\n');
	await page.evaluate(([left, right]) => {
		window.ashDiffIntegration.setComparisonText(left, right);
		window.ashDiffIntegration.setViewMode(false, false, 900);
	}, [`first\nremoved\n${shared}`, `first\n${shared}`]);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await page.evaluate(() => window.ashDiffIntegration.mountResizeGrid());
	const deletion = page.locator('#single .stanza-diff-inline-original-line').first();
	await expect(deletion).toHaveText('removed');
	const retainedDeletion = await deletion.elementHandle();
	const sash = page.locator('#single .ash-grid-view > .ash-split-view > .ash-sash').nth(1);
	const bounds = await sash.boundingBox();
	expect(bounds).not.toBeNull();
	const cdp = await page.context().newCDPSession(page);
	try {
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
		await cdp.send('Profiler.enable');
		await cdp.send('Profiler.start');
		const x = bounds!.x + bounds!.width / 2;
		const y = bounds!.y + bounds!.height / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x + 60, y, { steps: 20 });
		await page.mouse.up();
		const state = await page.evaluate(() => window.ashDiffIntegration.resizeGridState());
		expect(state.sizes).toEqual([180, 500, 220]);
		expect(state.layouts[0]).toBe(0);
		expect(state.layouts[1]).toBeGreaterThan(0);
		expect(state.layouts[2]).toBe(state.layouts[1]);
		expect(await retainedDeletion!.evaluate(node => node === document.querySelector('#single .stanza-diff-inline-original-line'))).toBe(true);
		await sash.focus();
		await page.keyboard.press('ArrowLeft');
		expect((await page.evaluate(() => window.ashDiffIntegration.resizeGridState())).sizes).toEqual([180, 490, 230]);
		await expect(sash).toHaveAttribute('aria-valuenow', '490');
		const { profile } = await cdp.send('Profiler.stop');
		const profilePath = testInfo.outputPath('sash-resize.cpuprofile');
		await writeFile(profilePath, JSON.stringify(profile));
		await testInfo.attach('sash-resize-cpu', { path: profilePath, contentType: 'application/json' });
		await testInfo.attach('sash-resize-layouts', { body: JSON.stringify(state), contentType: 'application/json' });
	} finally {
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
		await cdp.detach();
		await retainedDeletion?.dispose();
	}
});

test('diff scrolling keeps retained decorations stable during wheel input', async ({ page }, testInfo) => {
	await openDiffPage(page);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.locator('#single').evaluate(node => { node.style.height = '720px'; });
	const original = Array.from({ length: 1200 }, (_, index) => `export const entry${index} = ${index};`);
	const modified = original.map((line, index) => index % 5 === 0 ? `${line} // changed` : line);
	await page.evaluate(([left, right]) => {
		window.ashDiffIntegration.setViewMode(false, false, 900);
		window.ashDiffIntegration.setComparisonText(left, right);
	}, [original.join('\n'), modified.join('\n')]);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const samples = await page.evaluate(async () => {
		const editor = document.querySelector<HTMLElement>('#single .modified .stanza-editor')!;
		const diff = document.querySelector('#single .stanza-diff-editor')!;
		const nextFrame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
		// Warm the text and decorations before measuring an identical scroll range.
		for (let frame = 0; frame < 20; frame++) {
			editor.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }));
			await nextFrame();
		}
		const output = [];
		for (let sample = 0; sample < 3; sample++) {
			window.ashDiffIntegration.scrollModified(400);
			await nextFrame();
			await nextFrame();
			let retainedOverlayReplacements = 0;
			let overviewUpdates = 0;
			const observer = new MutationObserver(records => {
				for (const record of records) {
					if (!(record.target instanceof Element)) continue;
					if (record.target.matches('.view-overlay-line') && record.removedNodes.length > 0 && record.addedNodes.length > 0) retainedOverlayReplacements++;
					if (record.target.matches('.stanza-diff-overview-lane')) overviewUpdates++;
				}
			});
			const layoutEvents = window.ashDiffIntegration.layoutEventCount;
			observer.observe(diff, { childList: true, subtree: true });
			const intervals = [];
			const wheelDurations = [];
			let previous = await nextFrame();
			try {
				for (let frame = 0; frame < 90; frame++) {
					const start = performance.now();
					editor.dispatchEvent(new WheelEvent('wheel', { deltaY: frame < 45 ? 40 : -40, bubbles: true, cancelable: true }));
					wheelDurations.push(performance.now() - start);
					const now = await nextFrame();
					intervals.push(now - previous);
					previous = now;
				}
				await nextFrame();
				output.push({
					intervals,
					wheelDurations,
					retainedOverlayReplacements,
					overviewUpdates,
					layoutEvents: window.ashDiffIntegration.layoutEventCount - layoutEvents,
					finalTop: window.ashDiffIntegration.linePositions(1, 1).modifiedScrollTop,
				});
			} finally {
				observer.disconnect();
			}
		}
		return output;
	});
	const samplePath = testInfo.outputPath('diff-scroll-samples.json');
	await writeFile(samplePath, JSON.stringify(samples, null, 2));
	await testInfo.attach('diff-scroll-samples', { path: samplePath, contentType: 'application/json' });
	for (const sample of samples) {
		expect(sample.finalTop).toBe(400);
		expect(sample.layoutEvents).toBe(0);
		expect(sample.overviewUpdates).toBe(0);
		expect(sample.retainedOverlayReplacements).toBe(0);
	}
});

test('diff scrolling in a tall inline viewport preserves visible rows and keyboard focus', async ({ page }, testInfo) => {
	await openDiffPage(page, 'zh-CN');
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.locator('#single').evaluate(node => { node.style.height = '720px'; });
	const original = Array.from({ length: 1200 }, (_, index) => `export const entry${index} = ${index};`);
	const modified = original.map((line, index) => index % 5 === 0 ? `${line} // changed` : line);
	await page.evaluate(([left, right]) => {
		window.ashDiffIntegration.setTheme('vs');
		window.ashDiffIntegration.setViewMode(false, false, 900);
		window.ashDiffIntegration.setComparisonText(left, right);
	}, [original.join('\n'), modified.join('\n')]);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const editor = page.locator('#single .modified .stanza-editor');
	const input = editor.locator('.stanza-editor-input');
	await input.focus();
	const before = await page.evaluate(() => window.ashDiffIntegration.layoutEventCount);
	const cdp = await page.context().newCDPSession(page);
	try {
		await cdp.send('Performance.enable');
		await cdp.send('Profiler.enable');
		await cdp.send('Profiler.start');
		await editor.hover();
		for (let iteration = 0; iteration < 30; iteration++) {
			await page.mouse.wheel(0, 80);
		}
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.linePositions(1, 1).modifiedScrollTop)).toBe(2400);
		await expect(input).toBeFocused();
		expect(await page.evaluate(() => window.ashDiffIntegration.layoutEventCount)).toBe(before);
		const geometry = await editor.evaluate(node => {
			const bounds = node.getBoundingClientRect();
			const lines = [...node.querySelectorAll('.view-lines .view-line')].map(line => line.getBoundingClientRect());
			return { height: bounds.height, visibleRows: lines.filter(line => line.bottom > bounds.top && line.top < bounds.bottom).length };
		});
		expect(geometry.height).toBeGreaterThan(700);
		expect(geometry.visibleRows).toBeGreaterThan(25);
		await testInfo.attach('tall-inline-diff', { body: await page.locator('#single').screenshot(), contentType: 'image/png' });
		const { profile } = await cdp.send('Profiler.stop');
		const metrics = await cdp.send('Performance.getMetrics');
		const profilePath = testInfo.outputPath('tall-inline-diff.cpuprofile');
		await writeFile(profilePath, JSON.stringify(profile));
		await testInfo.attach('tall-inline-diff-cpu', { path: profilePath, contentType: 'application/json' });
		await testInfo.attach('tall-inline-diff-metrics', { body: JSON.stringify(metrics), contentType: 'application/json' });
	} finally {
		await cdp.detach();
	}
});

test.afterEach(async ({ page }) => {
	await page.evaluate(() => window.ashDiffIntegration?.dispose());
});

for (const locale of ['en', 'zh-CN'] as const) {

	test(`multi diff updates configuration and uses scoped file menus (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('git'));
		const host = page.locator('#title-comparison');
		const sections = host.locator('.stanza-multi-diff-editor-section');
		await expect(sections).toHaveCount(2);
		await sections.nth(1).locator('.stanza-multi-diff-editor-header-toggle').focus();
		const files = host.getByRole('button', { name: localized(locale, 'Files', '文件'), exact: true });
		await files.focus();
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readMultiDiffFoundation().activeCodeEditor)).toBe(true);
		expect(await page.evaluate(() => window.ashDiffIntegration.readMultiDiffFoundation().active)).toBe('src/second.ts');
		const inspect = sections.first().getByRole('button', { name: 'Inspect File', exact: true });
		await expect(inspect).toBeVisible();
		await expect(sections.nth(1).getByRole('button', { name: 'Inspect File', exact: true })).toHaveCount(0);
		await inspect.focus();
		await inspect.press('Enter');
		expect(await page.evaluate(() => window.ashDiffIntegration.readMultiDiffFoundation().inspected)).toEqual(['file:///workspace/src/first.ts']);
		await page.evaluate(async () => {
			await window.ashDiffIntegration.updateTitleEditorConfiguration('editor.fontSize', 18);
			await window.ashDiffIntegration.updateTitleEditorConfiguration('editor.lineHeight', 30);
			await window.ashDiffIntegration.updateTitleEditorConfiguration('editor.fontFamily', 'Courier New');
			await window.ashDiffIntegration.updateTitleEditorConfiguration('editor.fontLigatures', true);
			await window.ashDiffIntegration.updateTitleEditorConfiguration('diffEditor.showLineNumbers', false);
			await window.ashDiffIntegration.updateTitleEditorConfiguration('diffEditor.showInlineChanges', false);
			await window.ashDiffIntegration.updateTitleEditorConfiguration('diffEditor.loopChanges', false);
		});
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readMultiDiffFoundation().fonts)).toEqual([18, 18]);
		expect(await page.evaluate(() => window.ashDiffIntegration.readMultiDiffFoundation().lines)).toEqual([30, 30]);
		await expect(host.locator('.stanza-multi-diff-editor')).toHaveClass(/hide-line-numbers/);
		await expect(host.locator('.stanza-diff-inline-added, .stanza-diff-inline-removed')).toHaveCount(0);
		await expect(sections.first().locator('.stanza-editor').first()).toHaveCSS('font-family', /Courier New/);
		await page.evaluate(() => window.ashDiffIntegration.updateTitleGit(['src/first.ts', 'src/second.ts', 'src/third.ts'], 2));
		await expect(sections).toHaveCount(3);
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readMultiDiffFoundation().lines)).toEqual([30, 30, 30]);
	});

	test(`multi diff refreshes live Git without changing tabs or losing file state (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('git'));
		const host = page.locator('#title-comparison');
		const sections = host.locator('.stanza-multi-diff-editor-section');
		await expect(sections).toHaveCount(2);
		await sections.first().locator('.stanza-multi-diff-editor-header-toggle').click();
		await sections.nth(1).locator('.stanza-multi-diff-editor-header-toggle').focus();
		const tabs = host.getByRole('tab');
		const originalTab = await tabs.first().textContent();
		await page.evaluate(() => window.ashDiffIntegration.updateTitleGit(['src/first.ts', 'src/second.ts', 'src/stale.ts'], 2, 150));
		await page.evaluate(() => window.ashDiffIntegration.updateTitleGit(['src/first.ts', 'src/second.ts', 'src/latest.ts'], 3));
		await expect(sections).toHaveCount(3);
		await expect(host.locator('.stanza-multi-diff-editor-title .ash-icon-label-text')).toHaveText(['first.ts', 'second.ts', 'latest.ts']);
		await expect(host.locator('.stanza-multi-diff-editor-title .ash-icon-label-description')).toHaveText(['src', 'src', 'src']);
		await expect(sections.first().locator('.stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-expanded', 'false');
		expect(await page.evaluate(() => window.ashDiffIntegration.readMultiDiffFoundation().active)).toBe('src/second.ts');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readMultiDiffFoundation().contents)).toEqual(['src/second.ts revision 3\nshared', 'src/latest.ts revision 3\nshared']);
		await expect(tabs).toHaveCount(1);
		await expect(tabs.first()).toHaveText(originalTab!);
		await page.evaluate(() => window.ashDiffIntegration.updateTitleGit([], 4));
		await expect(sections).toHaveCount(0);
		await expect(host.locator('.stanza-multi-diff-editor-empty')).toHaveText(localized(locale, 'No changes in this selection.', '此选择中没有更改。'));
		await page.evaluate(() => window.ashDiffIntegration.updateTitleGit(['src/returned.ts'], 5));
		await expect(host.locator('.stanza-multi-diff-editor-title .ash-icon-label-text')).toHaveText(['returned.ts']);
		await expect(host.locator('.stanza-multi-diff-editor-empty')).toBeHidden();
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readMultiDiffFoundation().contents)).toEqual(['src/returned.ts revision 5\nshared']);
	});
}

for (const locale of ['en', 'zh-CN'] as const) {
	test(`multi diff displays binary-only files without code editors (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('binary'));
		const pane = page.locator('#title-comparison .stanza-multi-diff-editor-pane');
		const binary = pane.locator('.stanza-multi-diff-editor-item-editor.binary');
		await expect(binary).toHaveText(localized(locale, 'Binary file changed. Text comparison is unavailable.', '二进制文件已更改，无法进行文本比较。'));
		await expect(pane.locator('.stanza-editor-input')).toHaveCount(0);
		await expect(pane.getByRole('button', { name: localized(locale, 'Open File', '打开文件'), exact: true })).toBeVisible();
		await binary.focus();
		await expect(binary).toBeFocused();
		await expect(binary).toHaveCSS('outline-style', 'solid');
		const header = pane.getByRole('button', { name: /image.bin/ }).first();
		await header.click();
		await expect(header).toHaveAttribute('aria-expanded', 'false');
		await header.click();
		await expect(binary).toBeVisible();
		expect(await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence())).toMatchObject({ dirty: false, copies: 0, writes: [], tabs: 1 });
	});

	test(`multi diff saves collapsed writable files from an inactive tab and retains failed edits (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('writable'));
		const pane = page.locator('#title-comparison .stanza-multi-diff-editor-pane');
		for (const name of ['first', 'second']) {
			const section = pane.locator('.stanza-multi-diff-editor-section').filter({ has: page.getByRole('button', { name: new RegExp(`${name}\\.ts`) }) });
			const input = section.locator('.stanza-diff-editor-side.modified .stanza-editor-input');
			await input.focus();
			await page.keyboard.press('ControlOrMeta+End');
			await page.keyboard.type(` ${name} edit`);
			await section.getByRole('button', { name: new RegExp(`${name}\\.ts`) }).click();
		}
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readTitlePersistence().dirty)).toBe(true);
		expect(await page.evaluate(() => window.ashDiffIntegration.closeWritableTitle())).toBe(false);
		expect(await page.evaluate(() => window.ashDiffIntegration.saveTitleFiles(true))).toBe('Save rejected');
		expect((await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence())).dirty).toBe(true);
		await page.evaluate(() => window.ashDiffIntegration.openOtherTitleFile());
		const active = (await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence())).active;
		expect(await page.evaluate(() => window.ashDiffIntegration.saveTitleFiles())).toBeUndefined();
		expect(await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence())).toMatchObject({
			dirty: false, tabs: 2, active, writes: [{ resource: '/workspace/first.ts', text: 'after first edit' }, { resource: '/workspace/second.ts', text: 'after second edit' }],
		});
		expect(await page.evaluate(() => window.ashDiffIntegration.closeWritableTitle())).toBe(true);
		expect((await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence())).copies).toBe(0);
	});
}

for (const locale of ['en', 'zh-CN'] as const) test(`session Changes keeps Viewed bound to the captured revision across refresh (${locale})`, async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await openDiffPage(page, locale);
	await page.evaluate(() => window.ashDiffIntegration.openSessionChanges());
	await page.evaluate(() => window.ashDiffIntegration.selectSessionCapture('review-change', 'transient'));
	const message = page.locator('#session-changes .ash-sessions-editor-message');
	await expect(message).toBeHidden();
	const first = page.locator('#session-changes .stanza-multi-diff-editor-section').filter({ has: page.getByText('file-0.ts', { exact: true }) });
	const viewed = first.getByRole('button', { name: localized(locale, 'Viewed', '已查看'), exact: true });
	await clickFileAction(first, localized(locale, 'Viewed', '已查看'));
	await expect(viewed).toHaveAttribute('aria-pressed', 'true');
	await viewed.focus();
	await page.evaluate(() => window.ashDiffIntegration.advanceSessionRevision());
	await expect(message).toContainText(localized(locale, 'This Turn capture changed while loading.', '此回合的更改在加载期间已更新。'));
	await expect(page.locator('#session-changes .stanza-multi-diff-editor-section')).toHaveCount(0);
	expect(await page.evaluate(() => window.ashDiffIntegration.readSessionComparisonState())).toEqual({ hasControl: false, accessibleContent: await message.textContent() });
	await expect(page.locator('#session-changes .ash-sessions-changes-editor')).toBeFocused();
	await page.evaluate(() => window.ashDiffIntegration.selectSessionCapture('review-change'));
	await expect(message).toBeHidden();
	await expect(viewed).toHaveAttribute('aria-pressed', 'false');
	await expect(first.getByRole('button', { name: /file-0.ts/ })).toHaveAttribute('aria-expanded', 'true');
	await page.evaluate(() => window.ashDiffIntegration.reviewSessionFile(0, 1, true));
	await expect(viewed).toHaveAttribute('aria-pressed', 'false');
	await clickFileAction(first, localized(locale, 'Viewed', '已查看'));
	await expect(viewed).toHaveAttribute('aria-pressed', 'true');
	await page.evaluate(() => window.ashDiffIntegration.advanceSessionRevision());
	await expect(message).toBeHidden();
	await expect(viewed).toHaveAttribute('aria-pressed', 'false');
	await expect(first.getByRole('button', { name: /file-0.ts/ })).toHaveAttribute('aria-expanded', 'true');
	expect(errors).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) test(`session Changes rejects content read across a capture revision and recovers (${locale})`, async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await openDiffPage(page, locale);
	await page.evaluate(() => window.ashDiffIntegration.openSessionChanges());
	await page.locator('#modified').focus();
	await page.evaluate(() => window.ashDiffIntegration.changeSessionCaptureDuringRead());
	const message = page.locator('#session-changes .ash-sessions-editor-message');
	await expect(message).toContainText(localized(locale, 'This Turn capture changed while loading.', '此回合的更改在加载期间已更新。'));
	await expect(page.locator('#session-changes .stanza-multi-diff-editor-section')).toHaveCount(0);
	expect(await page.evaluate(() => window.ashDiffIntegration.readSessionComparisonState())).toEqual({ hasControl: false, accessibleContent: await message.textContent() });
	await expect(page.locator('#modified')).toBeFocused();
	await page.evaluate(() => window.ashDiffIntegration.selectSessionCapture('review-change'));
	await expect(message).toBeHidden();
	const first = page.locator('#session-changes .stanza-multi-diff-editor-section').filter({ has: page.getByText('file-0.ts', { exact: true }) });
	await clickFileAction(first, localized(locale, 'Viewed', '已查看'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.sessionReviewState())).toEqual(['ash-turn-diff:/review-change/file-0.ts?session=review&thread=review-thread&revision=2']);
	expect(errors).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) test(`session Changes reveals a lazy file, reviews its revision and decorates the input (${locale})`, async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await openDiffPage(page, locale);
	await page.evaluate(() => window.ashDiffIntegration.openSessionChanges());
	await expect(page.locator('#session-changes .ash-sessions-editor-message')).toBeHidden();
	const label = page.locator('#session-changes-label .ash-icon-label');
	await expect.poll(() => label.evaluate(element => getComputedStyle(element, '::after').content)).toBe('"8"');
	for (const theme of ['dark', 'light', 'contrast'] as const) {
		await page.evaluate(theme => window.ashDiffIntegration.sessionTheme(theme), theme);
		await expect.poll(() => label.evaluate(element => getComputedStyle(element, '::after').backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
		if (theme === 'contrast') { await expect.poll(() => label.evaluate(element => getComputedStyle(element, '::after').borderTopColor)).not.toBe('rgba(0, 0, 0, 0)'); }
	}
	await page.evaluate(() => window.ashDiffIntegration.revealSessionFile(7));
	const row = page.locator('#session-changes .stanza-multi-diff-editor-section').filter({ has: page.getByText('file-7.ts', { exact: true }) });
	const toggle = row.getByRole('button', { name: /file-7.ts/ });
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	await expect(row.locator('.stanza-diff-editor')).toBeVisible();
	const viewed = row.getByRole('button', { name: localized(locale, 'Viewed', '已查看'), exact: true });
	await viewed.focus();
	await page.keyboard.press('Space');
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.sessionReviewState())).toEqual(['ash-turn-diff:/review-change/file-7.ts?session=review&thread=review-thread&revision=1']);
	await clickFileAction(row, localized(locale, 'Viewed', '已查看'));
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	await clickFileAction(row, localized(locale, 'Open File', '打开文件'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.sessionOpenedFiles())).toEqual(['file:///workspace/file-7.ts']);
	await clickFileAction(row, localized(locale, 'Collapse Unchanged Regions', '折叠未更改区域'));
	await expect(row.locator('.ash-diff-hidden-region')).not.toHaveCount(0);
	await clickFileAction(row, localized(locale, 'Expand Full File', '展开整个文件'));
	await expect(row.locator('.ash-diff-hidden-region')).toHaveCount(0);
	await clickFileAction(row, localized(locale, 'Preview commit…', '预览提交…'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.sessionPreparedFiles())).toEqual([{ selections: [{ changeSetId: 'review-change', expectedRevision: 1, paths: ['file-7.ts'] }], message: 'Reviewed file' }]);
	expect(await page.evaluate(() => window.ashDiffIntegration.rejectInvalidSessionReveal())).toBe(true);
	await page.evaluate(() => window.ashDiffIntegration.advanceSessionRevision());
	await expect(page.locator('#session-changes .ash-sessions-editor-message')).toBeHidden();
	await page.evaluate(() => window.ashDiffIntegration.reviewSessionFile(7, 1));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.sessionReviewState())).toEqual([]);
	await page.evaluate(() => window.ashDiffIntegration.reviewSessionFile(7, 2, true));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.sessionReviewState())).toEqual(['ash-turn-diff:/review-change/file-7.ts?session=review&thread=review-thread&revision=2']);
	await page.evaluate(() => window.ashDiffIntegration.unsealSessionCapture());
	await expect(page.locator('#session-changes .ash-sessions-editor-message')).toBeHidden();
	await page.evaluate(() => window.ashDiffIntegration.revealSessionFile(7));
	await expect(row.getByRole('button', { name: localized(locale, 'Preview commit…', '预览提交…'), exact: true })).toBeDisabled();
	expect(errors).toEqual([]);
});

test('diff feature revert buttons support keyboard, undo, read-only and live options', async ({ page }) => {
	await openDiffPage(page);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const button = page.locator('#single .ash-diff-revert').getByRole('button', { name: 'Revert change', exact: true });
	await expect(button).toBeVisible();
	await button.focus();
	await page.keyboard.press('Space');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toBe('same\nbefore 😀 after\nlast');
	await page.evaluate(() => window.ashDiffIntegration.undo());
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await expect(button).toBeVisible();
	await page.evaluate(() => window.ashDiffIntegration.setEditorFeatures({ readOnly: true }));
	await expect(button).toHaveCount(0);
	await page.evaluate(() => window.ashDiffIntegration.setEditorFeatures({ readOnly: false, renderGutterMenu: false, renderMarginRevertIcon: false, renderOverviewRuler: false }));
	await expect(button).toHaveCount(0);
	await expect(page.locator('#single .stanza-diff-overview')).toBeHidden();
	await page.evaluate(() => window.ashDiffIntegration.setEditorFeatures({ renderGutterMenu: true, renderMarginRevertIcon: true, renderOverviewRuler: true }));
	await expect(button).toBeVisible();
	await button.click();
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().moves)).toBe(0);
	await expect(button).toHaveCount(0);
});

test('Git diff center gutter preserves BOM encoding while staging and reverting', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('git', 'unstaged', 'utf8bom', true));
	const gutter = page.locator('#title-comparison .ash-diff-gutter');
	await gutter.getByRole('button', { name: 'Stage change', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.gitGutterCalls)).toEqual([{
		path: 'src/first.ts', comparison: 'unstaged', repositoryId: 'repo',
		reviewed: { original: '\uFEFFbefore\nshared', modified: '\uFEFFsrc/first.ts revision 1\nshared', hunks: [] },
		selection: { kind: 'lines', start: 1, end: 1 },
	}]);
	await gutter.getByRole('button', { name: 'Revert change', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readTitleComparison().modified)).toBe('before\nshared');
	await page.evaluate(() => window.ashDiffIntegration.saveTitleFiles());
	expect(await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence())).toMatchObject({ dirty: false, writes: [{ resource: '/workspace/src/first.ts', text: 'before\nshared', encoding: 'utf8bom' }] });
});

for (const locale of ['en', 'zh-CN'] as const) {

	test(`Git diff center gutter stages its block and rejects an expired comparison (${locale})`, async ({ page }, testInfo) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('git'));
		const first = page.locator('#title-comparison .stanza-multi-diff-editor-section').first();
		const gutter = first.locator('.ash-diff-gutter');
		const stage = gutter.getByRole('button', { name: localized(locale, 'Stage change', '暂存更改'), exact: true });
		const revert = gutter.getByRole('button', { name: localized(locale, 'Revert change', '还原更改'), exact: true });
		await expect(stage).toBeVisible();
		await expect(revert).toHaveCount(0);
		const bounds = await first.evaluate(node => {
			const original = node.querySelector('.stanza-diff-editor-side.original')!.getBoundingClientRect();
			const modified = node.querySelector('.stanza-diff-editor-side.modified')!.getBoundingClientRect();
			const gutter = node.querySelector('.ash-diff-gutter')!.getBoundingClientRect();
			const controls = [...node.querySelectorAll('.ash-diff-gutter button')].map(button => button.getBoundingClientRect());
			return { leftGap: gutter.left - original.right, rightGap: modified.left - gutter.right, width: gutter.width, controlsFit: controls.every(button => button.top >= gutter.top && button.bottom <= gutter.bottom) };
		});
		expect(bounds).toEqual({ leftGap: 0, rightGap: 0, width: 35, controlsFit: true });
		await stage.focus();
		await page.keyboard.press('Space');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.gitGutterCalls)).toEqual([{
			path: 'src/first.ts', comparison: 'unstaged', repositoryId: 'repo',
			reviewed: { original: 'before\nshared', modified: 'src/first.ts revision 1\nshared', hunks: [] },
			selection: { kind: 'lines', start: 1, end: 1 },
		}]);
		await testInfo.attach('git-center-gutter', { body: await first.screenshot(), contentType: 'image/png' });
		await page.evaluate(() => window.ashDiffIntegration.expireGitGutterSnapshot());
		await stage.click();
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.gitGutterCalls.length)).toBe(2);
		expect(await page.evaluate(() => window.ashDiffIntegration.gitGutterCalls[1])).toEqual({
			error: localized(locale,
				'Open the current comparison from Source Control before selecting lines.',
				'请从源代码管理打开当前比较，再选中行。')
		});
	});

	test(`Git working-tree gutter has one undoable revert for blocks and selections (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('git', 'unstaged', 'utf8', true));
		const host = page.locator('#title-comparison');
		const gutter = host.locator('.ash-diff-gutter');
		const revert = gutter.getByRole('button', { name: localized(locale, 'Revert change', '还原更改'), exact: true });
		await expect(gutter.getByRole('button')).toHaveCount(2);
		await expect(revert).toHaveCount(1);
		await expect(gutter.getByRole('button', { name: localized(locale, 'Stage change', '暂存更改'), exact: true })).toBeVisible();
		const modified = await page.evaluate(() => window.ashDiffIntegration.readTitleComparison().modified);
		await page.evaluate(() => window.ashDiffIntegration.selectTitleModified([1, 1, 1, 27]));
		await expect(gutter.getByRole('button')).toHaveCount(2);
		await expect(gutter.getByRole('button', { name: localized(locale, 'Stage selected lines', '暂存选中行'), exact: true })).toBeVisible();
		const selectionRevert = gutter.getByRole('button', { name: localized(locale, 'Revert selected changes', '还原选中的更改'), exact: true });
		await expect(selectionRevert).toHaveCount(1);
		await selectionRevert.focus();
		await page.keyboard.press('Space');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readTitleComparison().modified)).toBe('before\nshared');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence())).toMatchObject({ dirty: true, writes: [] });
		const input = host.locator('.modified .stanza-editor-input');
		await input.press('ControlOrMeta+z');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readTitleComparison().modified)).toBe(modified);
		await page.evaluate(() => window.ashDiffIntegration.selectTitleModified([1, 1, 1, 1]));
		await expect(revert).toHaveCount(1);
		await revert.focus();
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readTitleComparison().modified)).toBe('before\nshared');
		await page.evaluate(() => window.ashDiffIntegration.saveTitleFiles());
		expect(await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence())).toMatchObject({ dirty: false, writes: [{ resource: '/workspace/src/first.ts', text: 'before\nshared' }] });
		expect(await page.evaluate(() => window.ashDiffIntegration.gitGutterCalls)).toEqual([]);
	});

	test(`Git diff center gutter unstages selected lines with per-editor menus (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('git', 'staged'));
		const gutter = page.locator('#title-comparison .stanza-multi-diff-editor-section').first().locator('.ash-diff-gutter');
		await expect(gutter.getByRole('button', { name: localized(locale, 'Unstage change', '取消暂存更改'), exact: true })).toBeVisible();
		await expect(gutter.getByRole('button', { name: localized(locale, 'Stage change', '暂存更改'), exact: true })).toHaveCount(0);
		await expect(gutter.getByRole('button', { name: localized(locale, 'Revert change', '还原更改'), exact: true })).toHaveCount(0);
		await expect(page.locator('#single .ash-diff-gutter').getByRole('button', { name: localized(locale, 'Unstage change', '取消暂存更改'), exact: true })).toHaveCount(0);
		await page.evaluate(() => window.ashDiffIntegration.selectTitleModified([1, 1, 1, 27]));
		const unstage = gutter.getByRole('button', { name: localized(locale, 'Unstage selected lines', '取消暂存选中行'), exact: true });
		await expect(unstage).toBeVisible();
		await unstage.focus();
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.gitGutterCalls)).toEqual([{
			path: 'src/first.ts', comparison: 'staged', repositoryId: 'repo',
			reviewed: { original: 'before\nshared', modified: 'src/first.ts revision 1\nshared', hunks: [] },
			selection: { kind: 'lines', start: 1, end: 1 },
		}]);
	});
}

test('moved comparison supports keyboard exit, read-only views, wrapping and disappearing moves', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(async () => {
		const longLine = '  return compute(input, configuration); '.repeat(12);
		const block = ['function load(input) {', longLine, '}'];
		const stay = Array.from({ length: 12 }, (_, index) => `stay ${index}`);
		window.ashDiffIntegration.setComparisonText(['head', ...block, ...stay, 'tail'].join('\n'), ['head', ...stay, ...block, 'tail'].join('\n'));
		await window.ashDiffIntegration.setMoves(true);
		window.ashDiffIntegration.setEditorFeatures({ readOnly: true });
		window.ashDiffIntegration.toggleWordWrap();
	});
	const editor = page.locator('#single .stanza-diff-editor');
	// Establish unequal wrapping through the same separator input as a user.
	const separator = editor.getByRole('separator');
	for (let step = 0; step < 10; step++) await separator.press('ArrowLeft');
	await expect(separator).not.toHaveAttribute('aria-valuenow', '50');
	const move = editor.locator('.ash-diff-moved-links').getByRole('button');
	const revealMove = async () => {
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().moves)).toBe(1);
		await page.evaluate(() => window.ashDiffIntegration.scrollModified(window.ashDiffIntegration.linePositions(2, 14).modifiedTop));
		await expect(move).toBeVisible();
	};
	await revealMove();
	await expect(move).toBeVisible();
	await move.focus();
	await move.press('Enter');
	const toolbar = editor.getByRole('toolbar', { name: 'Moved code comparison' });
	await expect(toolbar).toBeVisible();
	// Unequal column widths can wrap identical text into different line counts.
	// The shorter side's trailing zone completes the aligned comparison row.
	await expect.poll(() => page.evaluate(() => {
		const content = window.ashDiffIntegration.linePositions(3, 15);
		return content.originalBottom - content.originalTop - content.modifiedBottom + content.modifiedTop;
	})).toBeGreaterThan(0);
	await expect.poll(() => page.evaluate(() => {
		const position = window.ashDiffIntegration.linePositions(3, 15, true);
		return position.originalBottom - position.originalTop - position.modifiedBottom + position.modifiedTop;
	})).toBe(0);
	const assertVisibleBlockEndAligned = async () => {
		await page.evaluate(() => {
			const position = window.ashDiffIntegration.linePositions(4, 16);
			window.ashDiffIntegration.scrollModified(position.modifiedTop - 90);
		});
		const originalEnd = editor.locator('.original .view-line').filter({ hasText: /^\}$/u });
		const modifiedEnd = editor.locator('.modified .view-line').filter({ hasText: /^\}$/u });
		await expect(originalEnd).toBeVisible();
		await expect(modifiedEnd).toBeVisible();
		await expect.poll(async () => (await originalEnd.boundingBox())!.y - (await modifiedEnd.boundingBox())!.y).toBe(0);
	};
	await assertVisibleBlockEndAligned();
	await editor.getByRole('separator').press('ArrowLeft');
	await editor.getByRole('separator').press('ArrowLeft');
	await expect.poll(() => page.evaluate(() => {
		const position = window.ashDiffIntegration.linePositions(4, 16);
		return position.originalTop - position.originalScrollTop - position.modifiedTop + position.modifiedScrollTop;
	})).toBe(0);
	await assertVisibleBlockEndAligned();
	await page.locator('#single .modified .stanza-editor-input').press('Escape');
	await expect(toolbar).toBeHidden();
	await revealMove();
	await move.click();
	await expect(toolbar).toBeVisible();
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(false, false, 900));
	await expect(toolbar).toBeHidden();
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, false, 900));
	await revealMove();
	await move.click();
	await expect(toolbar).toBeVisible();
	await editor.getByRole('button', { name: 'Stop comparing moved code', exact: true }).focus();
	await page.evaluate(() => window.ashDiffIntegration.setMoves(false));
	await expect(toolbar).toBeHidden();
	await expect(editor.locator('.modified .stanza-editor-input')).toBeFocused();
	await page.evaluate(() => window.ashDiffIntegration.setMoves(true));
	await revealMove();
	await move.click();
	await expect(toolbar).toBeVisible();
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('head\nnew\ntail', 'head\nnew\ntail'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await expect(toolbar).toBeHidden();
	await expect(move).toHaveCount(0);
});

for (const locale of ['en', 'zh-CN'] as const) {

	for (const inline of [false, true]) {
		test(`expanded unchanged regions can be folded again in a read-only diff (${locale}, ${inline ? 'inline' : 'side by side'})`, async ({ page }, testInfo) => {
			await openDiffPage(page, locale);
			const original = Array.from({ length: 36 }, (_, index) => `shared line ${index + 1}`);
			const modified = [...original];
			modified[17] = 'changed middle line';
			await page.evaluate(([left, right, inline]) => {
				window.ashDiffIntegration.setTheme('vs');
				window.ashDiffIntegration.setComparisonText(left, right);
				window.ashDiffIntegration.setHiddenRegions(true);
				window.ashDiffIntegration.setEditorFeatures({ readOnly: true });
				window.ashDiffIntegration.setViewMode(!inline, false, 900);
			}, [original.join('\n'), modified.join('\n'), inline] as const);
			await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
			const regions = page.locator('#single .ash-diff-hidden-region');
			const modifiedSide = page.locator('#single .stanza-diff-editor-side.modified');
			const leading = modifiedSide.locator('.ash-diff-hidden-region').first();
			const collapse = modifiedSide.getByRole('button', { name: localized(locale, 'Collapse unchanged region', '折叠未修改区域') });
			await expect(regions).toHaveCount(4);
			await expect(leading.locator('.ash-diff-hidden-region-count')).toHaveText(localized(locale, '16 hidden lines', '隐藏 16 行'));
			await leading.locator('.ash-diff-hidden-region-count').dblclick();
			await expect(regions).toHaveCount(2);
			await expect(collapse).toBeVisible();
			await page.locator('#single').screenshot({ path: testInfo.outputPath('expanded-fold-button.png') });
			await collapse.focus();
			await page.keyboard.press('Tab');
			await page.keyboard.press('Shift+Tab');
			await expect(collapse).toBeFocused();
			await expect(collapse).toHaveCSS('outline-style', 'solid');
			await page.keyboard.press('Space');
			await expect(regions).toHaveCount(4);
			await expect(collapse).toHaveCount(0);
			await expect(leading.locator('.ash-diff-hidden-region-count')).toHaveText(localized(locale, '16 hidden lines', '隐藏 16 行'));
			const visible = await page.evaluate(() => window.ashDiffIntegration.visibleDiffRanges());
			for (const ranges of [visible.original, visible.modified]) {
				expect(ranges.some(([start, end]) => start <= 5 && 5 <= end)).toBe(false);
			}
			await leading.locator('.ash-diff-hidden-region-above').click();
			await leading.locator('.ash-diff-hidden-region-below').click();
			await expect(leading.locator('.ash-diff-hidden-region-count')).toHaveText(localized(locale, '12 hidden lines', '隐藏 12 行'));
			for (let step = 0; step < 6; step++) {
				await leading.locator('.ash-diff-hidden-region-above').click();
			}
			await expect(collapse).toBeVisible();
			if (inline) {
				await collapse.click();
			} else {
				await page.locator('#single .stanza-diff-editor-side.original').getByRole('button', { name: localized(locale, 'Collapse unchanged region', '折叠未修改区域') }).click();
			}
			await expect(regions).toHaveCount(4);
			await expect(leading.locator('.ash-diff-hidden-region-count')).toHaveText(localized(locale, '16 hidden lines', '隐藏 16 行'));
			await page.evaluate(() => window.ashDiffIntegration.setHiddenRegions(false));
			await expect(regions).toHaveCount(0);
			await expect(page.locator('#single .ash-diff-fold-unchanged')).toHaveCount(0);
		});
	}
}

test('modified side accepts text input and original side remains read-only', async ({ page }) => {
	await openDiffPage(page);
	const original = page.locator('#single .stanza-diff-editor-side.original .stanza-editor');
	const modified = page.locator('#single .stanza-diff-editor-side.modified .stanza-editor');
	await original.focus();
	await page.keyboard.type('blocked');
	expect((await page.evaluate(() => window.ashDiffIntegration.read())).originalText).toBe('same\nbefore 😀 after\nlast');
	await modified.focus();
	await page.evaluate(() => window.ashDiffIntegration.selectModifiedAll());
	await page.keyboard.type('same\nbefore 😀 after\nlast');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toBe('same\nbefore 😀 after\nlast');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().kinds)).toEqual(['unchanged', 'unchanged', 'unchanged']);
});

test('multi diff edits the shared modified model while its original column stays read-only', async ({ page }) => {
	await openDiffPage(page);
	const first = page.locator('#multi .stanza-multi-diff-editor-section').first();
	await first.locator('.stanza-diff-editor-side.original .stanza-editor').focus();
	await page.keyboard.type('blocked');
	expect((await page.evaluate(() => window.ashDiffIntegration.read())).originalText).toBe('same\nbefore 😀 after\nlast');
	await first.locator('.stanza-diff-editor-side.modified .stanza-editor').focus();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type(' added');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toBe('same\nbefore 🤖 after\nlast added');
	await expect(page.locator('#single .stanza-diff-inline-added').last()).toBeVisible();
});

test('unsaved input updates Diff and Quick Diff locally using the existing baseline', async ({ page }) => {
	await openDiffPage(page);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffReady)).toBe(true);
	const before = await page.evaluate(() => window.ashDiffIntegration.read());
	await page.getByRole('textbox', { name: 'Modified text' }).fill('obsolete');
	await page.getByRole('textbox', { name: 'Modified text' }).fill('same\nbefore 😀 after\nlast');
	await expect.poll(() => page.evaluate(() => {
		const state = window.ashDiffIntegration.read();
		return state.state === 'ready' && state.quickDiffReady && state.resultVersion === state.version;
	})).toBe(true);
	const after = await page.evaluate(() => window.ashDiffIntegration.read());
	expect(after.kinds).toEqual(['unchanged', 'unchanged', 'unchanged']);
	expect(after.quickDiffChanges).toBe(0);
	expect(after.baselineRequests).toBe(before.baselineRequests);
	await expect(page.locator('#single .stanza-diff-inline-added')).toHaveCount(0);
	await expect(page.locator('#multi .stanza-diff-inline-added')).toHaveCount(0);
});

for (const locale of ['en', 'zh-CN'] as const) {
	test(`encoding status action saves, reopens and cancels without changing another editor (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('encoding'));
		const encoding = page.locator('#title-comparison [data-statusbar-item-id="ash.status.editor.encoding"]');
		const input = page.locator('#title-comparison .stanza-editor-input').last();
		const picker = page.locator('.ash-quick-input-host input');
		await input.focus();
		await encoding.getByRole('button').focus();
		await page.keyboard.press('Enter');
		await expect(picker).toHaveAttribute('placeholder', localized(locale, 'Select an Encoding Action', '选择编码操作'));
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect(picker).toHaveAttribute('placeholder', localized(locale, 'Select File Encoding', '选择文件编码'));
		await picker.fill('GBK');
		await page.keyboard.press('Enter');
		await expect(encoding).toHaveText('GBK');
		await expect(input).toBeFocused();
		expect(await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence().writes)).toEqual([{ resource: '/title/after.ts', text: 'after\nshared', encoding: 'gbk' }]);
		expect(await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence().dirty)).toBe(false);
		await encoding.getByRole('button').click();
		await expect(picker).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(picker).toHaveAttribute('placeholder', localized(locale, 'Select File Encoding', '选择文件编码'));
		await expect(page.getByText(localized(locale, 'Guessed from Content', '根据内容猜测'), { exact: true })).toBeVisible();
		await expect(page.locator('.ash-quick-pick-list').getByRole('option')).toHaveCount(48);
		await picker.fill('cp1125');
		await expect(page.locator('.ash-quick-pick-list').getByRole('option')).toHaveText(/CP 1125/);
		await picker.fill('UTF-16 LE');
		await page.keyboard.press('Enter');
		await expect(encoding).toHaveText('UTF-16 LE');
		expect(await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence().writes)).toHaveLength(1);
		await encoding.getByRole('button').click();
		await page.keyboard.press('Escape');
		await expect(input).toBeFocused();
		await expect(encoding).toHaveText('UTF-16 LE');
		await encoding.getByRole('button').click();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect(picker).toHaveAttribute('placeholder', localized(locale, 'Select File Encoding', '选择文件编码'));
		await page.evaluate(() => window.ashDiffIntegration.openOtherTitleFile());
		await picker.fill('UTF-8');
		await page.keyboard.press('Enter');
		expect(await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence().writes)).toHaveLength(1);
	});
}

for (const locale of ['en', 'zh-CN'] as const) {
	test(`encoding reopening confirms dirty discard and readonly sides offer only reopen (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('encoding'));
		const encoding = page.locator('#title-comparison [data-statusbar-item-id="ash.status.editor.encoding"]');
		const inputs = page.locator('#title-comparison .stanza-editor-input');
		const picker = page.locator('.ash-quick-input-host input');
		await inputs.first().focus();
		await encoding.getByRole('button').click();
		await expect(picker).toBeFocused();
		await expect(page.getByText(localized(locale, 'Reopen with Encoding', '通过编码重新打开'), { exact: true })).toBeVisible();
		await expect(page.getByText(localized(locale, 'Save with Encoding', '通过编码保存'), { exact: true })).not.toBeVisible();
		await page.keyboard.press('Escape');
		await inputs.last().focus();
		await page.keyboard.press('End');
		await page.keyboard.type('!');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readTitlePersistence().dirty)).toBe(true);
		for (const confirm of [false, true]) {
			await encoding.getByRole('button').click();
			await expect(picker).toBeFocused();
			await page.keyboard.press('Enter');
			await picker.fill('UTF-16 LE');
			await page.keyboard.press('Enter');
			await expect(page.getByText(localized(locale, 'Your unsaved changes will be discarded.', '未保存的更改将被丢弃。'), { exact: true })).toBeVisible();
			await page.getByRole('button', { name: confirm ? localized(locale, 'Reopen', '重新打开') : localized(locale, 'Cancel', '取消'), exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readTitlePersistence().dirty)).toBe(!confirm);
			await expect(encoding).toHaveText(confirm ? 'UTF-16 LE' : 'UTF-8');
		}
		expect(await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence().writes)).toHaveLength(0);
	});
}
