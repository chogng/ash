import { expect } from '@playwright/test';
import { suite, setup, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('Sessions list toolbar', () => {
	const browser = useBrowserTests();

	for (const locale of ['en', 'zh-CN']) {
		const chinese = locale === 'zh-CN';
		const projectsName = chinese ? '项目' : 'Projects';
		const moreName = chinese ? '更多会话操作' : 'More Sessions Actions';
		const createName = chinese ? '创建项目' : 'Create project';

		for (const mode of ['chat', 'code']) {
			suite(`${mode} (${locale})`, () => {
				setup(async () => {
					const { page } = browser;
					await page.goto(`/sessions.html?catalog&search&locale=${locale}`);
					await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
					if (chinese) await page.evaluate(() => window.ashSessionsIntegration.setTheme('ash-high-contrast-dark'));
					if (mode === 'code') {
						await page.locator('.ash-window-mode-control').getByRole('button', { name: chinese ? '代码' : 'Code', exact: true }).click();
					}
				});

				test('keeps actions in the sidebar title after collapsing Projects', async () => {
					const { page } = browser;
					const list = page.locator(`.ash-sessions-list[data-mode="${mode}"]:visible`);
					const projects = list.locator('[data-section="projects"]');
					const heading = projects.getByRole('heading', { level: 3, name: projectsName, exact: true });
					const toggle = projects.getByRole('button', { name: projectsName, exact: true });
					const projectRow = list.locator('[data-project-id="search-project"]');
					const title = page.locator('[data-part="sidebar"] .ash-pane-composite-title');
					const titleLabel = title.locator('.ash-sidebar-title-label');
					const toolbar = title.getByRole('toolbar', { name: chinese ? '会话列表操作' : 'Sessions List Actions', exact: true });
					const more = toolbar.getByRole('button', { name: moreName, exact: true });
					const create = toolbar.getByRole('button', { name: createName, exact: true });

					await expect(titleLabel).toHaveText(mode === 'code' ? (chinese ? '代码' : 'Code') : (chinese ? '聊天' : 'Chat'));
					await expect(list.getByRole('heading', { level: 2 })).toHaveCount(0);
					await expect(heading).toBeVisible();
					await expect(projects.getByRole('toolbar')).toHaveCount(0);
					await expect(toolbar.getByRole('button')).toHaveCount(2);
					await expect(create.locator('[data-ash-icon-id="add"]')).toBeVisible();
					await expect(toolbar.locator('[data-ash-icon-id="list-filter"]')).toBeVisible();
					await expect(more.locator('.ash-dropdown-menu-indicator')).toBeHidden();
					await toggle.press('ArrowLeft');
					await expect(toggle).toHaveAttribute('aria-expanded', 'false');
					await expect(projectRow).toHaveCount(0);
					const titleBounds = (await titleLabel.boundingBox())!;
					const actionBounds = (await more.boundingBox())!;
					expect(actionBounds.width).toBe(24);
					expect(actionBounds.height).toBe(24);
					expect(titleBounds.x + titleBounds.width).toBeLessThan(actionBounds.x);
					expect(titleBounds.y + titleBounds.height / 2).toBeCloseTo(actionBounds.y + actionBounds.height / 2, 0);
					await more.hover();
					await expect(more).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
					await expect(more).toHaveCSS('border-width', '0px');
				});

				test('keeps title actions available when search finds no project', async () => {
					const { page } = browser;
					const list = page.locator(`.ash-sessions-list[data-mode="${mode}"]:visible`);
					const projects = list.locator('[data-section="projects"]');
					const heading = projects.getByRole('heading', { level: 3, name: projectsName, exact: true });
					const toggle = projects.getByRole('button', { name: projectsName, exact: true });
					const projectRow = list.locator('[data-project-id="search-project"]');
					const title = page.locator('[data-part="sidebar"] .ash-pane-composite-title');
					const toolbar = title.getByRole('toolbar', { name: chinese ? '会话列表操作' : 'Sessions List Actions', exact: true });
					const more = toolbar.getByRole('button', { name: moreName, exact: true });
					const create = toolbar.getByRole('button', { name: createName, exact: true });

					await expect(projectRow).toBeVisible();
					await create.focus();
					await create.press('ControlOrMeta+f');
					const search = list.getByRole('searchbox');
					await search.fill('No matching project');
					await expect(projectRow).toHaveCount(0);
					await expect(heading).toBeVisible();
					await expect(toggle).toHaveCount(0);
					await expect(more).toBeVisible();
					await search.press('Escape');
					await expect(create).toBeFocused();
				});

				test('navigates the grouping menu and returns focus to its button', async () => {
					const { page } = browser;
					const list = page.locator(`.ash-sessions-list[data-mode="${mode}"]:visible`);
					const projects = list.locator('[data-section="projects"]');
					const toggle = projects.getByRole('button', { name: projectsName, exact: true });
					const title = page.locator('[data-part="sidebar"] .ash-pane-composite-title');
					const toolbar = title.getByRole('toolbar', { name: chinese ? '会话列表操作' : 'Sessions List Actions', exact: true });
					const more = toolbar.getByRole('button', { name: moreName, exact: true });
					const create = toolbar.getByRole('button', { name: createName, exact: true });

					await toggle.press('ArrowLeft');
					await create.focus();
					await page.keyboard.press('ArrowRight');
					await expect(more).toBeFocused();
					await expect(more).toHaveCSS('outline-style', 'solid');
					await page.keyboard.press('Enter');
					await expect(more).toHaveAttribute('aria-expanded', 'true');
					await expect(toolbar).toHaveCSS('opacity', '1');
					const filterMenu = page.locator('.ash-sessions-list-menu');
					const groupName = chinese ? '分组方式 项目' : 'Group By Projects';
					const sortName = chinese ? '排序方式 最近更新' : 'Sort By Last Updated';
					const showName = chinese ? '显示' : 'Show';
					const menuItems = filterMenu.getByRole('menuitem');
					const names = [groupName, sortName, showName];
					await expect(menuItems).toHaveCount(names.length);
					for (const [index, name] of names.entries()) await expect(menuItems.nth(index)).toHaveAccessibleName(name);
					await expect(filterMenu.getByRole('menuitem', { name: chinese ? '在侧栏中搜索会话' : 'Search sessions in the sidebar', exact: true })).toHaveCount(0);
					const group = filterMenu.getByRole('menuitem', { name: groupName, exact: true });
					const sort = filterMenu.getByRole('menuitem', { name: sortName, exact: true });
					const groupValue = (await group.locator('.ash-icon-label-description').boundingBox())!;
					const sortValue = (await sort.locator('.ash-icon-label-description').boundingBox())!;
					const arrow = (await group.locator('.ash-submenu-indicator').boundingBox())!;
					expect(groupValue.x + groupValue.width).toBeCloseTo(sortValue.x + sortValue.width);
					expect(groupValue.x + groupValue.width).toBeLessThan(arrow.x);
					await expect(group).toBeFocused();
					await group.press('ArrowRight');
					await expect(page.getByRole('menuitemradio', { name: chinese ? '状态' : 'Status', exact: true })).toBeVisible();
					await expect(page.getByRole('menuitemradio', { name: chinese ? '平铺' : 'Flat List', exact: true })).toBeVisible();
					const selected = page.getByRole('menuitemradio', { name: chinese ? '项目' : 'Projects', exact: true, checked: true });
					await expect(selected).toBeVisible();
					const label = (await selected.locator('.ash-button-label').boundingBox())!;
					const check = (await selected.locator('.ash-menu-trailing-slot [data-ash-icon-id="check"]').boundingBox())!;
					const inset = await selected.evaluate(row => parseFloat(getComputedStyle(row).paddingInlineStart));
					expect(label.x - (await selected.boundingBox())!.x).toBeCloseTo(inset);
					expect(check.x).toBeGreaterThan(label.x + label.width);
					await page.keyboard.press('ArrowLeft');
					await expect(group).toBeFocused();
					await page.keyboard.press('Escape');
					await expect(more).toHaveAttribute('aria-expanded', 'false');
					await expect(more).toBeFocused();
					await expect(toggle).toHaveAttribute('aria-expanded', 'false');
				});
			});
		}
	}
});
