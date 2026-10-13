import { expect, test } from '@playwright/test';

for (const variant of [
	{ locale: 'en', theme: 'light', os: 'mac' },
	{ locale: 'zh-CN', theme: 'dark', os: 'windows' },
	{ locale: 'en', theme: 'hc', os: 'mac' },
]) {
	test(`command palette renders individual keycaps and preserves chord groups (${variant.locale}, ${variant.theme})`, async ({ page }, testInfo) => {
		await page.goto(`/quickAccess.html?${new URLSearchParams(variant)}`);
		await page.getByRole('button', { name: 'Open commands' }).click();
		const picker = page.locator('.ash-quick-pick');
		const input = picker.getByRole('combobox');
		await input.fill('>Format');
		const row = picker.locator('.ash-list-row').filter({ has: page.locator('.ash-quick-pick-row-label', { hasText: /^Format$/ }) });
		const shortcut = row.locator('.ash-keybinding-label');
		const modifier = variant.os === 'windows' ? 'Ctrl' : '⌘';
		await expect(shortcut.locator('kbd')).toHaveText([modifier, 'K', modifier, 'Enter']);
		await expect(shortcut.locator('.ash-keybinding-label-chord')).toHaveCount(2);
		await expect(shortcut).toHaveAttribute('aria-label', variant.os === 'windows' ? 'Control+K, Control+Enter' : 'Command+K, Command+Enter');
		for (const cap of await shortcut.locator('kbd').all()) {
			await expect(cap).toHaveCSS('height', '22px');
			await expect(cap).toHaveCSS('border-radius', '4px');
		}
		await expect(shortcut.locator('kbd').last()).toHaveCSS('white-space', 'nowrap');
		await page.setViewportSize({ width: 600, height: 600 });
		const bounds = await shortcut.boundingBox();
		const rowBounds = await row.boundingBox();
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(rowBounds!.x + rowBounds!.width);
		await picker.screenshot({ path: testInfo.outputPath('command-keycaps.png') });
		await input.fill('>Zulu Format');
		await expect(picker.locator('.ash-keybinding-label kbd')).toHaveText(['F1']);
		await input.press('Enter');
		await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText('Zulu Format');
	});
}

