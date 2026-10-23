import { expect } from '@playwright/test';
import { expectVisibleFocusOutline } from '../../../../../../../test/fixtures/browser/focusOutline.js';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test, setup } from 'mocha';
import { renderSCMHistoryItemGraph, toISCMHistoryItemViewModelArray } from '../../browser/scmHistory.js';
import type { ISCMHistoryItem } from '../../common/history.js';

suite('SCM history graph', () => {
	test('connects a merge to its additional parent when that parent already has a lane', () => {
		const history: ISCMHistoryItem[] = [
			{ id: 'tip', parentIds: ['merge', 'base'], subject: 'tip', message: 'tip' },
			{ id: 'merge', parentIds: ['main', 'base'], subject: 'merge', message: 'merge' },
			{ id: 'main', parentIds: ['base'], subject: 'main', message: 'main' },
			{ id: 'base', parentIds: ['root'], subject: 'base', message: 'base' },
			{ id: 'root', parentIds: [], subject: 'root', message: 'root' },
		];
		const environment = new JSDOM();
		try {
			const rows = toISCMHistoryItemViewModelArray(history);
			const graph = renderSCMHistoryItemGraph(rows[1], 22, environment.window.document);
			const branchColor = rows[1].outputSwimlanes[2].color;
			const branchPaths = [...graph.querySelectorAll('path')].filter(path => path.dataset.laneColor === String(branchColor));
			assert.ok(branchPaths.some(path => path.getAttribute('d')?.endsWith('33 22')), 'The new merge edge must reach its own lane at x=33.');
			const base = renderSCMHistoryItemGraph(rows[3], 22, environment.window.document);
			assert.equal(base.querySelectorAll('path[d$="H 11"]').length, 2, 'Both side lanes must reconnect to the base commit.');
			assert.equal(rows[3].outputSwimlanes.length, 1);
		} finally {
			environment.window.close();
		}
	});

	test('retains another branch across a root commit', () => {
		const rows = toISCMHistoryItemViewModelArray([
			{ id: 'merge', parentIds: ['root', 'other'], subject: 'merge', message: 'merge' },
			{ id: 'root', parentIds: [], subject: 'root', message: 'root' },
			{ id: 'other', parentIds: [], subject: 'other', message: 'other' },
		]);
		assert.deepEqual(rows[1].outputSwimlanes, [rows[0].outputSwimlanes[1]]);
		const environment = new JSDOM();
		try {
			const graph = renderSCMHistoryItemGraph(rows[1], 22, environment.window.document);
			assert.equal(graph.querySelectorAll('path[data-lane-color="1"][d$="11 16 V 22"]').length, 1, 'The other branch must continue past the root commit.');
			assert.equal(graph.querySelector('circle')?.getAttribute('data-lane-color'), '0', 'The root keeps its own branch color.');
		} finally {
			environment.window.close();
		}
	});
});

test('summary nodes compare captured branch revisions without changing commit parents', () => {
	const history = [
		{ id: 'local', parentIds: ['base'], subject: 'local', message: 'local' },
		{ id: 'remote', parentIds: ['base'], subject: 'remote', message: 'remote' },
		{ id: 'base', parentIds: [], subject: 'base', message: 'base' },
	];
	const rows = toISCMHistoryItemViewModelArray(history, new Map(), { id: 'main', name: 'main', revision: 'local' }, {
		remote: { id: 'origin/main', name: 'origin/main', revision: 'remote' }, base: 'base', incoming: true, outgoing: true,
	});
	assert.deepEqual(rows.map(row => row.kind), ['outgoing-changes', 'HEAD', 'node', 'incoming-changes', 'node']);
	assert.deepEqual(rows[0].historyItem.comparison, { revision: 'local', baseRevision: 'base' });
	assert.deepEqual(rows[3].historyItem.comparison, { revision: 'remote', baseRevision: 'base' });
	assert.deepEqual(rows[2].historyItem.parentIds, ['base']);
	assert.deepEqual(history[1].parentIds, ['base']);
	assert.equal(toISCMHistoryItemViewModelArray(history, new Map(), { id: 'main', name: 'main', revision: 'local' }, {
		remote: { id: 'origin/main', name: 'origin/main', revision: 'remote' }, base: 'base', incoming: false, outgoing: false,
	}).length, history.length);
});

