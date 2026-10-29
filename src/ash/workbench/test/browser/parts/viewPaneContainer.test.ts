import { expect } from '@playwright/test';
import type {} from './fixtures/composite.page.js';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../test/unit/browser/context.js';

suite('viewpaneLayout browser component', () => {
	const browserTests = useBrowserTests();
	for (const locale of ['en', 'zh-CN']) {
		test(`Symphony form scrolls and submits from the keyboard in a short pane (${locale})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/viewpaneLayout.html?view=symphony&locale=${locale}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			const body = page.locator('.ash-symphony-tasks');
			await body.hover();
			await page.mouse.wheel(0, 1000);
			await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
			const inputs = body.getByRole('textbox');
			await inputs.nth(1).fill('Layout fixture');
			await inputs.nth(2).fill('Retain keyboard access');
			const create = body.getByRole('button').last();
			await inputs.nth(2).focus();
			for (
				let step = 0;
				step < 3 && !(await create.evaluate(element => element === element.ownerDocument.activeElement));
				step++
			) {
				await page.keyboard.press('Tab');
			}
			await expect(create).toBeFocused();
			await expect(create).toBeInViewport({ ratio: 1 });
			await create.press('Enter');
			await expect
				.poll(() => page.evaluate(() => window.viewpaneLayoutIntegration.submissions))
				.toEqual([{ title: 'Layout fixture', prompt: 'Retain keyboard access' }]);
			const header = page.locator('.ash-pane-view-header-button');
			await header.press('ArrowLeft');
			expect(await page.evaluate(() => window.viewpaneLayoutIntegration.watchers())).toBe(0);
			await header.press('ArrowRight');
			expect(await page.evaluate(() => window.viewpaneLayoutIntegration.watchers())).toBe(1);
			await create.focus();
			await testInfo.attach('short-symphony-pane', {
				body: await page.locator('#root').screenshot(),
				contentType: 'image/png',
			});
			await page.evaluate(() => window.viewpaneLayoutIntegration.dispose());
			expect(await page.evaluate(() => window.viewpaneLayoutIntegration.watchers())).toBe(0);
			expect(errors).toEqual([]);
		});
	}

	test('Sessions Changes retains its tree viewport beside review controls', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/viewpaneLayout.html?view=changes');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		const viewport = page.locator('.ash-sessions-changes-tree .ash-tree');
		await expect.poll(() => viewport.evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(120);
		await expect(page.locator('.ash-sessions-changes').getByRole('status')).toHaveText('30 changed files');
		await viewport.focus();
		await viewport.press('End');
		await expect(viewport.getByRole('treeitem').last()).toBeInViewport({ ratio: 1 });
		await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
		expect(errors).toEqual([]);
	});

	test('Debug Console keeps its output and expression reachable after a wrapping error', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/viewpaneLayout.html?view=console');
		const body = page.locator('.ash-debug-console');
		const input = body.getByRole('textbox', { name: 'Debug Console expression', exact: true });
		await input.focus();
		await page.keyboard.insertText('fixture');
		await input.press('Enter');
		await expect(body.getByRole('status')).toContainText('Evaluation failed.');
		await expect
			.poll(() => body.evaluate(element => element.scrollHeight - element.clientHeight))
			.toBeLessThanOrEqual(1);
		await expect
			.poll(() => body.getByRole('log').evaluate(element => element.clientHeight))
			.toBeGreaterThanOrEqual(60);
		expect(errors).toEqual([]);
	});

	for (const [view, content] of [
		['problems', '.ash-problems-results'],
		['bulk', '.ash-bulk-edit-list'],
		['ports', '.ash-remote-ports-list'],
	]) {
		test(`${view} retains a usable list beside wrapping controls or discovery errors`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/viewpaneLayout.html?view=${view}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			const list = page.locator(content);
			await expect
				.poll(() => list.locator('..').evaluate(element => element.scrollHeight - element.clientHeight))
				.toBeLessThanOrEqual(1);
			if (view === 'problems') {
				await expect(list).toContainText('Fixture problem');
				await expect.poll(() => list.evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(22);
			} else {
				await expect(list.locator(':scope > *')).toHaveCount(0);
				await expect(page.getByRole('status')).toContainText(
					view === 'bulk' ? 'No bulk edit is awaiting approval.' : 'Port discovery failed.',
				);
			}
			expect(errors).toEqual([]);
		});
	}

	test('Empty Explorer keeps a long folder error scrollable without losing the opening action', async function () {
		const { page } = browserTests;

		await page.goto('/viewpaneLayout.html?view=empty');
		const body = page.locator('.ash-empty-explorer');
		const open = body.getByRole('button', { name: 'Open Folder', exact: true });
		await open.press('Enter');
		await expect(body.getByRole('status')).toContainText('Folder opening failed.');
		await body.hover();
		await page.mouse.wheel(0, 1000);
		await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
		await expect(body.getByRole('status')).toBeInViewport();
		await page.mouse.wheel(0, -1000);
		await expect.poll(() => body.evaluate(element => element.scrollTop)).toBe(0);
		await expect(body.locator('.ash-empty-explorer-message')).toBeInViewport({ ratio: 1 });
		await open.focus();
		await expect(open).toBeInViewport({ ratio: 1 });
	});

	test('SCM Agent Review keeps its empty message and action inside the minimum body', async function () {
		const { page } = browserTests;

		await page.goto('/viewpaneLayout.html?view=review');
		const body = page.locator('.ash-scm-secondary-pane');
		await expect(body.locator('.ash-scm-empty')).toBeInViewport({ ratio: 1 });
		await expect(body.getByRole('button')).toBeInViewport({ ratio: 1 });
		expect(await body.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
	});

	for (const [locale, theme] of [
		['en', 'ash-light'],
		['zh-CN', 'ash-light'],
		['zh-CN', 'ash-dark'],
		['zh-CN', 'ash-high-contrast-dark'],
		['zh-CN', 'ash-high-contrast-light'],
	]) {
		test(`Problems keeps compact filters and keyboard menu access (${locale}, ${theme})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/composite.html?problems&locale=${locale}`);
			await page.waitForFunction(() => !!window.ashCompositeIntegration);
			await page.evaluate(async theme => {
				window.ashCompositeIntegration.setEditorTheme(theme);
				await window.ashCompositeIntegration.open('ash.panel.problems');
				window.ashCompositeIntegration.resize(480, 180);
			}, theme);
			const panel = page.locator('.ash-workbench-panel');
			const title = panel.locator('.ash-panel-title-control');
			const pane = panel.locator('[data-view-id="ash.problems"]');
			const input = title.getByRole('textbox');
			const filter = title.getByRole('button', { name: locale === 'en' ? 'Filter' : '筛选', exact: true });
			await expect(input).toHaveAttribute('placeholder', locale === 'en' ? 'Filter problems' : '筛选问题');
			const bounds = await title.locator('.ash-problems-controls').evaluate(element => {
				const input = element.querySelector('input')!.getBoundingClientRect();
				const menu = element.querySelector('button')!.getBoundingClientRect();
				return {
					overflow: element.scrollWidth - element.clientWidth,
					sameRow: Math.abs(input.top - menu.top) < 4,
					inputWidth: input.width,
					embedded: element.querySelector('.ash-problems-filter')!.contains(element.querySelector('button')),
				};
			});
			expect(bounds.overflow).toBeLessThanOrEqual(1);
			expect(bounds.sameRow).toBe(true);
			expect(bounds.embedded).toBe(true);
			expect(bounds.inputWidth).toBeGreaterThan(80);
			const collapse = title.getByRole('button', {
				name: locale === 'en' ? 'Collapse All' : '全部折叠',
				exact: true,
			});
			await collapse.press('Enter');
			const heading = pane.locator('.ash-problems-file-heading').first();
			await expect(heading).toHaveAttribute('aria-expanded', 'false');
			for (const items of await pane.locator('.ash-problems-file-items').all()) {
				await expect(items).toBeHidden();
			}
			await heading.press('Enter');
			await expect(heading).toHaveAttribute('aria-expanded', 'true');
			await collapse.focus();
			await page.keyboard.press('ArrowRight');
			const copy = title.getByRole('button', {
				name: locale === 'en' ? 'Copy Problems' : '复制问题',
				exact: true,
			});
			await expect(copy).toBeFocused();
			await copy.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashCompositeIntegration.copiedProblems.length)).toBe(1);
			expect(await page.evaluate(() => window.ashCompositeIntegration.copiedProblems[0])).toContain(
				"Type 'string' is not assignable to type 'number'.",
			);
			await input.focus();
			await page.keyboard.press('Tab');
			await expect(filter).toBeFocused();
			await filter.press('ArrowDown');
			const errorOption = page.getByRole('menuitemcheckbox', {
				name: locale === 'en' ? 'Errors' : '错误',
				exact: true,
			});
			await expect(errorOption).toHaveAttribute('aria-checked', 'true');
			await errorOption.press('Enter');
			await expect(pane.locator('.ash-problems-item')).toHaveCount(1);
			await expect(filter).toBeFocused();
			const clear = pane.getByRole('button', {
				name: locale === 'en' ? 'Clear Filters' : '清除筛选',
				exact: true,
			});
			await clear.press('Enter');
			await expect(input).toBeFocused();
			await expect(pane.locator('.ash-problems-item')).toHaveCount(2);
			await filter.press('ArrowDown');
			await expect(errorOption).toHaveAttribute('aria-checked', 'true');
			await page.keyboard.press('Escape');
			await expect(filter).toBeFocused();
			await input.fill('no match');
			await expect(pane.getByRole('status')).toContainText(locale === 'en' ? 'No problems match' : '没有匹配');
			await clear.press('Enter');
			await testInfo.attach('problems-compact', { body: await panel.screenshot(), contentType: 'image/png' });
			expect(errors).toEqual([]);
		});
	}

	test('Problems distinguishes an empty window from a project without diagnostics', async function () {
		const { page } = browserTests;

		await page.goto('/viewpaneLayout.html?view=problems&locale=zh-CN&emptyWorkspace&noProblems');
		await expect(page.getByRole('status')).toHaveText('打开文件夹以查看项目诊断。');
		await page.goto('/viewpaneLayout.html?view=problems&locale=zh-CN&noProblems');
		await expect(page.getByRole('status')).toHaveText('当前没有问题。');
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`Timeline keeps the filename in its header and entries at the pane edge (${locale})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			for (const theme of ['', 'dark', 'hc', 'hcLight']) {
				await page.goto(`/viewpaneLayout.html?view=timeline&locale=${locale}&${theme}`);
				const pane = page.locator('[data-view-id="fixture.timeline"]');
				const header = pane.locator('.ash-pane-view-header');
				const filename = header.locator('.ash-view-pane-header-description');
				const tree = pane.getByRole('tree');
				await expect(filename).toHaveText('file.txt');
				await expect(
					header.getByRole('button', {
						name: `${locale === 'en' ? 'Timeline' : '时间线'} file.txt`,
						exact: true,
					}),
				).toBeVisible();
				await expect(tree.getByRole('treeitem').first()).toBeVisible();
				const headerBounds = (await header.boundingBox())!;
				const treeBounds = (await tree.boundingBox())!;
				const firstRow = tree.getByRole('treeitem').first();
				const iconBounds = (await firstRow.locator('.ash-timeline-row > .ash-icon').boundingBox())!;
				expect(treeBounds.y).toBeCloseTo(headerBounds.y + headerBounds.height);
				expect(iconBounds.x - treeBounds.x).toBe(12);
				await expect(firstRow.locator('.ash-tree-twistie')).toHaveCSS('width', '0px');
				await tree.focus();
				await tree.press('Home');
				await tree.press('Enter');
				await expect
					.poll(() => page.evaluate(() => window.viewpaneLayoutIntegration.commands))
					.toEqual(['fixture.open']);
				await testInfo.attach(`timeline-${locale}-${theme || 'light'}`, {
					body: await pane.screenshot(),
					contentType: 'image/png',
				});
				const longName = 'a-very-long-filename-that-must-not-push-the-view-title-out-of-the-header.txt';
				await page.evaluate(
					name => window.viewpaneLayoutIntegration.timeline.setFile(`/fixture/${name}`),
					longName,
				);
				await expect(filename).toHaveText(longName);
				await expect(filename).toHaveCSS('text-overflow', 'ellipsis');
				expect(await filename.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
				expect(await header.locator('h3').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(
					true,
				);
				await filename.hover();
				await expect(page.getByRole('tooltip')).toContainText(`/fixture/${longName}`);
			}
		});

		test(`Timeline loads the next page when scrolled to the end (${locale})`, async function () {
			const { page } = browserTests;

			await page.goto(`/viewpaneLayout.html?view=timeline&locale=${locale}`);
			const tree = page.locator('.ash-timeline-tree');
			const size = () => tree.getByRole('treeitem').first().getAttribute('aria-setsize');
			await expect.poll(size).toBe('9');
			await expect
				.poll(() =>
					page.evaluate(() =>
						window.viewpaneLayoutIntegration.timeline.requests.map(request => request.cursor),
					),
				)
				.toEqual([0]);
			await page.evaluate(() => window.viewpaneLayoutIntegration.timeline.setMode('hold'));
			await tree.hover();
			await page.mouse.wheel(0, 1000);
			await expect(tree).toHaveAttribute('aria-busy', 'true');
			await expect(tree).toContainText(locale === 'en' ? 'Loading…' : '正在加载…');
			await page.mouse.wheel(0, 1000);
			await page.mouse.wheel(0, 1000);
			await expect
				.poll(() =>
					page.evaluate(() =>
						window.viewpaneLayoutIntegration.timeline.requests.map(request => request.cursor),
					),
				)
				.toEqual([0, 8]);
			await page.evaluate(() => window.viewpaneLayoutIntegration.timeline.release());
			await expect.poll(size).toBe('17');
			await expect(tree).toHaveAttribute('aria-busy', 'false');
			await expect
				.poll(() =>
					page.evaluate(() =>
						window.viewpaneLayoutIntegration.timeline.requests.map(request => request.cursor),
					),
				)
				.toEqual([0, 8]);
			await page.mouse.wheel(0, 1000);
			await expect.poll(size).toBe('25');
			await page.mouse.wheel(0, 1000);
			await expect(tree).toHaveAttribute('aria-busy', 'false');
			await expect
				.poll(() =>
					page.evaluate(() =>
						window.viewpaneLayoutIntegration.timeline.requests.map(request => request.cursor),
					),
				)
				.toEqual([0, 8, 16, 24]);
			await expect(tree).not.toContainText(locale === 'en' ? 'Load More' : '加载更多');
			const content = await page.evaluate(() => window.viewpaneLayoutIntegration.timeline.content());
			expect(content.match(/Entry \d+/gu)).toHaveLength(25);
			expect(content).toContain('Entry 24');
			await tree.press('Home');
			await tree.press('Enter');
			await expect
				.poll(() => page.evaluate(() => window.viewpaneLayoutIntegration.commands))
				.toEqual(['fixture.open']);
		});
	}

	for (const mode of ['fail', 'stall'] as const) {
		test(`Timeline pauses automatic loading after a ${mode} and supports keyboard retry`, async function () {
			const { page } = browserTests;

			await page.goto('/viewpaneLayout.html?view=timeline&locale=zh-CN');
			const tree = page.locator('.ash-timeline-tree');
			await expect(tree.getByRole('treeitem').first()).toHaveAttribute('aria-setsize', '9');
			await page.evaluate(mode => window.viewpaneLayoutIntegration.timeline.setMode(mode), mode);
			await tree.hover();
			await page.mouse.wheel(0, 1000);
			await expect(tree).toContainText('重试加载');
			await expect(tree).toHaveAttribute('aria-busy', 'false');
			await page.mouse.wheel(0, -1000);
			await page.mouse.wheel(0, 1000);
			await expect
				.poll(() =>
					page.evaluate(() =>
						window.viewpaneLayoutIntegration.timeline.requests.map(request => request.cursor),
					),
				)
				.toEqual([0, 8]);
			await tree.press('End');
			await tree.press('Enter');
			await expect(tree.getByRole('treeitem').first()).toHaveAttribute('aria-setsize', '17');
			await expect(tree).not.toContainText('重试加载');
			await expect
				.poll(() =>
					page.evaluate(() =>
						window.viewpaneLayoutIntegration.timeline.requests.map(request => request.cursor),
					),
				)
				.toEqual([0, 8, 8]);
		});
	}

	test('Timeline fills a short viewport automatically and stops requests on disposal', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/viewpaneLayout.html?view=timeline&shortPages');
		const tree = page.locator('.ash-timeline-tree');
		await expect
			.poll(() => page.evaluate(() => window.viewpaneLayoutIntegration.timeline.requests.length))
			.toBeGreaterThan(1);
		await expect.poll(() => tree.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
		await expect(tree).toHaveAttribute('aria-busy', 'false');
		await page.evaluate(() => window.viewpaneLayoutIntegration.timeline.setMode('hold'));
		await tree.hover();
		await page.mouse.wheel(0, 1000);
		await expect(tree).toHaveAttribute('aria-busy', 'true');
		const requests = await page.evaluate(() => window.viewpaneLayoutIntegration.timeline.requests.length);
		await page.evaluate(() => window.viewpaneLayoutIntegration.dispose());
		await expect(tree).toHaveCount(0);
		expect(await page.evaluate(() => window.viewpaneLayoutIntegration.timeline.requests.length)).toBe(requests);
		expect(errors).toEqual([]);
	});

	test('Timeline discards an automatic continuation when the selected file changes', async function () {
		const { page } = browserTests;

		await page.goto('/viewpaneLayout.html?view=timeline');
		const tree = page.locator('.ash-timeline-tree');
		await expect(tree.getByRole('treeitem').first()).toHaveAttribute('aria-setsize', '9');
		await page.evaluate(() => window.viewpaneLayoutIntegration.timeline.setMode('hold'));
		await tree.hover();
		await page.mouse.wheel(0, 1000);
		await expect(tree).toHaveAttribute('aria-busy', 'true');
		await page.evaluate(() => window.viewpaneLayoutIntegration.timeline.setFile('/fixture/other.txt'));
		await expect(page.locator('.ash-view-pane-header-description')).toHaveText('other.txt');
		await expect(tree).toHaveAttribute('aria-busy', 'false');
		await page.evaluate(() => window.viewpaneLayoutIntegration.timeline.release());
		await expect(tree.getByRole('treeitem').first()).toHaveAttribute('aria-setsize', '9');
		const content = await page.evaluate(() => window.viewpaneLayoutIntegration.timeline.content());
		expect(content).toContain('/fixture/other.txt Entry 0');
		expect(content).not.toContain('/fixture/file.txt');
		expect(await page.evaluate(() => window.viewpaneLayoutIntegration.timeline.requests)).toEqual([
			{ cursor: 0, uri: '/fixture/file.txt' },
			{ cursor: 8, uri: '/fixture/file.txt' },
			{ cursor: 0, uri: '/fixture/other.txt' },
		]);
	});

	test('Timeline keeps an in-flight continuation when collapsed without reloading the first page', async function () {
		const { page } = browserTests;

		await page.goto('/viewpaneLayout.html?view=timeline');
		const tree = page.locator('.ash-timeline-tree');
		await expect(tree.getByRole('treeitem').first()).toHaveAttribute('aria-setsize', '9');
		await page.evaluate(() => window.viewpaneLayoutIntegration.timeline.setMode('hold'));
		await tree.hover();
		await page.mouse.wheel(0, 1000);
		await expect(tree).toHaveAttribute('aria-busy', 'true');
		const header = page.locator('[data-view-id="fixture.timeline"] .ash-pane-view-header');
		await header.click();
		await expect(tree).toBeHidden();
		await page.evaluate(() => window.viewpaneLayoutIntegration.timeline.release());
		await expect(tree).toHaveAttribute('aria-busy', 'false');
		expect(
			await page.evaluate(() =>
				window.viewpaneLayoutIntegration.timeline.requests.map(request => request.cursor),
			),
		).toEqual([0, 8]);
		await header.click();
		await expect(tree.getByRole('treeitem').first()).toHaveAttribute('aria-setsize', '17');
		expect(
			await page.evaluate(() =>
				window.viewpaneLayoutIntegration.timeline.requests.map(request => request.cursor),
			),
		).toEqual([0, 8]);
	});

	test('Timeline retains loaded pages, scroll and selection across repeated collapse and expand', async function () {
		const { page } = browserTests;

		await page.goto('/viewpaneLayout.html?view=timeline');
		const tree = page.locator('.ash-timeline-tree');
		await expect(tree.getByRole('treeitem').first()).toHaveAttribute('aria-setsize', '9');
		await tree.hover();
		await page.mouse.wheel(0, 1000);
		await expect(tree.getByRole('treeitem').first()).toHaveAttribute('aria-setsize', '17');
		await tree.getByRole('treeitem').nth(8).click();
		const selected = await tree.locator('.selected').textContent();
		const scrollTop = await tree.evaluate(element => element.scrollTop);
		expect(scrollTop).toBeGreaterThan(0);
		const requests = await page.evaluate(() => window.viewpaneLayoutIntegration.timeline.requests);
		const header = page.locator('[data-view-id="fixture.timeline"] .ash-pane-view-header-button');
		for (let cycle = 0; cycle < 3; cycle++) {
			await header.press('ArrowLeft');
			await expect(tree).toBeHidden();
			await header.press('ArrowRight');
			await expect(tree).toBeVisible();
			await expect(tree).toHaveAttribute('aria-busy', 'false');
			await expect(tree.getByRole('treeitem').first()).toHaveAttribute('aria-setsize', '17');
			await expect(tree.locator('.selected')).toHaveText(selected!);
			expect(await tree.evaluate(element => element.scrollTop)).toBe(scrollTop);
			expect(await page.evaluate(() => window.viewpaneLayoutIntegration.timeline.requests)).toEqual(requests);
		}
	});

	test('Timeline defers an invalidated history until reopening and still supports explicit refresh', async function () {
		const { page } = browserTests;

		await page.goto('/viewpaneLayout.html?view=timeline');
		const tree = page.locator('.ash-timeline-tree');
		await expect(tree).toHaveAttribute('aria-busy', 'false');
		await expect(tree.getByRole('treeitem').first()).toBeVisible();
		const header = page.locator('[data-view-id="fixture.timeline"] .ash-pane-view-header-button');
		await header.press('ArrowLeft');
		await page.evaluate(() => window.viewpaneLayoutIntegration.timeline.invalidate('/fixture/file.txt'));
		expect(
			await page.evaluate(() =>
				window.viewpaneLayoutIntegration.timeline.requests.map(request => request.cursor),
			),
		).toEqual([0]);
		await page.evaluate(() => window.viewpaneLayoutIntegration.timeline.setMode('hold'));
		await header.press('ArrowRight');
		await expect(tree).toHaveAttribute('aria-busy', 'true');
		await page.evaluate(() => window.viewpaneLayoutIntegration.timeline.release());
		await expect(tree).toHaveAttribute('aria-busy', 'false');
		await expect(tree.getByRole('treeitem').first()).toBeVisible();
		expect(
			await page.evaluate(() =>
				window.viewpaneLayoutIntegration.timeline.requests.map(request => request.cursor),
			),
		).toEqual([0, 0]);
		await header.hover();
		await page.getByRole('button', { name: 'Refresh', exact: true }).click();
		await expect(tree).toHaveAttribute('aria-busy', 'false');
		expect(
			await page.evaluate(() =>
				window.viewpaneLayoutIntegration.timeline.requests.map(request => request.cursor),
			),
		).toEqual([0, 0, 0]);
	});

	test('Timeline caches an empty source across collapse and expand', async function () {
		const { page } = browserTests;

		await page.goto('/viewpaneLayout.html?view=timeline&emptyTimeline');
		await expect(page.getByRole('status')).toHaveText('No timeline information was provided.');
		const header = page.locator('[data-view-id="fixture.timeline"] .ash-pane-view-header-button');
		for (let cycle = 0; cycle < 3; cycle++) {
			await header.press('ArrowLeft');
			await header.press('ArrowRight');
			await expect(page.getByRole('status')).toHaveText('No timeline information was provided.');
		}
		expect(
			await page.evaluate(() =>
				window.viewpaneLayoutIntegration.timeline.requests.map(request => request.cursor),
			),
		).toEqual([0]);
	});
});