for (const variant of [{ locale: 'en', theme: 'light' }, { locale: 'zh-CN', theme: 'dark' }, { locale: 'en', theme: 'hc' }]) {
	test(`Quick Access switches Commands, Files, Issues and PR through one picker (${variant.locale}, ${variant.theme})`, async ({ page }, testInfo) => {
		await page.goto(`/quickAccess.html?locale=${variant.locale}&theme=${variant.theme}`);
		await page.getByRole('button', { name: 'Open commands' }).click();
		const input = page.getByRole('combobox');
		const picker = page.getByRole('dialog');
		const tabs = picker.getByRole('tab');
		const labels = variant.locale === 'zh-CN' ? ['命令', '文件', '议题', 'PR'] : ['Commands', 'Files', 'Issues', 'PR'];
		await expect(tabs).toHaveText(labels);
		for (const tab of await tabs.all()) {
			const offset = await tab.evaluate(element => {
				const button = element.getBoundingClientRect();
				const text = element.querySelector('.ash-icon-label-text')!.getBoundingClientRect();
				return {
					x: Math.abs(text.x + text.width / 2 - button.x - button.width / 2),
					y: Math.abs(text.y + text.height / 2 - button.y - button.height / 2),
				};
			});
			expect(offset.x).toBeLessThanOrEqual(1);
			expect(offset.y).toBeLessThanOrEqual(1);
		}
		await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
		await input.fill('>Fix');
		await page.keyboard.press('Tab');
		await expect(tabs.nth(0)).toBeFocused();
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ArrowRight');
		await expect(tabs.nth(2)).toBeFocused();
		await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
		await page.keyboard.press('Enter');
		await expect(input).toBeFocused();
		await expect(input).toHaveValue('issue Fix');
		await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
		await expect(picker.locator('.ash-quick-pick-row-label')).toHaveText('#9 Fix issue');
		await expect(picker).toHaveCount(1);
		await page.screenshot({ path: testInfo.outputPath('quick-access-tabs.png') });
		await tabs.nth(1).click();
		await expect(input).toHaveValue('Fix');
		await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
		await expect(picker.locator('.ash-quick-pick-row-label')).toHaveText('Fix.ts');
		await tabs.nth(3).click();
		await expect(input).toHaveValue('pr Fix');
		await expect(picker.locator('.ash-quick-pick-row-label').first()).toHaveText('#7 Fix rendering');
		await input.fill('pr navigation');
		const more = variant.locale === 'zh-CN' ? '加载更多结果' : 'Load more results';
		await expect(picker.locator('.ash-quick-pick-row-label')).toHaveText(more);
		await page.keyboard.press('Enter');
		await expect(picker.locator('.ash-quick-pick-row-label')).toHaveText('#8 Add navigation');
		await expect(input).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(picker).toHaveCount(0);
		await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText('ash-github://github.com/team/repo/pull/8?account=alice');
	});

	test(`Quick Access keeps long file results readable and keyboard reachable (${variant.locale}, ${variant.theme})`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 1_200, height: 700 });
		await page.goto(`/quickAccess.html?locale=${variant.locale}&theme=${variant.theme}`);
		const open = page.getByRole('button', { name: 'Open files' });
		await open.click();
		const input = page.getByRole('combobox');
		const picker = page.getByRole('dialog');
		await expect(input).toBeFocused();
		await expect(picker).toHaveCSS('border-radius', '8px');
		await expect(input).toHaveCSS('border-radius', '4px');
		const focusColor = variant.theme === 'hc' ? 'rgb(255, 255, 255)' : variant.theme === 'dark' ? 'rgb(0, 127, 212)' : 'rgb(0, 120, 212)';
		await expect(input).toHaveCSS('border-color', focusColor);
		if (variant.theme === 'hc') {
			await expect(picker).toHaveCSS('border-color', 'rgb(255, 255, 255)');
		}
		const first = picker.getByRole('option').first();
		const detail = first.locator('.ash-quick-pick-row-detail');
		const label = first.locator('.ash-quick-pick-row-label');
		const description = first.locator('.ash-quick-pick-row-description');
		const labelBounds = (await label.boundingBox())!;
		const detailBounds = (await detail.boundingBox())!;
		expect(detailBounds.y).toBeGreaterThanOrEqual(labelBounds.y + labelBounds.height);
		await expect(description).toHaveCSS('text-overflow', 'ellipsis');
		expect(await description.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
		await expect(description).toHaveAttribute('title', await description.textContent() ?? '');
		const results = picker.locator('.ash-quick-pick-list-scrollable');
		expect((await results.boundingBox())!.height).toBeLessThanOrEqual(700 * 0.4);
		expect((await picker.boundingBox())!.width).toBeLessThanOrEqual(600);
		await page.screenshot({ path: testInfo.outputPath('quick-access.png') });
		await page.keyboard.press('ArrowDown');
		const active = picker.locator('.ash-list-row.is-active');
		await expect(active.locator('.ash-quick-pick-row-label')).toHaveText('file-1.ts');
		await expect(input).toHaveAttribute('aria-activedescendant', await active.getAttribute('id') ?? '');
		await page.keyboard.press('PageDown');
		await page.keyboard.press('PageDown');
		await expect.poll(() => results.locator('.ash-scrollbar-viewport').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
		await page.setViewportSize({ width: 360, height: 240 });
		await expect.poll(async () => (await results.boundingBox())!.height).toBeLessThanOrEqual(240 * 0.4);
		const bounds = (await picker.boundingBox())!;
		expect(bounds.x).toBeGreaterThanOrEqual(0);
		expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
		await page.keyboard.press('Escape');
		await expect(picker).toHaveCount(0);
		await expect(open).toBeFocused();
		await open.click();
		await input.fill('file-59');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText('file-59.ts');
		await expect(open).toBeFocused();
	});

	test(`Command Palette preserves recent history through search and reload (${variant.locale}, ${variant.theme})`, async ({ page }) => {
		await page.goto(`/quickAccess.html?locale=${variant.locale}&theme=${variant.theme}`);
		const open = page.getByRole('button', { name: 'Open commands' });
		const input = page.getByRole('combobox');
		const labels = page.locator('.ash-quick-pick-row-label');
		for (const label of ['Zulu Format', 'Alpha Format', 'Zulu Format']) {
			await open.click();
			await input.fill(`>${label}`);
			await page.keyboard.press('Enter');
			await expect(input).toHaveCount(0);
			await expect(open).toBeFocused();
		}
		await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText('Zulu Format, Alpha Format, Zulu Format');
		await open.click();
		await expect(labels.nth(0)).toHaveText('Zulu Format');
		await expect(labels.nth(1)).toHaveText('Alpha Format');
		const recent = variant.locale === 'zh-CN' ? '最近使用' : 'recently used';
		const other = variant.locale === 'zh-CN' ? '其他命令' : 'other commands';
		await expect(page.getByRole('separator', { name: recent })).toHaveCount(1);
		await expect(page.getByRole('separator', { name: other })).toHaveCount(1);
		await input.fill('>for');
		await expect(labels).toHaveText(['Zulu Format', 'Alpha Format', 'Format']);
		await expect(input).toBeFocused();
		await input.fill('>Format');
		await expect(labels.nth(0)).toHaveText('Format');
		await input.fill('>Zulu');
		await expect(labels).toHaveText(['Zulu Format']);
		const removeName = variant.locale === 'zh-CN' ? '从命令历史记录中移除' : 'Remove from Command History';
		const remove = page.getByRole('button', { name: removeName });
		await expect(remove.locator('svg.ash-icon')).toHaveAttribute('aria-hidden', 'true');
		await page.keyboard.press('Tab');
		await expect(page.getByRole('tab').first()).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(remove).toBeFocused();
		await expect(remove).toHaveCSS('opacity', '1');
		await page.keyboard.press('Enter');
		await expect(input).toBeFocused();
		await expect(remove).toHaveCount(0);
		await expect(labels).toHaveText(['Zulu Format']);
		await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText('Zulu Format, Alpha Format, Zulu Format');
		await page.keyboard.press('Escape');
		await page.reload();
		await open.click();
		await expect(labels.nth(0)).toHaveText('Alpha Format');
		await input.fill('>for');
		await expect(labels).toHaveText(['Alpha Format', 'Format', 'Zulu Format']);
		await page.evaluate(() => window.ashQuickAccessIntegration.setHistoryLength(0));
		await expect(page.getByRole('separator', { name: recent })).toHaveCount(0);
		await expect(labels).toHaveText(['Alpha Format', 'Format', 'Zulu Format']);
		await input.fill('>Zulu');
		await page.keyboard.press('Enter');
		await page.evaluate(() => window.ashQuickAccessIntegration.setHistoryLength(50));
		await open.click();
		await expect(page.getByRole('separator', { name: recent })).toHaveCount(0);
	});
}