suite('scmHistory browser component', () => {
	const browserTests = useBrowserTests();
	setup(async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/scmHistory.html');
		await expect.poll(async () => ({ mounted: await page.getByRole('treeitem', { name: /History metadata:/u }).count(), errors })).toEqual({ mounted: 1, errors: [] });
	});

	test('SCM history progress follows reads, collapse, completion and failure', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		const pane = page.locator('[data-view-id="fixture.history"]');
		const progress = pane.locator('.ash-view-pane-progress-indicator');
		await page.evaluate(() => window.ashSCMHistoryIntegration.beginHistoryRead());
		await expect(progress).toBeVisible();
		const body = pane.locator(':scope > .ash-pane-view-content');
		expect((await progress.boundingBox())!.y).toBe((await body.boundingBox())!.y);
		await pane.locator('.ash-pane-view-header-button').press('ArrowLeft');
		await expect(progress).toBeHidden();
		await pane.locator('.ash-pane-view-header-button').press('ArrowRight');
		await expect(progress).toBeVisible();
		await pane.screenshot({ path: testInfo.outputPath('history-progress.png') });
		await page.evaluate(() => window.ashSCMHistoryIntegration.finishHistoryRead());
		await expect(progress).toBeHidden();
		await expect(pane.getByRole('treeitem', { name: /History metadata:/u })).toHaveCount(1);
		await page.evaluate(() => window.ashSCMHistoryIntegration.beginHistoryRead());
		await expect(progress).toBeVisible();
		await page.evaluate(() => window.ashSCMHistoryIntegration.finishHistoryRead(true));
		await expect(progress).toBeHidden();
		await expect(pane.getByRole('button', { name: 'Retry loading commit graph', exact: true })).toBeVisible();
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`global header action visibility updates existing views and preserves explicit policies (${locale})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.goto(`/scmHistory.html?headerActions&locale=${locale}`);
			const outside = page.locator('#outside');
			const defaultPane = page.locator('[data-view-id="default"]');
			const defaultHeader = defaultPane.locator('.ash-pane-view-header-button');
			const defaultActions = defaultPane.locator('.ash-pane-view-header-actions');
			const graphActions = page.locator('[data-view-id="fixture.history"] .ash-pane-view-header-actions');
			const alwaysPane = page.locator('[data-view-id="always"]');
			const alwaysActions = alwaysPane.locator('.ash-pane-view-header-actions');
			const retained = await defaultActions.elementHandle();
			await outside.hover();
			await outside.focus();
			await expect(defaultActions).toBeHidden();
			await page.evaluate(async () => {
				await window.ashSCMHistoryIntegration.setAlwaysShowHeaderActions(true);
				window.ashSCMHistoryIntegration.addDefaultView();
			});
			const lateActions = page.locator('[data-view-id="late-default"] .ash-pane-view-header-actions');
			await expect(lateActions).toBeVisible();
			for (let theme = 0; theme < 4; theme++) {
				await page.evaluate(index => window.ashSCMHistoryIntegration.setTheme(index), theme);
				await page.evaluate(() => window.ashSCMHistoryIntegration.setAlwaysShowHeaderActions(true));
				await expect(defaultActions).toBeVisible();
				expect(await defaultPane.evaluate(element => element.matches(':hover, :focus-within'))).toBe(false);
				await defaultHeader.press('ArrowLeft');
				await expect(defaultActions).toBeHidden();
				await defaultHeader.press('ArrowRight');
				await outside.focus();
				await expect(defaultActions).toBeVisible();
				await alwaysPane.locator('.ash-pane-view-header-button').press('ArrowLeft');
				await outside.focus();
				await expect(alwaysActions).toBeVisible();
				await page.evaluate(() => window.ashSCMHistoryIntegration.setAlwaysShowHeaderActions(false));
				await expect(defaultActions).toBeHidden();
				await expect(graphActions).toBeVisible();
				await expect(alwaysActions).toBeVisible();
				await expect(lateActions).toBeHidden();
				await defaultHeader.focus();
				await expect(defaultActions).toBeVisible();
				await outside.focus();
				await expect(defaultActions).toBeHidden();
			}
			expect(await retained!.evaluate(element => element.isConnected)).toBe(true);
			await retained?.dispose();
			await testInfo.attach(`header-actions-${locale}`, { body: await page.locator('#history-root').screenshot(), contentType: 'image/png' });
		});

		test(`history title actions remain visible while expanded without hover or focus (${locale})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.goto(`/scmHistory.html?headerActions&locale=${locale}`);
			const history = page.locator('[data-view-id="fixture.history"]');
			const header = history.locator('.ash-pane-view-header-button');
			const actions = history.locator('.ash-pane-view-header-actions');
			const keyboardAction = actions.locator('button:enabled').first();
			const outside = page.locator('#outside');
			const defaultPane = page.locator('[data-view-id="default"]');
			const defaultActions = defaultPane.locator('.ash-pane-view-header-actions');
			const alwaysPane = page.locator('[data-view-id="always"]');
			const alwaysActions = alwaysPane.locator('.ash-pane-view-header-actions');
			await expect(actions.getByRole('button').first()).toBeVisible();
			const retainedActions = await actions.elementHandle();
			for (let theme = 0; theme < 4; theme++) {
				await page.evaluate(index => window.ashSCMHistoryIntegration.setTheme(index), theme);
				await outside.hover();
				await outside.focus();
				expect(await history.evaluate(element => element.matches(':hover, :focus-within'))).toBe(false);
				await expect(actions).toHaveCSS('visibility', 'visible');
				await expect(actions.getByRole('button').first()).toBeVisible();
				await expect(defaultActions).toBeHidden();
				await defaultPane.hover();
				await expect(defaultActions).toBeVisible();
				await outside.hover();
				await defaultPane.locator('.ash-pane-view-header-button').focus();
				await expect(defaultActions).toBeVisible();
				await outside.focus();
				await expect(defaultActions).toBeHidden();
				await header.press('ArrowLeft');
				await expect(header).toHaveAttribute('aria-expanded', 'false');
				await expect(actions).toBeHidden();
				await header.press('ArrowRight');
				await expect(header).toHaveAttribute('aria-expanded', 'true');
				await expect(actions).toBeVisible();
				await header.press('Tab');
				await expect(keyboardAction).toBeFocused();
				await expectVisibleFocusOutline(keyboardAction);
				await outside.focus();
				await expect(actions).toBeVisible();
				await alwaysPane.locator('.ash-pane-view-header-button').press('ArrowLeft');
				await outside.focus();
				await expect(alwaysActions).toBeVisible();
				await testInfo.attach(`history-title-${locale}-${theme}`, { body: await history.locator('.ash-pane-view-header').screenshot(), contentType: 'image/png' });
			}
			expect(await retainedActions!.evaluate(element => element.isConnected)).toBe(true);
			await retainedActions?.dispose();
		});
	}

	test('history rows retain identity and reserve title width when the pane resizes', async function () {
		const { page } = browserTests;

		const commit = page.getByRole('treeitem', { name: /History metadata:/u });
		const retainedCommit = await commit.elementHandle();
		const retainedActions = await commit.locator('.ash-scm-graph-actions').elementHandle();
		for (const width of [280, 560]) {
			await page.evaluate(width => window.ashSCMHistoryIntegration.resize(width), width);
			expect(await retainedCommit!.evaluate(element => element.isConnected)).toBe(true);
			expect(await retainedActions!.evaluate(element => element.isConnected)).toBe(true);
			await expect(commit.locator('.ash-scm-graph-metadata')).toHaveCount(0);
			const geometry = await commit.evaluate(element => {
				const graph = element.querySelector('.ash-scm-graph-graph')!.getBoundingClientRect();
				const title = element.querySelector('.ash-scm-graph-subject')!.getBoundingClientRect();
				const row = element.querySelector('.ash-scm-graph-row')!.getBoundingClientRect();
				return { left: title.left - graph.right, right: row.right - title.right, rowHeight: row.height, graphHeight: graph.height };
			});
			expect(geometry.left).toBeCloseTo(0, 1);
			expect(geometry.right).toBeCloseTo(8, 1);
			expect(geometry.rowHeight).toBe(22);
			expect(geometry.graphHeight).toBe(22);
		}
		const subject = commit.locator('.ash-scm-graph-subject');
		const restingTitle = await subject.boundingBox();
		await commit.locator('.ash-scm-graph-row').hover({ position: { x: 80, y: 10 } });
		expect(await subject.boundingBox()).toEqual(restingTitle);
		const overlay = commit.locator('.ash-scm-graph-overlay');
		await expect(overlay.locator('.ash-scm-graph-actions')).toBeVisible();
		await expect.poll(() => overlay.evaluate(element => {
			const style = getComputedStyle(element, '::before');
			return { mask: style.maskImage, opacity: style.opacity, pointerEvents: style.pointerEvents };
		})).toMatchObject({ mask: expect.stringContaining('linear-gradient'), opacity: '1', pointerEvents: 'none' });
		await browserTests.info.attach('scm-history-row-overlay', { body: await commit.screenshot(), contentType: 'image/png' });
		await retainedCommit?.dispose();
		await retainedActions?.dispose();
	});

	test('floating history actions preserve the complete keyboard focus outline across themes', async function () {
		const { page } = browserTests;

		const commit = page.getByRole('treeitem', { name: /History metadata:/u });
		for (let theme = 0; theme < 4; theme++) {
			await page.evaluate(index => window.ashSCMHistoryIntegration.setTheme(index), theme);
			await page.keyboard.press('Tab');
			await commit.focus();
			const row = commit.locator('.ash-scm-graph-row');
			await row.hover({ position: { x: 80, y: 10 } });
			await expect(commit.locator('.ash-scm-graph-actions')).toBeVisible();
			await expectVisibleFocusOutline(row);
			await commit.locator('.ash-scm-graph-actions button').first().click({ trial: true });
			if (theme === 0) {
				await commit.press('Tab');
				await expect(commit.getByRole('button', { name: 'metadata-topic', exact: true })).toBeFocused();
				await page.keyboard.press('Tab');
				await expect(commit.getByRole('button', { name: 'metadata-v1', exact: true })).toBeFocused();
				await page.keyboard.press('Tab');
				await expect(commit.locator('.ash-scm-graph-actions button').first()).toBeFocused();
				await commit.focus();
			}
			await browserTests.info.attach(`history-focus-${theme}`, { body: await row.screenshot(), contentType: 'image/png' });
		}
	});

	test('commit details preserve whitespace, metadata, scrolling and long-title geometry', async function () {
		const { page } = browserTests;

		const { hash, timestamp, subject, message: body } = await page.evaluate(() => window.ashSCMHistoryIntegration);
		const commit = page.getByRole('treeitem', { name: /History metadata:/u });
		const hover = page.getByRole('tooltip').filter({ has: page.locator('.ash-scm-graph-hover') });
		await commit.locator('.ash-scm-graph-subject').hover({ position: { x: 3, y: 8 } });
		await expect(hover.locator('.ash-scm-graph-hover-subject')).toHaveText(subject);
		await expect(hover.locator('.ash-scm-graph-hover-author > span[title]')).toHaveText('History Author');
		await expect(hover.locator('.ash-scm-graph-hover-author > span[title]')).toHaveAttribute('title', 'history@example.invalid');
		await expect(hover.locator('time')).toHaveAttribute('datetime', new Date(Number(timestamp) * 1000).toISOString());
		await expect(hover.locator('.ash-scm-graph-hover-message')).toHaveText(body);
		expect(await hover.locator('.ash-scm-graph-hover-message').textContent()).toBe(body);
		const messageScroll = hover.getByRole('region', { name: 'Commit message', exact: true });
		const messageViewport = messageScroll.locator('.ash-scrollbar-viewport');
		await expect(messageScroll).toHaveCSS('height', '180px');
		await expect(messageViewport).toHaveCSS('scrollbar-width', 'none');
		await messageScroll.focus();
		await expect(messageScroll.locator('.ash-scrollbar-track-vertical')).toHaveAttribute('data-visibility', 'auto');
		await messageViewport.hover();
		await expect(messageScroll.locator('.ash-scrollbar-track-vertical')).toHaveCSS('opacity', '1');
		await messageScroll.press('End');
		await expect.poll(() => messageViewport.evaluate(element => element.scrollTop > 0 && Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 1)).toBe(true);
		await messageScroll.press('Home');
		await expect.poll(() => messageViewport.evaluate(element => element.scrollTop)).toBe(0);
		await messageViewport.hover();
		await page.mouse.wheel(0, 160);
		await expect.poll(() => messageViewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
		await expect(hover.locator('.ash-scm-graph-hover-statistics > span')).toHaveText(['2 files changed', '2 insertions(+)', '0 deletions(-)']);
		await expect(hover.locator('.ash-scm-graph-hover-hash')).toHaveAttribute('title', hash);
		await expect(hover.getByRole('group', { name: 'History references', exact: true })).toContainText('metadata-topic');
		await expect(hover.getByRole('group', { name: 'History references', exact: true })).toContainText('metadata-v1');
		const contentGeometry = await hover.evaluate(element => {
			const tooltip = element.closest<HTMLElement>('.ash-hover')!;
			const bounds = tooltip.getBoundingClientRect();
			const range = element.ownerDocument.createRange();
			range.selectNodeContents(element.querySelector('.ash-scm-graph-hover-subject')!);
			return {
				horizontalOverflow: tooltip.scrollWidth > tooltip.clientWidth,
				fullTitleInsideCard: [...range.getClientRects()].every(rect => rect.left >= bounds.left && rect.right <= bounds.right),
			};
		});
		expect(contentGeometry).toEqual({ horizontalOverflow: false, fullTitleInsideCard: true });
		const openOnGitHub = hover.getByRole('button', { name: 'Open on GitHub', exact: true });
		await expect(openOnGitHub).toBeVisible();
		await expect(openOnGitHub).toHaveText('Open on GitHub');
		await expect(openOnGitHub.locator('.ash-icon')).toHaveAttribute('aria-hidden', 'true');
		await browserTests.info.attach('scm-history-hover', { body: await hover.screenshot(), contentType: 'image/png' });
	});

	test('slow pointer movement and action tooltip delays retain the details card', async function () {
		const { page } = browserTests;

		const commit = page.getByRole('treeitem', { name: /History metadata:/u });
		const hover = page.getByRole('tooltip').filter({ has: page.locator('.ash-scm-graph-hover') });
		await commit.locator('.ash-scm-graph-subject').hover({ position: { x: 3, y: 8 } });
		await expect(hover).toBeVisible();
		const pointerCopy = hover.getByRole('button', { name: 'Copy Commit Hash', exact: true });
		const hoverId = await hover.getAttribute('id');
		const commitBounds = (await commit.boundingBox())!;
		const hoverBounds = (await hover.boundingBox())!;
		expect(hoverBounds.x).toBeGreaterThan(commitBounds.x + commitBounds.width);
		await page.mouse.move((commitBounds.x + commitBounds.width + hoverBounds.x) / 2, commitBounds.y + commitBounds.height / 2);
		// A deliberate pause in the gap reproduces a slow move from the row to its actions.
		await page.waitForTimeout(150);
		await expect(hover).toHaveAttribute('id', hoverId!);
		await pointerCopy.hover();
		// Hold past the action-tooltip delay to detect replacement of the details card.
		await page.waitForTimeout(700);
		await expect(hover).toHaveAttribute('id', hoverId!);
		await hover.getByRole('button', { name: 'Open on GitHub', exact: true }).hover();
		await page.waitForTimeout(700);
		await expect(hover).toHaveAttribute('id', hoverId!);
		await page.locator('#outside').click();
		await expect(hover).toHaveCount(0);
		await commit.focus();
		await expect(hover).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(hover).toHaveCount(0);
	});

	test('commit message focus and scrollbars follow all four color themes', async function () {
		const { page } = browserTests;

		const commit = page.getByRole('treeitem', { name: /History metadata:/u });
		const hover = page.getByRole('tooltip').filter({ has: page.locator('.ash-scm-graph-hover') });
		await commit.focus();
		await commit.press('Alt+ArrowDown');
		const messageScroll = hover.getByRole('region', { name: 'Commit message', exact: true });
		for (let theme = 0; theme < 4; theme++) {
			await page.evaluate(index => window.ashSCMHistoryIntegration.setTheme(index), theme);
			await commit.focus();
			await commit.press('Alt+ArrowDown');
			await messageScroll.focus();
			await messageScroll.press('Home');
			await expect(messageScroll).toHaveCSS('outline-style', 'solid');
			const thumb = messageScroll.locator('.ash-scrollbar-track-vertical > .ash-scrollbar-thumb');
			await expect(thumb).toBeVisible();
			expect(await thumb.evaluate(element => {
				const probe = document.createElement('span');
				probe.style.backgroundColor = 'var(--ash-scrollbarSlider-background)';
				element.append(probe);
				const color = getComputedStyle(element).backgroundColor;
				const themed = color === getComputedStyle(probe).backgroundColor && color !== 'rgba(0, 0, 0, 0)';
				probe.remove();
				return themed;
			})).toBe(true);
			await browserTests.info.attach(`scm-history-${theme}`, { body: await hover.screenshot(), contentType: 'image/png' });
			await page.keyboard.press('Escape');
			await expect(commit).toBeFocused();
		}
	});

	test('Chinese history hover labels and narrow viewports preserve complete details', async function () {
		const { page } = browserTests;

		const { hash, subject } = await page.evaluate(() => window.ashSCMHistoryIntegration);
		await page.goto('/scmHistory.html?locale=zh-CN');
		const localizedHistory = page.locator('[data-view-id="fixture.history"]');
		const localizedCommit = page.getByRole('treeitem', { name: /History metadata:/u });
		await localizedCommit.focus();
		await localizedCommit.press('Alt+ArrowDown');
		const localizedHover = page.getByRole('tooltip').filter({ has: page.locator('.ash-scm-graph-hover') });
		await expect(localizedHover.getByRole('button', { name: '复制提交哈希', exact: true })).toHaveText('');
		await expect(localizedHover.getByRole('button', { name: `打开提交 ${hash.slice(0, 7)}`, exact: true })).toBeVisible();
		await expect(localizedHistory.locator('[data-action-id="workbench.scm.action.graph.revealCurrentHistoryItem"] > button')).toHaveAttribute('aria-label', '转到当前历史记录项');
		await expect(localizedHover.getByRole('button', { name: '在 GitHub 上打开', exact: true })).toHaveText('在 GitHub 上打开');
		await expect(localizedHover.getByRole('region', { name: '提交消息', exact: true })).toHaveCSS('height', '180px');
		await page.keyboard.press('Escape');
		await page.mouse.move(900, 100);
		for (const width of [1100, 640, 360]) {
			await page.setViewportSize({ width, height: 820 });
			await page.evaluate(width => window.ashSCMHistoryIntegration.resize(Math.min(width, 560)), width);
			await localizedCommit.focus();
			await localizedCommit.press('Alt+ArrowDown');
			await expect(localizedHover).toBeVisible();
			await expect.poll(() => localizedHover.evaluate(element => {
				const tooltip = element.closest<HTMLElement>('.ash-hover')!;
				const bounds = tooltip.getBoundingClientRect();
				return {
					horizontalOverflow: tooltip.scrollWidth > tooltip.clientWidth,
					insideWindow: bounds.left >= 0 && bounds.right <= element.ownerDocument.defaultView!.innerWidth,
				};
			})).toEqual({ horizontalOverflow: false, insideWindow: true });
			await expect(localizedHover.locator('.ash-scm-graph-hover-subject')).toHaveText(subject);
		}
	});
});
