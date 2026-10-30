import { expect } from '@playwright/test';
import { suite, test, setup, teardown } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('Customize page', () => {
	const browser = useBrowserTests();
	setup(async () => {
		await browser.page.goto('/sessions.html?customize');
		await expect(browser.page.locator('body')).toHaveAttribute('data-ready', 'true');
		await browser.page
			.locator('.ash-sessions-activity-content')
			.getByRole('button', { name: 'Customize', exact: true })
			.click();
		await expect(browser.page.locator('.ash-customize-card')).toHaveCount(3);
	});
	teardown(async () => {
		expect(await browser.page.evaluate(() => window.ashSessionsIntegration.errors)).toEqual([]);
	});

	test('opens the retained catalog, filters and sorts real skill projections, and keeps navigation available', async () => {
		const { page } = browser;
		const entry = page
			.locator('.ash-sessions-activity-content')
			.getByRole('button', { name: 'Customize', exact: true });
		await expect(entry).toHaveAttribute('aria-current', 'page');
		await expect(entry.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'briefcase');
		const root = page.locator('.ash-customize');
		await expect(root.getByRole('tab')).toHaveText(['Skills', 'Connectors', 'Plugins']);
		await expect(root.locator('.ash-customize-card-name')).toHaveText([
			'code-review',
			'research-notes',
			'writing-guide',
		]);
		const search = root.getByRole('button', { name: 'Search', exact: true });
		await expect(root.getByRole('searchbox')).toBeHidden();
		await search.click();
		await expect(root.getByRole('searchbox')).toBeFocused();
		await root.getByRole('searchbox', { name: 'Search', exact: true }).fill('writing');
		await expect(root.locator('.ash-customize-card-name')).toHaveText(['writing-guide']);
		await root.getByRole('searchbox').press('Escape');
		await expect(root.getByRole('searchbox')).toBeHidden();
		await expect(search).toBeFocused();
		await expect(root.locator('.ash-customize-card')).toHaveCount(3);
		await root.getByRole('button', { name: 'Sort resources' }).click();
		await page.getByRole('menuitemcheckbox', { name: 'Name: Z to A' }).click();
		await expect(root.locator('.ash-customize-card-name')).toHaveText([
			'writing-guide',
			'research-notes',
			'code-review',
		]);
		await expect(root.getByRole('button', { name: 'Sort resources' })).toBeFocused();
		await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
		await expect(root).toBeVisible();
		await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
		await expect(entry).toBeVisible();
	});

	test('opens embedded skill details and restores the filtered, sorted and scrolled catalog with keyboard focus', async () => {
		const { page } = browser;
		await page.setViewportSize({ width: 760, height: 500 });
		const root = page.locator('.ash-customize');
		const catalog = root.locator('.ash-customize-catalog');
		await root.getByRole('button', { name: 'Search', exact: true }).click();
		await root.getByRole('searchbox').fill('instructions');
		await root.getByRole('button', { name: 'Sort resources' }).click();
		await page.getByRole('menuitemcheckbox', { name: 'Name: Z to A' }).click();
		await expect(root.locator('.ash-customize-card-name')).toHaveText([
			'writing-guide',
			'research-notes',
			'code-review',
		]);
		const open = root.getByRole('button', { name: 'View code-review', exact: true });
		await open.scrollIntoViewIfNeeded();
		await open.focus();
		const scrollTop = await catalog.evaluate(element => element.scrollTop);
		expect(scrollTop).toBeGreaterThan(0);
		await open.press('Enter');
		const detail = root.locator('.ash-extension-editor.page');
		await expect(detail.getByRole('heading', { name: 'code-review', exact: true })).toBeVisible();
		await expect(detail.getByRole('tab')).toHaveText(['Details', 'Instructions', 'Diagnostics']);
		await expect(catalog).toBeHidden();
		const back = root.getByRole('button', { name: 'Back to Skills', exact: true });
		await expect(back).toBeFocused();
		await expect(
			page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Customize', exact: true }),
		).toHaveAttribute('aria-current', 'page');
		await detail.getByRole('tab', { name: 'Details', exact: true }).focus();
		await page.keyboard.press('End');
		await expect(detail.getByRole('tab', { name: 'Diagnostics', exact: true })).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(detail.getByRole('tabpanel', { name: 'Diagnostics', exact: true })).toContainText(
			'No skill diagnostics.',
		);
		await page.keyboard.press('Alt+F1');
		await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Back button above the details/);
		await page.keyboard.press('Escape');
		await back.click();
		await expect(detail).toHaveCount(0);
		await expect(open).toBeFocused();
		await expect(root.getByRole('searchbox')).toHaveValue('instructions');
		await expect(root.locator('.ash-customize-card-name')).toHaveText([
			'writing-guide',
			'research-notes',
			'code-review',
		]);
		expect(await catalog.evaluate(element => element.scrollTop)).toBe(scrollTop);
		await open.press('Enter');
		await expect(root.locator('.ash-extension-editor')).toHaveCount(1);
		await expect(detail.getByRole('tab', { name: 'Details', exact: true })).toHaveAttribute(
			'aria-selected',
			'true',
		);
		await back.press('Enter');
		await expect(root.locator('.ash-extension-editor-scrollable')).toHaveCount(0);
	});

	test('returns from a pending detail read and ignores its late result after opening another skill', async () => {
		const { page } = browser;
		await page.evaluate(() => window.ashSessionsIntegration.setCustomizeDetailsRead('hold'));
		const root = page.locator('.ash-customize');
		await root.getByRole('button', { name: 'writing-guide', exact: true }).click();
		await expect(root.locator('.ash-extension-editor')).toContainText('Loading Extensions');
		await root.getByRole('button', { name: 'Back to Skills', exact: true }).click();
		await root.getByRole('button', { name: 'research-notes', exact: true }).click();
		await expect(root.locator('.ash-extension-editor')).toContainText('Reusable research instructions.');
		await page.evaluate(() => window.ashSessionsIntegration.completeCustomizeDetails());
		await expect(root.locator('.ash-extension-editor')).toHaveCount(1);
		await expect(
			root.locator('.ash-extension-editor').getByRole('heading', { name: 'research-notes', exact: true }),
		).toBeVisible();
		await expect(root.locator('.ash-extension-editor')).not.toContainText('Reusable writing instructions.');
	});

	test('failed detail reads return to the resource card with a visible error', async () => {
		const { page } = browser;
		await page.evaluate(() => window.ashSessionsIntegration.setCustomizeDetailsRead('fail'));
		const root = page.locator('.ash-customize');
		const skill = root.getByRole('button', { name: 'writing-guide', exact: true });
		await skill.click();
		await expect(root.getByRole('status')).toContainText('Synthetic detail failure');
		await expect(root.locator('.ash-customize-catalog')).toBeVisible();
		await expect(skill).toBeFocused();
		await expect(root.locator('.ash-extension-editor')).toHaveCount(0);
		await skill.press('Enter');
		await expect(root.locator('.ash-extension-editor')).toContainText('Reusable writing instructions.');
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`renders page details with responsive layout and localized return navigation in ${locale}`, async () => {
			const { page } = browser;
			const chinese = locale === 'zh-CN';
			if (chinese) {
				await page.goto('/sessions.html?customize&locale=zh-CN');
				await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
				await page
					.locator('.ash-sessions-activity-content')
					.getByRole('button', { name: '自定义', exact: true })
					.click();
			}
			const root = page.locator('.ash-customize');
			await root.getByRole('button', { name: 'writing-guide', exact: true }).click();
			const detail = root.locator('.ash-extension-editor.page');
			await expect(detail.getByRole('heading', { name: 'writing-guide', exact: true })).toHaveCSS(
				'font-size',
				'18px',
			);
			await expect(detail.locator('.extension-detail-icon')).toHaveCSS('width', '48px');
			await expect(detail.getByRole('tab')).toHaveText(
				chinese ? ['详情', '说明', '诊断'] : ['Details', 'Instructions', 'Diagnostics'],
			);
			await expect(detail.getByRole('tab').first()).toHaveCSS('font-weight', '400');
			await expect(detail.getByRole('tab').first()).toHaveCSS('padding-left', '12px');
			await expect(detail.getByRole('tab').first().locator('..')).toHaveCSS('height', '40px');
			await expect(detail.getByRole('tab').first().locator('..')).toHaveCSS(
				'background-color',
				'rgba(0, 0, 0, 0)',
			);
			await expect(detail.getByRole('tab').first().locator('..')).not.toHaveCSS(
				'border-bottom-color',
				'rgba(0, 0, 0, 0)',
			);
			const back = root.getByRole('button', { name: chinese ? '返回技能' : 'Back to Skills', exact: true });
			await expect(back).toBeVisible();
			for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
				await page.evaluate(theme => window.ashSessionsIntegration.setTheme(theme), theme);
				await expect(detail.locator('.extension-detail-info')).not.toHaveCSS(
					'background-color',
					'rgba(0, 0, 0, 0)',
				);
				if (theme.includes('high-contrast')) {
					await expect(detail.locator('.extension-detail-info')).not.toHaveCSS(
						'border-top-color',
						'rgba(0, 0, 0, 0)',
					);
				}
			}
			await page.evaluate(() => window.ashSessionsIntegration.setTheme('ash-light'));
			await page.screenshot({ path: browser.info.outputPath(`customize-detail-${locale}.png`) });
			await page.setViewportSize({ width: 760, height: 900 });
			await expect(detail).toHaveClass(/compact/);
			const content = (await detail.locator('.extension-detail-content').boundingBox())!;
			const info = (await detail.locator('.extension-detail-info').boundingBox())!;
			expect(info.y).toBeGreaterThanOrEqual(content.y + content.height);
			expect(await root.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
			await page.screenshot({ path: browser.info.outputPath(`customize-detail-narrow-${locale}.png`) });
			await back.click();
			await expect(root.getByRole('button', { name: 'writing-guide', exact: true })).toBeFocused();
		});
	}

	test('keeps short and long skill descriptions at two lines without redundant metadata', async () => {
		const { page } = browser;
		const root = page.locator('.ash-customize');
		await expect(root.locator('.ash-customize-card-metadata')).toHaveCount(0);
		const description = root.locator('.ash-customize-card-description').first();
		await description.hover();
		await expect(page.getByRole('tooltip')).toHaveText((await description.textContent())!);
		await page.keyboard.press('Escape');
		for (const width of [1280, 760]) {
			await page.setViewportSize({ width, height: 900 });
			await expect(root).toHaveClass(width === 760 ? /narrow/ : /^(?!.*narrow)/);
			const dimensions = await root.locator('.ash-customize-card').evaluateAll(cards =>
				cards.map(card => {
					const description = card.querySelector<HTMLElement>('.ash-customize-card-description')!;
					return {
						height: card.getBoundingClientRect().height,
						descriptionHeight: description.getBoundingClientRect().height,
						lineHeight: Number.parseFloat(getComputedStyle(description).lineHeight),
						truncated: description.scrollHeight > description.clientHeight,
					};
				}),
			);
			for (const dimension of dimensions) {
				expect(dimension.height).toBeCloseTo(dimensions[0].height, 1);
				expect(dimension.descriptionHeight).toBeCloseTo(2 * dimension.lineHeight, 1);
			}
			expect(dimensions[0].truncated).toBe(true);
			expect(dimensions[1].truncated).toBe(false);
			expect(dimensions[2].truncated).toBe(false);
			await page.screenshot({ path: browser.info.outputPath(`customize-cards-${width}.png`) });
		}
	});

	test('keeps search editing and focus in the shared toolbar slot', async () => {
		const { page } = browser;
		const root = page.locator('.ash-customize');
		const search = root.getByRole('button', { name: 'Search', exact: true });
		const input = root.getByRole('searchbox', { includeHidden: true });
		await search.click();
		await input.fill('writing');
		await input.press('Home');
		await input.press('ArrowRight');
		await expect(input).toBeFocused();
		await input.press('Backspace');
		await expect(input).toHaveValue('riting');
		await root.getByRole('button', { name: 'Sort resources' }).focus();
		await expect(input).toBeVisible();
		await page.keyboard.press('ArrowLeft');
		await expect(input).toBeFocused();
		await root.getByRole('button', { name: 'Close search', exact: true }).click();
		await expect(input).toHaveValue('');
		await expect(input).toBeHidden();
		await expect(search).toBeFocused();
		await expect(root.locator('.ash-customize-card')).toHaveCount(3);
		await search.click();
		await input.press('ArrowDown');
		await expect(root.getByRole('button', { name: 'code-review', exact: true })).toBeFocused();
		await expect(input).toBeHidden();
		await expect(root.locator('.ash-toolbar-search-field')).toHaveAttribute('inert', '');
		await search.click();
		await input.press('Alt+F1');
		await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Activate Search to expand its input/);
		await expect(input).toBeHidden();
		await page.keyboard.press('Escape');
		await expect(search).toBeFocused();
	});

	test('switches categories and discovery, handles source failures, and opens package details', async () => {
		const { page } = browser;
		const root = page.locator('.ash-customize');
		await root.getByRole('tab', { name: 'Connectors', exact: true }).click();
		await expect(root.locator('.ash-customize-card-name')).toHaveText(['Team library']);
		await root.getByRole('tab', { name: 'Plugins', exact: true }).click();
		await expect(root.locator('.ash-customize-card-name')).toHaveText(['Local productivity']);
		await root.getByRole('tab', { name: 'Skills', exact: true }).click();
		await root.getByRole('button', { name: 'Discover', exact: true }).click();
		await expect(root.locator('.ash-customize-card')).toHaveCount(4);
		await expect(root.locator('.ash-customize-card-metadata')).toHaveText(Array(4).fill('Ash fixtures · 1.0.0'));
		await expect(root.locator('.ash-customize-hero')).toBeVisible();
		await root.getByRole('button', { name: 'Search', exact: true }).click();
		await expect
			.poll(() =>
				root
					.locator('.ash-toolbar-search-action')
					.evaluate(element => element.getAnimations({ subtree: true }).length),
			)
			.toBe(0);
		const field = root.locator('.ash-toolbar-search-field');
		const icon = field.locator(':scope > span > .ash-icon');
		await expect(icon).toHaveAttribute('data-ash-icon-id', 'search');
		await expect(icon).toHaveAttribute('aria-hidden', 'true');
		const iconBounds = (await icon.boundingBox())!;
		const inputBounds = (await root.getByRole('searchbox').boundingBox())!;
		expect(inputBounds.x - iconBounds.x - iconBounds.width).toBeGreaterThanOrEqual(8);
		await expect(
			root.getByRole('button', { name: 'Filter sources' }).locator('.ash-icon-label-icon > .ash-icon'),
		).toHaveAttribute('data-ash-icon-id', 'list-filter');
		for (const control of [
			field,
			root.getByRole('tab', { name: 'Skills', exact: true }),
			root.getByRole('button', { name: 'Discover', exact: true }),
			root.getByRole('button', { name: 'Add', exact: true }),
		]) {
			await expect(control).toHaveCSS('border-radius', '8px');
		}
		for (const name of ['Filter sources', 'Sort resources', 'Add', 'Refresh', 'Install Data explorer']) {
			await root.getByRole('button', { name, exact: true }).hover();
			await expect(page.getByRole('tooltip')).toHaveText(name);
			await page.keyboard.press('Escape');
		}
		await page.screenshot({ path: browser.info.outputPath('customize-light.png') });
		await root.getByRole('button', { name: 'Filter sources' }).click();
		await expect(page.getByRole('menuitemcheckbox', { name: 'Ash fixtures' })).toBeVisible();
		await page.keyboard.press('Escape');
		await root.getByRole('button', { name: 'Search', exact: true }).click();
		await root.getByRole('searchbox').fill('error');
		await expect(root.getByRole('status')).toContainText('Synthetic catalog failure');
		await root.getByRole('searchbox').fill('data');
		await expect(root.locator('.ash-customize-card-name')).toHaveText(['Data explorer']);
		await root.getByRole('button', { name: 'Data explorer', exact: true }).click();
		await expect(page.locator('.ash-extension-editor')).toBeVisible();
		await expect(page.locator('.ash-extension-editor')).toContainText('Data explorer');
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`installs a skill with a success toast and a persistent green check in ${locale}`, async () => {
			const { page } = browser;
			const chinese = locale === 'zh-CN';
			if (chinese) {
				await page.goto('/sessions.html?customize&locale=zh-CN');
				await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
				await page
					.locator('.ash-sessions-activity-content')
					.getByRole('button', { name: '自定义', exact: true })
					.click();
			}
			const root = page.locator('.ash-customize');
			await root.getByRole('button', { name: chinese ? '发现' : 'Discover', exact: true }).click();
			const install = root.getByRole('button', {
				name: chinese ? '安装 Data explorer' : 'Install Data explorer',
				exact: true,
			});
			await expect(install.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'add');
			await install.focus();
			await install.press('Enter');
			const review = page.getByRole('dialog', { name: chinese ? '安装' : 'Install', exact: true });
			await expect(review).toBeVisible();
			await expect(root.locator('.ash-customize-card-open.installed')).toHaveCount(0);
			await expect(page.locator('.ash-notification')).toHaveCount(0);
			await review.getByRole('button', { name: chinese ? '安装' : 'Install', exact: true }).click();
			const installed = root.getByRole('button', {
				name: chinese ? '已安装：Data explorer。查看详情' : 'Installed: Data explorer. View details',
				exact: true,
			});
			await expect(installed.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'check');
			await expect(installed).toBeFocused();
			const toast = page.locator('.ash-notification');
			await expect(toast).toHaveCount(1);
			await expect(toast.locator('.ash-notification-message')).toHaveText(
				chinese ? 'Data explorer 已安装，可以使用。' : 'Data explorer is installed and ready to use.',
			);
			await page.evaluate(() => window.ashSessionsIntegration.setTheme('ash-light'));
			await expect(installed).toHaveCSS('color', 'rgb(16, 124, 16)');
			await expect(installed).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await page.screenshot({ path: browser.info.outputPath(`customize-skill-installed-${locale}.png`) });
			await toast.locator('.ash-notification-toolbar button').first().click();
			await expect(toast).toHaveCount(0);
			await root.getByRole('button', { name: chinese ? '刷新' : 'Refresh', exact: true }).click();
			await expect(installed).toBeVisible();
			await expect(install).toHaveCount(0);
			await expect(toast).toHaveCount(0);
			for (const theme of ['ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
				await page.evaluate(theme => window.ashSessionsIntegration.setTheme(theme), theme);
				await expect(installed.locator('.ash-icon')).toBeVisible();
				if (theme.includes('high-contrast')) {
					await expect(installed).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
					await expect(installed).toHaveCSS(
						'background-color',
						theme.endsWith('dark') ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)',
					);
				}
			}
			await installed.click();
			await expect(page.locator('.ash-extension-editor')).toContainText('Data explorer');
			await expect(toast).toHaveCount(0);
		});
	}

	test('cancelled and failed installations keep the install action without success feedback', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?customize&installFails');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page
			.locator('.ash-sessions-activity-content')
			.getByRole('button', { name: 'Customize', exact: true })
			.click();
		const root = page.locator('.ash-customize');
		await root.getByRole('button', { name: 'Discover', exact: true }).click();
		const install = root.getByRole('button', { name: 'Install Data explorer', exact: true });
		await install.click();
		const review = page.getByRole('dialog', { name: 'Install', exact: true });
		await expect(review).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(review).toBeHidden();
		await expect(install).toBeEnabled();
		await expect(page.locator('.ash-notification')).toHaveCount(0);
		await install.click();
		await review.getByRole('button', { name: 'Install', exact: true }).click();
		await expect(root.getByRole('status')).toContainText('Synthetic installation failure');
		await expect(install).toBeEnabled();
		await expect(install.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'add');
		await expect(root.locator('.ash-customize-card-open.installed')).toHaveCount(0);
		await expect(page.locator('.ash-notification')).toHaveCount(0);
	});

	test('supports keyboard categories, card navigation, narrow layouts and high contrast', async () => {
		const { page } = browser;
		const root = page.locator('.ash-customize');
		await root.getByRole('tab', { name: 'Skills', exact: true }).focus();
		await page.keyboard.press('ArrowRight');
		await expect(root.getByRole('tab', { name: 'Connectors', exact: true })).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(root.getByRole('tab', { name: 'Connectors', exact: true })).toHaveAttribute(
			'aria-selected',
			'true',
		);
		const actions = root.getByRole('toolbar', { name: 'Customization actions' });
		await actions.getByRole('button', { name: 'Sort resources' }).focus();
		await page.keyboard.press('ArrowRight');
		await expect(actions.getByRole('button', { name: 'Add', exact: true })).toBeFocused();
		await page.keyboard.press('ArrowLeft');
		await expect(actions.getByRole('button', { name: 'Sort resources' })).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(page.getByRole('menuitemcheckbox', { name: 'Name: A to Z' })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(actions.getByRole('button', { name: 'Sort resources' })).toBeFocused();
		await root.getByRole('tab', { name: 'Skills', exact: true }).click();
		await expect(root.locator('.ash-customize-card')).toHaveCount(3);
		await root.getByRole('button', { name: 'Search', exact: true }).click();
		await page.keyboard.press('ArrowDown');
		await expect(root.getByRole('button', { name: 'code-review', exact: true })).toBeFocused();
		await page.keyboard.press('End');
		await expect(root.getByRole('button', { name: 'writing-guide', exact: true })).toBeFocused();
		await page.setViewportSize({ width: 760, height: 900 });
		await expect(root).toHaveClass(/narrow/);
		expect(await root.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
		const cards = root.locator('.ash-customize-card');
		expect((await cards.nth(0).boundingBox())!.x).toBe((await cards.nth(1).boundingBox())!.x);
		await page.evaluate(() => window.ashSessionsIntegration.setTheme('ash-high-contrast-dark'));
		await expect(cards.first()).toHaveCSS('box-shadow', 'none');
		await expect(cards.first()).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
	});

	test('renders the Chinese navigation and catalog controls', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?customize&locale=zh-CN');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page
			.locator('.ash-sessions-activity-content')
			.getByRole('button', { name: '自定义', exact: true })
			.click();
		const root = page.locator('.ash-customize');
		await expect(root.getByRole('heading', { name: '自定义', exact: true })).toBeVisible();
		await expect(root.getByRole('tab')).toHaveText(['技能', '连接器', '插件']);
		await expect(root.getByRole('button', { name: '你的', exact: true })).toHaveAttribute('aria-pressed', 'true');
		await root.getByRole('button', { name: '发现', exact: true }).click();
		await expect(root.locator('.ash-customize-hero')).toContainText('让 Ash 学会新的工作方法');
		await expect(root.getByRole('status')).toContainText('4 个资源');
		await root.getByRole('button', { name: '搜索', exact: true }).click();
		await expect(root.getByRole('searchbox', { name: '搜索', exact: true })).toBeFocused();
		await expect(root.getByRole('button', { name: '关闭搜索', exact: true })).toBeVisible();
		await root.getByRole('searchbox').press('Escape');
		await expect(root.getByRole('button', { name: '搜索', exact: true })).toBeFocused();
		for (const name of ['筛选来源', '资源排序', '添加', '刷新']) {
			await root.getByRole('button', { name, exact: true }).hover();
			await expect(page.getByRole('tooltip')).toHaveText(name);
			await page.keyboard.press('Escape');
		}
		await page.screenshot({ path: browser.info.outputPath('customize-zh-cn.png') });
		const add = root.getByRole('button', { name: '添加', exact: true });
		await add.click();
		const menu = page.locator('.ash-customize-add-menu');
		await expect(menu.getByRole('menuitem')).toHaveText(['上传技能', '创建技能', '用 Ash 创建']);
		await expect(menu).toHaveCSS('padding', '8px');
		for (const item of await menu.getByRole('menuitem').all()) {
			await expect(item).toHaveCSS('height', '36px');
			await expect(item.locator('.ash-menu-leading-slot .ash-icon')).toBeVisible();
		}
		const buttonBounds = (await add.boundingBox())!;
		const surface = menu.locator('..');
		const menuBounds = (await surface.boundingBox())!;
		expect(menuBounds.y - buttonBounds.y - buttonBounds.height).toBeCloseTo(8, 0);
		expect(menuBounds.x + menuBounds.width).toBeCloseTo(buttonBounds.x + buttonBounds.width, 0);
		await page.screenshot({ path: browser.info.outputPath('customize-add-menu-zh-cn.png') });
		await page.keyboard.press('Escape');
		await expect(add).toBeFocused();
	});
});