test('switching providers cancels late GitHub results and scoped pickers omit navigation', async ({ page }) => {
	await page.goto('/quickAccess.html');
	await expect(page.getByRole('button', { name: 'Open commands' })).toBeEnabled();
	await page.evaluate(() => {
		window.ashQuickAccessIntegration.holdNextRequest();
		window.ashQuickAccessIntegration.show('pr ');
	});
	await expect.poll(() => page.evaluate(() => window.ashQuickAccessIntegration.requests.some(request => request.kind === 'prs'))).toBe(true);
	const input = page.getByRole('combobox');
	await page.getByRole('tab', { name: 'Commands', exact: true }).click();
	await expect(input).toHaveValue('>');
	await input.fill('>for');
	await expect(page.locator('.ash-quick-pick-row-label')).toHaveText(['Alpha Format', 'Format', 'Zulu Format']);
	await page.evaluate(() => window.ashQuickAccessIntegration.releaseRequest());
	await expect(page.locator('.ash-quick-pick-row-label')).toHaveText(['Alpha Format', 'Format', 'Zulu Format']);
	await page.keyboard.press('Escape');
	await page.evaluate(() => window.ashQuickAccessIntegration.show('>', true));
	await expect(page.getByRole('tab')).toHaveCount(0);
	await expect(input).toBeFocused();
});

