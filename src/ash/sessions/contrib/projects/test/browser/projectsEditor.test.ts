import { expect } from '@playwright/test';
import { suite, test, teardown } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('Projects toolbar', () => {
	const browser = useBrowserTests();
	teardown(async () => {
		expect(await browser.page.evaluate(() => window.ashSessionsIntegration.errors)).toEqual([]);
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`shows localized update times and refreshes them without replacing focused cards (${locale})`, async () => {
			const { page, info } = browser;
			const chinese = locale === 'zh-CN';
			const updatedAt = new Date('2026-10-25T18:00:00Z');
			const createdAt = updatedAt.getTime() - 5 * 86_400_000;
			await page.clock.install({ time: updatedAt });
			await page.goto(`/sessions.html?search&locale=${locale}&projectUpdatedAt=${updatedAt.getTime()}&projectCreatedAt=${createdAt}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.locator('[data-action-id="sessions.open.projects"] button').click();
			const card = page.locator('.ash-projects-card');
			const caption = card.locator('time.ash-projects-card-caption');
			await expect(caption).toHaveText(chinese ? '刚刚' : 'Just now');
			await expect(caption).toHaveAttribute('datetime', updatedAt.toISOString());
			await expect(card).toHaveAccessibleName('Search project fixture');
			const absoluteTime = await caption.getAttribute('aria-label');
			await expect(card).toHaveAccessibleDescription(absoluteTime!);
			const originalCard = await card.elementHandle();
			await card.focus();
			for (const [advance, expected] of [
				[60_000, chinese ? '1分钟前' : '1 minute ago'],
				[4 * 60_000, chinese ? '5分钟前' : '5 minutes ago'],
				[2 * 3_600_000, chinese ? '2小时前' : '2 hours ago'],
				[3 * 86_400_000, chinese ? '3天前' : '3 days ago'],
			] as const) {
				await page.clock.fastForward(advance);
				await expect(caption).toHaveText(expected);
				await expect(card).toBeFocused();
				expect(await originalCard!.evaluate(element => element.isConnected)).toBe(true);
			}
			await caption.hover();
			await expect(page.getByRole('tooltip')).toHaveText(absoluteTime!);
			await page.screenshot({ path: info.outputPath(`projects-relative-time-${locale}.png`) });
			await page.goto(`/sessions.html?search&locale=${locale}&projectCreatedAt=${createdAt}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.locator('[data-action-id="sessions.open.projects"] button').click();
			await expect(caption).toHaveAttribute('datetime', new Date(createdAt).toISOString());
			await expect(caption).toHaveText(chinese ? '8天前' : '8 days ago');
			await page.goto(`/sessions.html?search&locale=${locale}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.locator('[data-action-id="sessions.open.projects"] button').click();
			await expect(card).toBeVisible();
			await expect(caption).toHaveCount(0);
		});

		test(`uses the Sessions menu geometry without changing shared menu defaults (${locale})`, async () => {
			const { page, info } = browser;
			await page.goto(`/sessions.html?search&locale=${locale}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.locator('[data-action-id="sessions.open.projects"] button').click();
			const sort = page.getByRole('button', { name: locale === 'zh-CN' ? '项目排序' : 'Sort projects', exact: true });
			await expect(sort.locator('.ash-icon-sort')).toHaveCSS('font-size', '18px');
			for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
				await page.evaluate(theme => window.ashSessionsIntegration.setTheme(theme), theme);
				await sort.press('ArrowDown');
				const menu = page.locator('.ash-projects-sort-menu');
				const popup = menu.locator('..');
				const selected = menu.getByRole('menuitemradio', { checked: true });
				await expect(popup).toHaveCSS('border-radius', '16px');
				await expect(menu).toHaveCSS('padding', '6px');
				await expect(menu).toHaveCSS('min-width', '160px');
				for (const item of await menu.getByRole('menuitemradio').all()) {
					await expect(item).toHaveCSS('height', '28px');
					await expect(item).toHaveCSS('padding-inline-start', '12px');
					await expect(item).toHaveCSS('padding-inline-end', '12px');
					await expect(item).toHaveCSS('border-radius', '8px');
				}
				const check = selected.locator('.ash-menu-leading-check > .ash-icon');
				await expect(check).toHaveClass(/ash-icon-check/);
				await expect(check).toHaveCSS('font-size', '20px');
				const checkBounds = (await check.boundingBox())!;
				const textBounds = (await selected.locator('.ash-button-label').boundingBox())!;
				expect(checkBounds.x).toBeGreaterThanOrEqual(textBounds.x + textBounds.width);
				const focused = menu.locator('.focused > button');
				const colors = await focused.evaluate(element => {
					const style = getComputedStyle(element);
					return { foreground: style.color, background: style.backgroundColor };
				});
				expect(colors.foreground).not.toBe(colors.background);
				await page.screenshot({ path: info.outputPath(`projects-menu-${locale}-${theme}.png`) });
				if (theme === 'ash-light') {
					await popup.evaluate(element => {
						const outside = element.cloneNode(true) as HTMLElement;
						outside.id = 'outside-sessions-menu';
						outside.querySelector('.ash-projects-sort-menu')!.classList.remove('ash-projects-sort-menu');
						document.body.append(outside);
					});
					const outside = page.locator('#outside-sessions-menu');
					try {
						await expect(outside).toHaveCSS('border-radius', '8px');
						await expect(outside.getByRole('menu')).toHaveCSS('padding', '4px');
						await expect(outside.getByRole('menu')).toHaveCSS('min-width', '180px');
					} finally {
						await outside.evaluate(element => element.remove());
					}
				}
				await page.keyboard.press('Escape');
				await expect(popup).toHaveCount(0);
				await expect(sort).toBeFocused();
			}
		});

		test(`collapses empty search on blur without stealing focus and retains active filters (${locale})`, async () => {
			const { page } = browser;
			const chinese = locale === 'zh-CN';
			await page.goto(`/sessions.html?search&locale=${locale}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.locator('[data-action-id="sessions.open.projects"] button').click();
			const projects = page.locator('.ash-projects');
			const search = projects.getByRole('button', { name: chinese ? '搜索项目' : 'Search projects', exact: true });
			const close = projects.getByRole('button', { name: chinese ? '关闭项目搜索' : 'Close project search', exact: true });
			const input = projects.getByRole('searchbox', { includeHidden: true });
			const sort = projects.getByRole('button', { name: chinese ? '项目排序' : 'Sort projects', exact: true });
			const heading = projects.locator('h1');
			await search.click();
			await expect(input).toBeFocused();
			await projects.click({ position: { x: 12, y: 300 } });
			await expect(input).toBeHidden();
			await expect(search).toBeVisible();
			await expect(search).not.toBeFocused();
			await search.click();
			await heading.click();
			await expect(input).toBeHidden();
			await expect(search).toBeVisible();
			await expect(heading).toBeFocused();
			await search.click();
			await input.press('Tab');
			await expect(close).toBeFocused();
			await expect(input).toBeVisible();
			await close.press('Tab');
			await expect(input).toBeHidden();
			await expect(projects.locator('.ash-projects-card')).toBeFocused();
			await search.click();
			await sort.click();
			await expect(input).toBeHidden();
			await expect(page.locator('.ash-projects-sort-menu')).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(sort).toBeFocused();
			await search.click();
			await input.fill('Search project');
			await heading.click();
			await expect(input).toBeVisible();
			await expect(input).toHaveValue('Search project');
			await expect(page.locator('.ash-projects-card-name')).toHaveText(['Search project fixture']);
			await close.click();
			await expect(input).toBeHidden();
			await expect(input).toHaveValue('');
			await expect(search).toBeFocused();
			await search.click();
			await input.press('Alt+F1');
			await expect(page.locator('.ash-accessible-view-content')).toHaveValue(chinese ? /空搜索框失去焦点后会收起/ : /An empty search collapses when focus leaves it/);
			await expect(input).toBeHidden();
			await page.keyboard.press('Escape');
			await expect(search).toBeFocused();
		});

		test(`keeps one Tab stop, navigates actions and restores popup focus (${locale})`, async () => {
			const { page } = browser;
			const chinese = locale === 'zh-CN';
			await page.goto(`/sessions.html?search&locale=${locale}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.locator('[data-action-id="sessions.open.projects"] button').click();
			const toolbar = page.getByRole('toolbar', { name: chinese ? '项目操作' : 'Project actions', exact: true });
			const search = toolbar.getByRole('button', { name: chinese ? '搜索项目' : 'Search projects', exact: true });
			const sort = toolbar.getByRole('button', { name: chinese ? '项目排序' : 'Sort projects', exact: true });
			const create = toolbar.getByRole('button', { name: chinese ? '新建项目' : 'New project', exact: true });
			await expect(toolbar).toHaveClass(/ash-toolbar/);
			await expect(toolbar.getByRole('button')).toHaveCount(3);
			await expect(create).toHaveClass(/ash-button-primary/);
			await expect(create).toBeFocused();
			await expect(toolbar.locator('button[tabindex="0"]')).toHaveCount(1);

			await page.keyboard.press('Home');
			await expect(search).toBeFocused();
			await page.keyboard.press('ArrowRight');
			await expect(sort).toBeFocused();
			const sortNode = await sort.elementHandle();
			await page.keyboard.press('ArrowDown');
			const menu = page.locator('.ash-projects-sort-menu');
			await expect(sort).toHaveAttribute('aria-expanded', 'true');
			await expect(menu.getByRole('menuitemradio')).toHaveCount(3);
			await page.keyboard.press('ArrowDown');
			await page.keyboard.press('Enter');
			await expect(menu).toHaveCount(0);
			await expect(sort).toBeFocused();
			await expect(sort).toHaveAttribute('aria-expanded', 'false');
			expect(await sortNode!.evaluate(element => element.isConnected)).toBe(true);
			await page.keyboard.press('ArrowRight');
			await expect(create).toBeFocused();
			await page.keyboard.press('Enter');
			const dialog = page.getByRole('dialog', { name: chinese ? '创建项目' : 'Create a project', exact: true });
			await expect(dialog.getByRole('textbox', { name: chinese ? '你正在做什么？' : 'What are you working on?', exact: true })).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(dialog).toHaveCount(0);
			await expect(create).toBeFocused();
			await expect(toolbar.locator('button[tabindex="0"]')).toHaveCount(1);

			await create.press('Enter');
			await dialog.getByRole('textbox', { name: chinese ? '你正在做什么？' : 'What are you working on?', exact: true }).fill('Unavailable project save');
			const submit = dialog.getByRole('button', { name: chinese ? '创建项目' : 'Create project', exact: true });
			await submit.click();
			await expect(dialog.locator('.ash-projects-form-error')).not.toBeEmpty();
			await expect(submit).toBeEnabled();
			await page.keyboard.press('Escape');
			await expect(dialog).toHaveCount(0);
			await expect(create).toBeFocused();
			expect(await sortNode!.evaluate(element => element.isConnected)).toBe(true);

			await page.keyboard.press('Home');
			await page.keyboard.press('Enter');
			const input = page.getByRole('searchbox', { name: chinese ? '搜索项目' : 'Search projects', exact: true, includeHidden: true });
			await expect(input).toBeFocused();
			await input.fill('Search project');
			await expect(input).toBeFocused();
			await expect(page.locator('.ash-projects-card-name')).toHaveText(['Search project fixture']);
			await create.focus();
			await page.keyboard.press('Home');
			await expect(input).toBeFocused();
			await page.keyboard.press('Home');
			await page.keyboard.press('ArrowRight');
			expect(await input.evaluate(element => (element as HTMLInputElement).selectionStart)).toBe(1);
			await expect(input).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(toolbar.getByRole('button', { name: chinese ? '关闭项目搜索' : 'Close project search', exact: true })).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(input).toBeHidden();
			await expect(search).toBeFocused();
			await expect(input).toHaveValue('');
			await expect(page.locator('.ash-projects-card-name')).toHaveText(['Search project fixture']);
			await sort.focus();
			await page.keyboard.press('ArrowUp');
			await expect(menu).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(sort).toBeFocused();
			await page.keyboard.press('Alt+F1');
			await expect(page.locator('.ash-accessible-view-content')).toHaveValue(chinese ? /使用左右方向键在搜索、排序和新建项目之间移动/ : /Left and Right Arrow to move between Search, Sort and New project/);
			await page.keyboard.press('Escape');
			await expect(sort).toBeFocused();
		});

		test(`expands search beside the heading without moving the project list (${locale})`, async () => {
			const { page } = browser;
			const chinese = locale === 'zh-CN';
			await page.goto(`/sessions.html?search&locale=${locale}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.locator('[data-action-id="sessions.open.projects"] button').click();
			const projects = page.locator('.ash-projects');
			const search = projects.getByRole('button', { name: chinese ? '搜索项目' : 'Search projects', exact: true });
			const close = projects.getByRole('button', { name: chinese ? '关闭项目搜索' : 'Close project search', exact: true });
			const input = projects.getByRole('searchbox', { includeHidden: true });
			const sort = projects.getByRole('button', { name: chinese ? '项目排序' : 'Sort projects', exact: true });
			const create = projects.getByRole('button', { name: chinese ? '新建项目' : 'New project', exact: true });
			for (const width of [1280, 760]) {
				await page.setViewportSize({ width, height: 720 });
				for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
					await page.evaluate(theme => window.ashSessionsIntegration.setTheme(theme), theme);
					const bodyBefore = (await projects.locator('.ash-projects-body').boundingBox())!;
					const sortBefore = (await sort.boundingBox())!;
					const createBefore = (await create.boundingBox())!;
					await search.click();
					await expect(input).toBeFocused();
					await expect.poll(async () => projects.locator('.ash-projects-search-action').evaluate(element => element.getAnimations().length)).toBe(0);
					const field = (await projects.locator('.ash-projects-search-field').boundingBox())!;
					expect(field.width).toBeLessThanOrEqual(260);
					const heading = (await projects.locator('h1').boundingBox())!;
					expect(field.x).toBeGreaterThanOrEqual(heading.x + heading.width);
					expect(field.y).toBeLessThan(heading.y + heading.height);
					expect(field.y + field.height).toBeGreaterThan(heading.y);
					expect(field.x + field.width).toBeLessThanOrEqual(sortBefore.x);
					expect((await projects.locator('.ash-projects-body').boundingBox())!.y).toBe(bodyBefore.y);
					expect(await sort.boundingBox()).toEqual(sortBefore);
					expect(await create.boundingBox()).toEqual(createBefore);
					await expect(input).toBeInViewport();
					await expect(close).toBeInViewport();
					await input.fill('Search project');
					await expect(page.locator('.ash-projects-card-name')).toHaveText(['Search project fixture']);
					if (theme === 'ash-light') {
						await page.screenshot({ path: browser.info.outputPath(`projects-inline-search-${locale}-${width}.png`) });
					}
					await input.fill('No matching project');
					await expect(page.locator('.ash-projects-card-name')).toHaveCount(0);
					await close.click();
					await expect(input).toBeHidden();
					await expect(search).toBeFocused();
					await expect(input).toHaveValue('');
					await expect(page.locator('.ash-projects-card-name')).toHaveText(['Search project fixture']);
				}
			}
		});
	}

	test('animates a compact search, supports reversing direction and respects reduced motion', async () => {
		const { page } = browser;
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await page.goto('/sessions.html?search');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.locator('[data-action-id="sessions.open.projects"] button').click();
		const projects = page.locator('.ash-projects');
		const search = projects.getByRole('button', { name: 'Search projects', exact: true });
		const close = projects.getByRole('button', { name: 'Close project search', exact: true });
		const input = projects.getByRole('searchbox', { includeHidden: true });
		const slot = projects.locator('.ash-projects-search-action');
		const collapsedWidth = (await slot.boundingBox())!.width;
		const sample = async (trigger: typeof search) => trigger.evaluate(element => {
			(element as HTMLButtonElement).click();
			const slot = element.closest('.ash-projects-search-action')!;
			const animation = slot.getAnimations().find(animation => animation instanceof CSSTransition && animation.transitionProperty === 'width');
			if (!animation) { throw new Error('Search width transition did not start'); }
			const duration = Number(animation.effect!.getTiming().duration);
			animation.pause();
			animation.currentTime = duration / 2;
			return { duration, width: slot.getBoundingClientRect().width };
		});
		const opening = await sample(search);
		expect(opening.duration).toBe(120);
		expect(opening.width).toBeGreaterThan(collapsedWidth);
		expect(opening.width).toBeLessThan(260);
		await slot.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => animation.finish()));
		await expect(slot).toHaveCSS('width', '260px');
		await expect(input).toBeFocused();
		const closing = await sample(close);
		expect(closing.width).toBeGreaterThan(collapsedWidth);
		expect(closing.width).toBeLessThan(260);
		await expect(projects.locator('.ash-projects-search-field')).toHaveAttribute('inert', '');
		await expect(search).toBeFocused();
		await search.click();
		await slot.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => animation.finish()));
		await expect(input).toBeFocused();
		await expect(slot).toHaveCSS('width', '260px');
		await expect(projects.locator('.ash-projects-search-field')).not.toHaveAttribute('inert', '');
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await input.press('Escape');
		await expect(input).toBeHidden();
		await expect(slot).toHaveCSS('width', `${collapsedWidth}px`);
		await search.click();
		await expect(input).toBeFocused();
		await expect(slot).toHaveCSS('width', '260px');
		expect(await slot.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
	});
});

suite('Projects loading states', () => {
	const browser = useBrowserTests();
	teardown(async () => {
		expect(await browser.page.evaluate(() => window.ashSessionsIntegration.errors)).toEqual([]);
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`uses layout-matched skeletons and retains loaded content during refresh (${locale})`, async () => {
			const { page, info } = browser;
			const chinese = locale === 'zh-CN';
			await page.goto(`/sessions.html?search&locale=${locale}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			const holdList = () => page.evaluateHandle(() => {
				const projects = globalThis.ashWebWorkbenchHost!.api.projects;
				const original = projects.list;
				let finish!: () => void;
				const pending = new Promise<void>(resolve => { finish = resolve; });
				projects.list = async () => { await pending; return original.call(projects); };
				return { release: () => { projects.list = original; finish(); } };
			});
			const projects = page.locator('.ash-projects');
			const body = projects.locator('.ash-projects-body');
			const skeleton = projects.locator('.ash-projects-skeleton');
			const firstLoad = await holdList();
			try {
				await page.locator('[data-action-id="sessions.open.projects"] button').click();
				await expect(body).toHaveAttribute('aria-busy', 'true');
				await expect(skeleton).toHaveAttribute('aria-hidden', 'true');
				await expect(skeleton.locator('.ash-projects-skeleton-card')).toHaveCount(6);
				await expect(skeleton.locator('button, input, [tabindex]')).toHaveCount(0);
				await expect(projects.getByRole('status')).toHaveText(chinese ? '正在加载项目…' : 'Loading projects…');
				await expect(projects.locator('.ash-projects-empty')).toHaveCount(0);
				for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
					await page.evaluate(theme => window.ashSessionsIntegration.setTheme(theme), theme);
					const block = skeleton.locator('.ash-projects-skeleton-name').first();
					await expect(block).toBeVisible();
					const colors = await block.evaluate(element => ({ fill: getComputedStyle(element).backgroundColor, canvas: getComputedStyle(element.closest('.ash-projects')!).backgroundColor, outline: getComputedStyle(element).outlineStyle }));
					if (theme.includes('contrast')) { expect(colors.outline).toBe('solid'); }
					else { expect(colors.fill).not.toBe(colors.canvas); }
					await page.screenshot({ path: info.outputPath(`projects-list-loading-${locale}-${theme}.png`) });
				}
				const before = (await skeleton.locator('.ash-projects-skeleton-card').first().boundingBox())!;
				await firstLoad.evaluate(gate => gate.release());
				await expect(body).toHaveAttribute('aria-busy', 'false');
				await expect(skeleton).toHaveCount(0);
				const after = (await projects.locator('.ash-projects-card').boundingBox())!;
				expect({ x: after.x, y: after.y, width: after.width, height: after.height }).toEqual(before);
			} finally {
				await firstLoad.evaluate(gate => gate.release());
				await firstLoad.dispose();
			}

			const detailLoad = await holdList();
			try {
				await projects.getByRole('button', { name: 'Search project fixture', exact: true }).click();
				await expect(skeleton).toHaveClass(/ash-projects-detail/);
				await expect(projects.locator('h1')).toHaveAccessibleName(chinese ? '正在加载项目…' : 'Loading projects…');
				await expect(page.locator('.ash-projects-breadcrumb-name')).toHaveClass(/ash-projects-placeholder/);
				await expect(page.locator('.ash-projects-breadcrumb-name')).toHaveAttribute('aria-hidden', 'true');
				await expect(page.locator('.ash-projects-breadcrumb-name')).toHaveCSS('opacity', '1');
				await expect(page.locator('.ash-projects-breadcrumb-name')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				for (const width of [1280, 720]) {
					await page.setViewportSize({ width, height: 720 });
					await page.emulateMedia({ reducedMotion: 'reduce' });
					const overview = (await skeleton.locator('.ash-projects-overview').boundingBox())!;
					const materials = (await skeleton.locator('.ash-projects-materials').boundingBox())!;
					if (width === 720) { expect(materials.y).toBeGreaterThanOrEqual(overview.y + overview.height); }
					else { expect(materials.y).toBe(overview.y); }
					expect(await skeleton.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
					expect(await skeleton.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
					await page.screenshot({ path: info.outputPath(`projects-detail-loading-${locale}-${width}.png`) });
				}
				await detailLoad.evaluate(gate => gate.release());
				await expect(projects.locator('h1')).toHaveText('Search project fixture');
				await expect(skeleton).toHaveCount(0);
				await expect(page.locator('.ash-projects-breadcrumb-name')).not.toHaveClass(/ash-projects-placeholder/);
			} finally {
				await detailLoad.evaluate(gate => gate.release());
				await detailLoad.dispose();
			}

			const refresh = await holdList();
			try {
				await page.locator('[data-action-id="sessions.open.projects"] button').click();
				await expect(body).toHaveAttribute('aria-busy', 'true');
				await expect(projects.locator('h1')).toHaveText('Search project fixture');
				await expect(projects.locator('.ash-projects-description')).toHaveText('Synthetic project for Search navigation');
				await expect(skeleton).toHaveCount(0);
				await page.locator('.ash-projects-breadcrumb').getByRole('button', { name: chinese ? '项目' : 'Projects', exact: true }).click();
				await expect(body).toHaveAttribute('aria-busy', 'true');
				await expect(projects.locator('.ash-projects-card-name')).toHaveText('Search project fixture');
				await expect(skeleton).toHaveCount(0);
				await refresh.evaluate(gate => gate.release());
				await expect(body).toHaveAttribute('aria-busy', 'false');
			} finally {
				await refresh.evaluate(gate => gate.release());
				await refresh.dispose();
			}
		});
	}
});
