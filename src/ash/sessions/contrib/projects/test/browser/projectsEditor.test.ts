import { expect } from '@playwright/test';
import { suite, test, teardown } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import { Editor } from '../../../../../../../test/automation/editor.js';

suite('Projects toolbar', () => {
	const browser = useBrowserTests();
	teardown(async () => {
		expect(await browser.page.evaluate(() => window.ashSessionsIntegration.errors)).toEqual([]);
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`sidebar creation keeps the remote project on cancel and renames the new local project on save (${locale})`, async () => {
			const { page } = browser;
			const chinese = locale === 'zh-CN';
			await page.goto(`/sessions.html?projectCreation&locale=${locale}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			const projectsAction = page.locator('[data-action-id="sessions.open.projects"] > .ash-sessions-activity-item');
			await projectsAction.click();
			const projects = page.locator('.ash-projects');
			const remote = projects.getByRole('button', { name: 'Remote research', exact: true });
			await remote.click();
			const breadcrumb = page.locator('.ash-projects-breadcrumb');
			const remoteTitle = breadcrumb.getByRole('button', { name: 'Remote research', exact: true });
			await expect(remoteTitle).toBeDisabled();

			const createLabel = chinese ? '创建项目' : 'Create project';
			const create = page.locator('.ash-sessions-activity-content').getByRole('button', { name: createLabel, exact: true });
			const dialog = page.getByRole('dialog');
			const name = dialog.getByRole('textbox').first();
			const appearanceLabel = chinese ? '更改项目外观' : 'Change project appearance';
			const appearance = dialog.getByRole('button', { name: appearanceLabel });
			const picker = page.getByRole('dialog', { name: appearanceLabel, exact: true });
			const blue = picker.getByRole('button', { name: chinese ? '蓝色' : 'Blue', exact: true });
			await projectsAction.hover();
			await create.click();
			await appearance.click();
			await blue.click();
			await blue.press('Escape');
			await expect(appearance).toBeFocused();
			await dialog.getByRole('button', { name: chinese ? '取消' : 'Cancel', exact: true }).click();
			await page.getByRole('button', { name: chinese ? '放弃更改' : 'Discard', exact: true }).click();
			await expect(dialog).toHaveCount(0);
			await expect(create).toBeFocused();
			await expect(remoteTitle).toBeDisabled();
			await expect(projects).toHaveAttribute('aria-label', 'Remote research');

			await create.press('Enter');
			await name.fill('Local research');
			await appearance.click();
			await expect(blue).toHaveAttribute('aria-pressed', 'false');
			const search = picker.getByRole('combobox', { name: chinese ? '搜索图标' : 'Search icons' });
			await expect(search).toBeFocused();
			await search.fill('clockface');
			await picker.getByRole('option', { name: 'clockface', exact: true }).click();
			await blue.click();
			await expect(appearance.locator('[data-ash-icon-id="clockface"]')).toBeVisible();
			const previewColor = await appearance.evaluate(element => getComputedStyle(element).color);
			await picker.getByRole('button', { name: chinese ? '完成' : 'Done', exact: true }).click();
			await expect(appearance).toBeFocused();
			await dialog.getByRole('button', { name: chinese ? '创建' : 'Create', exact: true }).click();
			await expect(dialog).toHaveCount(0);
			await expect(projects).toHaveAttribute('aria-label', 'Local research');
			await expect(projects.locator('.ash-projects-composer')).toBeVisible();
			const renameLabel = chinese ? '重命名项目' : 'Rename project';
			await breadcrumb.getByRole('button', { name: `${renameLabel} Local research`, exact: true }).press('Enter');
			const input = breadcrumb.getByRole('textbox');
			await expect(input).toHaveValue('Local research');
			await input.fill('Renamed research');
			await input.press('Enter');
			await expect(breadcrumb.getByRole('button', { name: `${renameLabel} Renamed research`, exact: true })).toBeFocused();
			await expect(projects).toHaveAttribute('aria-label', 'Renamed research');

			await breadcrumb.getByRole('button', { name: chinese ? '项目' : 'Projects', exact: true }).click();
			const card = projects.getByRole('button', { name: 'Renamed research', exact: true });
			await expect(card.locator('.ash-projects-card-mark [data-ash-icon-id="clockface"]')).toHaveCSS('color', previewColor);
			await remote.click();
			await expect(remoteTitle).toBeDisabled();
		});

		test(`returns to the Projects overview and retains the draft when a project is reopened (${locale})`, async () => {
			const { page, info } = browser;
			const chinese = locale === 'zh-CN';
			await page.goto(`/sessions.html?search&locale=${locale}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			const projectsEntry = page.locator('[data-action-id="sessions.open.projects"] > .ash-sessions-activity-item');
			const card = page.locator('.ash-projects-card');
			await projectsEntry.click();
			await card.click();
			const composer = page.locator('.ash-projects-composer');
			await expect(composer).toHaveAccessibleName(chinese ? '在项目中新建聊天' : 'New chat in project');
			await expect(composer.locator('.ash-sessions-cowork-input.embedded-composer')).toBeVisible();
			await expect(composer.locator('.ash-sessions-chat-input')).toHaveCount(0);
			const editor = new Editor(composer);
			const input = editor.input;
			await editor.waitForEditorFocus();
			await editor.waitForTypeInEditor('Draft for this project');
			await input.press('ArrowLeft');
			const originalEditor = await input.elementHandle();
			await page.evaluate(() => window.ashSessionsIntegration.refreshProject());
			await expect(page.locator('.ash-projects-body')).toHaveAttribute('aria-busy', 'false');
			await expect(input).toBeFocused();
			await editor.waitForTypeInEditor('!');
			await editor.waitForEditorContents(text => text === 'Draft for this projec!t');
			expect(await originalEditor!.evaluate(element => element.isConnected)).toBe(true);
			await page.locator('[data-action-id="sessions.newSession"] button').click();
			await expect(page.locator('.ash-projects')).toBeHidden();
			await projectsEntry.click();
			await expect(page.locator('.ash-projects h1')).toHaveText(chinese ? '项目' : 'Projects');
			await expect(card).toBeVisible();
			await expect(composer).toBeHidden();
			await page.locator('[data-action-id="sessions.search"] button').click();
			const search = page.locator('.ash-sessions-search-dialog').getByRole('combobox');
			await search.fill('Search project fixture');
			await page.locator('.ash-sessions-search-dialog').getByRole('option', { name: /Search project fixture/ }).click();
			await expect(page.locator('.ash-project-titlebar-name')).toHaveText('Search project fixture');
			await editor.waitForEditorContents(text => text === 'Draft for this projec!t');
			expect(await originalEditor!.evaluate(element => element.isConnected)).toBe(true);
			await page.locator('.ash-projects-breadcrumb').getByRole('button', { name: chinese ? '项目' : 'Projects', exact: true }).click();
			await card.click();
			await editor.waitForEditorContents(text => text === 'Draft for this projec!t');
			expect(await originalEditor!.evaluate(element => element.isConnected)).toBe(true);
			for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
				await page.evaluate(theme => window.ashSessionsIntegration.setTheme(theme), theme);
				for (const width of [1280, 600]) {
					await page.setViewportSize({ width, height: 720 });
					await expect.poll(async () => {
						const bounds = await composer.boundingBox();
						return bounds ? bounds.x + bounds.width : Number.POSITIVE_INFINITY;
					}).toBeLessThanOrEqual(width);
					const bounds = (await composer.boundingBox())!;
					expect(bounds.width).toBeGreaterThan(200);
					expect(bounds.height).toBeGreaterThan(30);
					expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
					await expect(page.locator('.ash-projects-materials .ash-projects-goals')).toContainText(chinese ? '项目目标' : 'Project goals');
					await expect(composer.locator('.embedded-composer')).toHaveCSS('padding', '0px');
					await expect(composer.locator('.ash-sessions-cowork-welcome-heading')).toBeHidden();
					await page.screenshot({ path: info.outputPath(`project-composer-${locale}-${theme}-${width}.png`) });
				}
			}
		});

		test(`keeps project dialog sizing and content insets independent of stylesheet order (${locale})`, async () => {
			const { page, info } = browser;
			await page.goto(`/sessions.html?search&locale=${locale}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.locator('[data-action-id="sessions.open.projects"] > .ash-sessions-activity-item').click();
			const create = page.locator('.ash-projects').getByRole('button', { name: locale === 'zh-CN' ? '新建项目' : 'New project', exact: true });
			await create.press('Enter');
			const dialog = page.getByRole('dialog');
			// Loading the base widget last must not replace the host's geometry.
			const lateBaseStyles = await page.addStyleTag({ path: 'src/ash/base/browser/ui/dialog/dialog.css' });
			for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
				await page.evaluate(theme => window.ashSessionsIntegration.setTheme(theme), theme);
				for (const { width, height } of [{ width: 1280, height: 720 }, { width: 500, height: 360 }]) {
					await page.setViewportSize({ width, height });
					await expect(dialog).toHaveCSS('width', `${Math.min(520, width - 40)}px`);
					await expect(dialog).toHaveCSS('height', `${Math.min(360, height - 40)}px`);
					await expect(dialog).toHaveCSS('padding', '12px');
					await expect(dialog).toHaveCSS('border-radius', '12px');
					await expect(dialog.locator('.ash-dialog-header')).toHaveCSS('gap', '8px');
					await expect(dialog.locator('.ash-dialog-header')).toHaveCSS('height', '28px');
					await expect(dialog.locator('.ash-dialog-close')).toHaveCSS('width', '28px');
					await expect(dialog.locator('.ash-dialog-close')).toHaveCSS('height', '28px');
					await expect(dialog.locator('.ash-dialog-body')).toHaveCSS('padding', '0px');
					const bounds = (await dialog.boundingBox())!;
					expect(bounds.x).toBeGreaterThanOrEqual(20);
					expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 20);
					expect(bounds.y).toBeGreaterThanOrEqual(20);
					expect(bounds.y + bounds.height).toBeLessThanOrEqual(height - 20);
					if (height >= 400) {
						expect(await dialog.evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
					}
					if (theme === 'ash-light') await page.screenshot({ path: info.outputPath(`project-dialog-${locale}-${width}.png`) });
				}
			}
			await lateBaseStyles.evaluate(element => element.parentNode?.removeChild(element));
			await page.keyboard.press('Escape');
			await expect(dialog).toHaveCount(0);
			await expect(create).toBeFocused();
		});

		test(`renames from the breadcrumb with selection, cancellation and failure recovery (${locale})`, async () => {
			const { page, info } = browser;
			const chinese = locale === 'zh-CN';
			await page.goto(`/sessions.html?search&locale=${locale}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.locator('[data-action-id="sessions.open.projects"] > .ash-sessions-activity-item').click();
			await page.locator('.ash-projects-card').click();
			const breadcrumb = page.locator('.ash-projects-breadcrumb');
			const rename = breadcrumb.getByRole('button', {
				name: chinese ? '重命名项目 Search project fixture' : 'Rename project Search project fixture',
				exact: true,
			});
			const input = breadcrumb.getByRole('textbox', { name: chinese ? '项目名称' : 'Project name', exact: true });
			await expect(rename).toHaveAttribute('aria-current', 'page');
			await rename.click();
			await expect(input).toBeFocused();
			expect(
				await input.evaluate(element => ({
					start: (element as HTMLInputElement).selectionStart,
					end: (element as HTMLInputElement).selectionEnd,
				})),
			).toEqual({ start: 0, end: 'Search project fixture'.length });
			await input.fill('Discard this draft');
			await input.press('Escape');
			await expect(input).toHaveCount(0);
			await expect(rename).toBeFocused();
			await rename.press('Space');
			await input.fill('   ');
			await input.press('Enter');
			await expect(rename).toBeFocused();
			await expect(rename).toHaveText('Search project fixture');
			await expect(page.locator('.ash-projects').getByRole('heading', { level: 1 })).toHaveCount(0);
			await rename.press('Enter');
			await input.fill('Retain this draft');
			await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
			await expect(input).toHaveValue('Retain this draft');
			await expect(page.locator('.ash-projects-feedback')).toBeHidden();
			await input.press('Enter');
			await expect(page.locator('.ash-projects-feedback')).toBeVisible();
			await expect(input).toHaveValue('Retain this draft');
			await expect(input).toBeEditable();
			await expect(input).toBeFocused();
			await input.press('Escape');
			await expect(rename).toBeFocused();
			for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
				await page.evaluate(theme => window.ashSessionsIntegration.setTheme(theme), theme);
				await rename.press('Enter');
				await expect(input).toHaveCSS('border-radius', '6px');
				await expect(input).toHaveCSS('-webkit-app-region', 'no-drag');
				await expect(input).toHaveCSS('outline-style', 'solid');
				await page.screenshot({ path: info.outputPath(`projects-rename-${locale}-${theme}.png`) });
				await input.press('Escape');
			}
			await rename.press('Alt+F1');
			await expect(page.locator('.ash-accessible-view-content')).toHaveValue(
				chinese
					? /激活面包屑中的项目名称可原地重命名/
					: /Activate the project name in the breadcrumb to rename it in place/,
			);
			await page.keyboard.press('Escape');
			await expect(rename).toBeFocused();
		});

		test(`shows localized update times and refreshes them without replacing focused cards (${locale})`, async () => {
			const { page, info } = browser;
			const chinese = locale === 'zh-CN';
			const updatedAt = new Date('2026-10-25T18:00:00Z');
			const createdAt = updatedAt.getTime() - 5 * 86_400_000;
			await page.clock.install({ time: updatedAt });
			await page.goto(
				`/sessions.html?search&locale=${locale}&projectUpdatedAt=${updatedAt.getTime()}&projectCreatedAt=${createdAt}`,
			);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.locator('[data-action-id="sessions.open.projects"] > .ash-sessions-activity-item').click();
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
			await page.locator('[data-action-id="sessions.open.projects"] > .ash-sessions-activity-item').click();
			await expect(caption).toHaveAttribute('datetime', new Date(createdAt).toISOString());
			await expect(caption).toHaveText(chinese ? '8天前' : '8 days ago');
			await page.goto(`/sessions.html?search&locale=${locale}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.locator('[data-action-id="sessions.open.projects"] > .ash-sessions-activity-item').click();
			await expect(card).toBeVisible();
			await expect(caption).toHaveCount(0);
		});

		test(`reveals Pin with More Actions and keeps the pinned glyph visible at rest (${locale})`, async () => {
			const { page, info } = browser;
			const chinese = locale === 'zh-CN';
			await page.goto(`/sessions.html?search&locale=${locale}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.locator('[data-action-id="sessions.open.projects"] > .ash-sessions-activity-item').click();
			const row = page.locator('.ash-projects-row');
			const card = row.locator('.ash-projects-card');
			const heading = page.locator('.ash-projects h1');
			const pin = row.getByRole('button', { name: chinese ? '置顶' : 'Pin', exact: true });
			const unpin = row.getByRole('button', { name: chinese ? '取消置顶' : 'Unpin', exact: true });
			const pinAction = row.locator('[data-action-id="projects.pin"]');
			const moreAction = row.locator('.ash-toolbar-more-actions');
			await expect(row.getByRole('toolbar')).toHaveAccessibleName(
				chinese ? 'Search project fixture 的项目操作' : 'Actions for Search project fixture',
			);
			await heading.click();
			for (const action of [pinAction, moreAction]) {
				await expect(action).toHaveCSS('opacity', '0');
				await expect(action).toHaveCSS('pointer-events', 'none');
			}
			await card.hover();
			for (const action of [pinAction, moreAction]) {
				await expect(action).toHaveCSS('opacity', '1');
				await expect(action).toHaveCSS('pointer-events', 'auto');
			}
			await page.mouse.move(0, 0);
			await expect(pinAction).toHaveCSS('opacity', '0');
			await card.focus();
			await expect(pinAction).toHaveCSS('opacity', '1');
			await expect(moreAction).toHaveCSS('opacity', '1');
			await page.keyboard.press('Tab');
			await expect(moreAction.getByRole('button')).toBeFocused();
			await page.keyboard.press('ArrowRight');
			await expect(pin).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(unpin).toHaveAttribute('aria-pressed', 'true');
			for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
				await page.evaluate(theme => window.ashSessionsIntegration.setTheme(theme), theme);
				await heading.click();
				await expect(pinAction).toHaveCSS('opacity', '1');
				await expect(pinAction).toHaveCSS('pointer-events', 'auto');
				await expect(moreAction).toHaveCSS('opacity', '0');
				const bounds = (await unpin.boundingBox())!;
				await expect(unpin.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'pin-filled');
				await expect(unpin.locator('.ash-icon')).toHaveCSS('width', '18px');
				await unpin.hover();
				await expect(unpin.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'unpin');
				await expect(page.getByRole('tooltip')).toHaveText(chinese ? '取消置顶' : 'Unpin');
				expect(await unpin.boundingBox()).toEqual(bounds);
				await page.screenshot({ path: info.outputPath(`projects-unpin-${locale}-${theme}.png`) });
				await page.mouse.move(0, 0);
				await expect(unpin.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'pin-filled');
				await card.focus();
				await page.keyboard.press('Tab');
				await expect(unpin).toBeFocused();
				await expect(unpin.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'unpin');
				expect(await unpin.boundingBox()).toEqual(bounds);
			}
			await unpin.press('Enter');
			await expect(pin).toHaveAttribute('aria-pressed', 'false');
			await expect(pin.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'pinned');
			await heading.click();
			await expect(pinAction).toHaveCSS('opacity', '0');
			await expect(row.locator('.ash-projects-card-name')).toHaveText('Search project fixture');
		});

		test(`uses the Sessions menu geometry without changing shared menu defaults (${locale})`, async () => {
			const { page, info } = browser;
			await page.goto(`/sessions.html?search&locale=${locale}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.locator('[data-action-id="sessions.open.projects"] > .ash-sessions-activity-item').click();
			const sort = page.getByRole('button', {
				name: locale === 'zh-CN' ? '项目排序' : 'Sort projects',
				exact: true,
			});
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
				const check = selected.locator('.ash-menu-trailing-check > .ash-icon');
				await expect(check).toHaveClass(/ash-icon-check/);
				await expect(check).toHaveCSS('font-size', '18px');
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
						await expect(outside.getByRole('menu', { includeHidden: true })).toHaveCSS('padding', '4px');
						await expect(outside.getByRole('menu', { includeHidden: true })).toHaveCSS('min-width', '180px');
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
			await page.locator('[data-action-id="sessions.open.projects"] > .ash-sessions-activity-item').click();
			const projects = page.locator('.ash-projects');
			const search = projects.getByRole('button', {
				name: chinese ? '搜索项目' : 'Search projects',
				exact: true,
			});
			const close = projects.getByRole('button', {
				name: chinese ? '关闭项目搜索' : 'Close project search',
				exact: true,
			});
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
			await expect(page.locator('.ash-accessible-view-content')).toHaveValue(
				chinese ? /空搜索框失去焦点后会收起/ : /An empty search collapses when focus leaves it/,
			);
			await expect(input).toBeHidden();
			await page.keyboard.press('Escape');
			await expect(search).toBeFocused();
		});

		test(`keeps one Tab stop, navigates actions and restores popup focus (${locale})`, async () => {
			const { page } = browser;
			const chinese = locale === 'zh-CN';
			await page.goto(`/sessions.html?search&locale=${locale}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.locator('[data-action-id="sessions.open.projects"] > .ash-sessions-activity-item').click();
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
			await expect(
				dialog.getByRole('textbox', {
					name: chinese ? '你正在做什么？' : 'What are you working on?',
					exact: true,
				}),
			).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(dialog).toHaveCount(0);
			await expect(create).toBeFocused();
			await expect(toolbar.locator('button[tabindex="0"]')).toHaveCount(1);

			await create.press('Enter');
			await dialog
				.getByRole('textbox', { name: chinese ? '你正在做什么？' : 'What are you working on?', exact: true })
				.fill('Unavailable project save');
			const submit = dialog.getByRole('button', { name: chinese ? '创建' : 'Create', exact: true });
			await submit.click();
			await expect(dialog.locator('.ash-projects-form-error')).not.toBeEmpty();
			await expect(submit).toBeEnabled();
			await page.keyboard.press('Escape');
			await page.getByRole('button', { name: chinese ? '放弃更改' : 'Discard', exact: true }).click();
			await expect(dialog).toHaveCount(0);
			await expect(create).toBeFocused();
			expect(await sortNode!.evaluate(element => element.isConnected)).toBe(true);

			await page.keyboard.press('Home');
			await page.keyboard.press('Enter');
			const input = page.getByRole('searchbox', {
				name: chinese ? '搜索项目' : 'Search projects',
				exact: true,
				includeHidden: true,
			});
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
			await expect(
				toolbar.getByRole('button', { name: chinese ? '关闭项目搜索' : 'Close project search', exact: true }),
			).toBeFocused();
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
			await expect(page.locator('.ash-accessible-view-content')).toHaveValue(
				chinese
					? /使用左右方向键在搜索、排序和新建项目之间移动/
					: /Left and Right Arrow to move between Search, Sort and New project/,
			);
			await expect(page.locator('.ash-accessible-view-content')).toHaveValue(
				chinese
					? /悬停或键盘聚焦卡片可显示置顶和更多操作/
					: /Hover over or focus a card to show Pin and More Actions/,
			);
			await expect(page.locator('.ash-accessible-view-content')).toHaveValue(
				chinese
					? /使用侧栏或面包屑中的“项目”返回项目列表/
					: /Use Projects in the sidebar or the breadcrumb to return to the project list/,
			);
			await page.keyboard.press('Escape');
			await expect(sort).toBeFocused();

			const command = chinese ? '切换已归档项目视图' : 'Toggle Archived Projects';
			const palette = page.locator('.ash-quick-pick');
			for (const heading of chinese ? ['已归档', '项目'] : ['Archived', 'Projects']) {
				await page.keyboard.press('F1');
				await palette.getByRole('combobox').fill(`>${command}`);
				await palette.getByText(command, { exact: true }).click();
				await expect(page.locator('.ash-projects-heading').getByRole('heading', { name: heading, exact: true })).toBeFocused();
			}
		});

		test(`expands search beside the heading without moving the project list (${locale})`, async () => {
			const { page } = browser;
			const chinese = locale === 'zh-CN';
			await page.goto(`/sessions.html?search&locale=${locale}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.locator('[data-action-id="sessions.open.projects"] > .ash-sessions-activity-item').click();
			const projects = page.locator('.ash-projects');
			const search = projects.getByRole('button', {
				name: chinese ? '搜索项目' : 'Search projects',
				exact: true,
			});
			const close = projects.getByRole('button', {
				name: chinese ? '关闭项目搜索' : 'Close project search',
				exact: true,
			});
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
					await expect
						.poll(async () =>
							projects
								.locator('.ash-toolbar-search-action')
								.evaluate(element => element.getAnimations().length),
						)
						.toBe(0);
					const field = (await projects.locator('.ash-toolbar-search-field').boundingBox())!;
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
					expect((await input.boundingBox())!.width, `${theme} at ${width}px, search field ${field.width}px`).toBeGreaterThan(0);
					await input.fill('Search project');
					await expect(page.locator('.ash-projects-card-name')).toHaveText(['Search project fixture']);
					if (theme === 'ash-light') {
						await page.screenshot({
							path: browser.info.outputPath(`projects-inline-search-${locale}-${width}.png`),
						});
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
		await page.locator('[data-action-id="sessions.open.projects"] > .ash-sessions-activity-item').click();
		const projects = page.locator('.ash-projects');
		const search = projects.getByRole('button', { name: 'Search projects', exact: true });
		const close = projects.getByRole('button', { name: 'Close project search', exact: true });
		const input = projects.getByRole('searchbox', { includeHidden: true });
		const slot = projects.locator('.ash-toolbar-search-action');
		const collapsedWidth = (await slot.boundingBox())!.width;
		const sample = async (trigger: typeof search) =>
			trigger.evaluate(element => {
				(element as HTMLButtonElement).click();
				const slot = element.closest('.ash-toolbar-search-action')!;
				const animation = slot
					.getAnimations()
					.find(animation => animation instanceof CSSTransition && animation.transitionProperty === 'width');
				if (!animation) {
					throw new Error('Search width transition did not start');
				}
				const duration = Number(animation.effect!.getTiming().duration);
				animation.pause();
				animation.currentTime = duration / 2;
				return { duration, width: slot.getBoundingClientRect().width };
			});
		const opening = await sample(search);
		expect(opening.duration).toBe(120);
		expect(opening.width).toBeGreaterThan(collapsedWidth);
		expect(opening.width).toBeLessThan(260);
		await slot.evaluate(element =>
			element.getAnimations({ subtree: true }).forEach(animation => animation.finish()),
		);
		await expect(slot).toHaveCSS('width', '260px');
		await expect(input).toBeFocused();
		const closing = await sample(close);
		expect(closing.width).toBeGreaterThan(collapsedWidth);
		expect(closing.width).toBeLessThan(260);
		await expect(projects.locator('.ash-toolbar-search-field')).toHaveAttribute('inert', '');
		await expect(search).toBeFocused();
		await search.click();
		await slot.evaluate(element =>
			element.getAnimations({ subtree: true }).forEach(animation => animation.finish()),
		);
		await expect(input).toBeFocused();
		await expect(slot).toHaveCSS('width', '260px');
		await expect(projects.locator('.ash-toolbar-search-field')).not.toHaveAttribute('inert', '');
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
			const holdList = () =>
				page.evaluateHandle(() => {
					const projects = globalThis.ashWebWorkbenchHost!.api.projects;
					const original = projects.list;
					let finish!: () => void;
					const pending = new Promise<void>(resolve => {
						finish = resolve;
					});
					projects.list = async () => {
						await pending;
						return original.call(projects);
					};
					return {
						release: () => {
							projects.list = original;
							finish();
						},
					};
				});
			const projects = page.locator('.ash-projects');
			const body = projects.locator('.ash-projects-body');
			const skeleton = projects.locator('.ash-projects-skeleton');
			const firstLoad = await holdList();
			try {
				await page.locator('[data-action-id="sessions.open.projects"] > .ash-sessions-activity-item').click();
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
					const colors = await block.evaluate(element => ({
						fill: getComputedStyle(element).backgroundColor,
						canvas: getComputedStyle(element.closest('.ash-projects')!).backgroundColor,
						outline: getComputedStyle(element).outlineStyle,
					}));
					if (theme.includes('contrast')) {
						expect(colors.outline).toBe('solid');
					} else {
						expect(colors.fill).not.toBe(colors.canvas);
					}
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
				await expect(projects.getByRole('heading', { level: 1 })).toHaveCount(0);
				await expect(projects.getByRole('status')).toHaveText(chinese ? '正在加载项目…' : 'Loading projects…');
				const projectName = page.locator('.ash-sessions-titlebar .ash-project-titlebar-name');
				await expect(projectName).toHaveClass(/ash-projects-placeholder/);
				await expect(projectName).toHaveAttribute('aria-hidden', 'true');
				await expect(projectName).toHaveCSS('opacity', '1');
				await expect(projectName).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				for (const width of [1280, 720]) {
					await page.setViewportSize({ width, height: 720 });
					await page.emulateMedia({ reducedMotion: 'reduce' });
					const overview = (await skeleton.locator('.ash-projects-overview').boundingBox())!;
					const materials = (await skeleton.locator('.ash-projects-materials').boundingBox())!;
					if (width === 720) {
						expect(materials.y).toBeGreaterThanOrEqual(overview.y + overview.height);
					} else {
						expect(materials.y).toBe(overview.y);
					}
					expect(await skeleton.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
					expect(await skeleton.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
					await page.screenshot({ path: info.outputPath(`projects-detail-loading-${locale}-${width}.png`) });
				}
				await detailLoad.evaluate(gate => gate.release());
				await expect(projectName).toHaveText('Search project fixture');
				await expect(skeleton).toHaveCount(0);
				await expect(projectName).not.toHaveClass(/ash-projects-placeholder/);
			} finally {
				await detailLoad.evaluate(gate => gate.release());
				await detailLoad.dispose();
			}

			const refresh = await holdList();
			try {
				await page.evaluate(() => window.ashSessionsIntegration.refreshProject());
				await expect(body).toHaveAttribute('aria-busy', 'true');
				await expect(page.locator('.ash-sessions-titlebar .ash-project-titlebar-name')).toHaveText('Search project fixture');
				await expect(projects.locator('.ash-projects-description')).toHaveText(
					'Synthetic project for Search navigation',
				);
				await expect(skeleton).toHaveCount(0);
				await page
					.locator('.ash-projects-breadcrumb')
					.getByRole('button', { name: chinese ? '项目' : 'Projects', exact: true })
					.click();
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