test('GitHub navigation offers repository setup when no account is connected', async ({ page }) => {
	await page.goto('/quickAccess.html');
	await expect(page.getByRole('button', { name: 'Open commands' })).toBeEnabled();
	await page.evaluate(() => {
		window.ashQuickAccessIntegration.setSignedIn(false);
		window.ashQuickAccessIntegration.show('issue ');
	});
	await expect(page.locator('.ash-quick-pick-row-label')).toHaveText('Open GitHub to sign in or choose a repository');
	await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText('ash-github:/');
});


test('Quick Input navigation uses live user bindings and blockers', async ({ page }) => {
	await page.goto('/quickAccess.html');
	await page.getByRole('button', { name: 'Open files' }).click();
	const input = page.getByRole('combobox');
	const active = page.locator('.ash-quick-pick .ash-list-row.is-active .ash-quick-pick-row-label');
	await expect(active).toHaveText('file-0.ts');
	await page.evaluate(() => window.ashQuickAccessIntegration.setNavigationBinding('blocked'));
	await page.keyboard.press('ArrowDown');
	await expect(active).toHaveText('file-0.ts');
	await page.evaluate(() => window.ashQuickAccessIntegration.setNavigationBinding('rebound'));
	await page.keyboard.press('F8');
	await expect(active).toHaveText('file-1.ts');
	await expect(input).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(active).toHaveText('file-1.ts');
	await page.evaluate(() => window.ashQuickAccessIntegration.setNavigationBinding('default'));
	await page.keyboard.press('ArrowDown');
	await expect(active).toHaveText('file-2.ts');
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Open files' })).toBeFocused();
});


test('Quick Access Files background acceptance preserves the picker for both keyboard and pointer modifiers', async ({ page }) => {
	await page.goto('/quickAccess.html');
	await page.getByRole('button', { name: 'Open commands' }).click();
	await page.getByRole('tab', { name: 'Files', exact: true }).click();
	const input = page.getByRole('combobox');
	const result = page.locator('.ash-quick-pick-row-label');
	await input.fill('Fix');
	await expect(result).toHaveText('Fix.ts');
	await page.keyboard.press('ControlOrMeta+Enter');
	await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText('file:///workspace/Fix.ts');
	await expect(input).toBeFocused();
	await result.click({ modifiers: ['ControlOrMeta'] });
	await expect(page.getByRole('dialog')).toHaveCount(1);
	await result.click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
});


test('Quick Access workspace symbols cancel stale queries and accept through the shared service', async ({ page }) => {
	await page.goto('/quickAccess.html');
	await page.getByRole('button', { name: 'Open commands' }).click();
	await page.evaluate(() => {
		window.ashQuickAccessIntegration.holdNextRequest();
		window.ashQuickAccessIntegration.show('@old');
	});
	await expect.poll(() => page.evaluate(() => window.ashQuickAccessIntegration.requests.some(request => request.kind === 'symbols' && request.query === 'old'))).toBe(true);
	const input = page.getByRole('combobox');
	await input.fill('@new');
	await expect(page.locator('.ash-quick-pick-row-label')).toHaveText('newSymbol');
	await page.evaluate(() => window.ashQuickAccessIntegration.releaseRequest());
	await expect(page.locator('.ash-quick-pick-row-label')).toHaveText('newSymbol');
	await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByRole('status', { name: 'Executed commands' })).toHaveText('file:///workspace/symbol.ts');
});
