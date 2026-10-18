import { expect, test } from '@playwright/test';

for (const locale of ['en', 'zh-CN']) {
	test(`browser history search opens recorded pages and clears the session in ${locale}`, async ({ page }) => {
		await page.goto(`/browserView.html?locale=${locale}`);
		await page.waitForFunction(() => !!window.ashBrowserViewIntegration);
		const more = page.locator('.ash-browser-page-actions').getByRole('button', { name: locale === 'en' ? 'More Actions' : '更多操作', exact: true });
		const historyLabel = locale === 'en' ? 'History' : '历史记录';
		const openHistory = async (): Promise<void> => {
			await more.focus();
			await page.keyboard.press('Enter');
			await page.getByRole('menuitem', { name: historyLabel, exact: true }).click();
		};
		await openHistory();
		const search = page.getByRole('combobox', { name: historyLabel, exact: true });
		await expect(search).toBeFocused();
		await search.fill('Visited');
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => [...window.ashBrowserViewIntegration.calls])).toEqual(['https://example.com/visited']);
		await openHistory();
		await search.fill(locale === 'en' ? 'Clear browsing history' : '清除浏览历史记录');
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => [...window.ashBrowserViewIntegration.calls])).toEqual(['https://example.com/visited', 'clearHistory']);
		await expect(more).toBeFocused();
		await page.evaluate(() => window.ashBrowserViewIntegration.dispose());
	});

	test(`browser model replacement retires navigation state and command conditions in ${locale}`, async ({ page }) => {
		await page.goto(`/browserView.html?locale=${locale}`);
		await page.waitForFunction(() => !!window.ashBrowserViewIntegration);
		const back = page.getByRole('button', { name: locale === 'en' ? 'Back' : '后退', exact: true });
		const forward = page.getByRole('button', { name: locale === 'en' ? 'Forward' : '前进', exact: true });
		await page.evaluate(() => window.ashBrowserViewIntegration.history(false, false));
		await expect(back).toBeDisabled();
		await expect(forward).toBeDisabled();
		expect(await page.evaluate(() => window.ashBrowserViewIntegration.commands())).toEqual([]);
		await page.evaluate(() => window.ashBrowserViewIntegration.history(true, false));
		await expect(back).toBeEnabled();
		expect(await page.evaluate(() => window.ashBrowserViewIntegration.commands())).toEqual(['workbench.action.browser.goBack']);
		await back.click();
		await page.evaluate(() => window.ashBrowserViewIntegration.attach('second'));
		await page.evaluate(() => window.ashBrowserViewIntegration.history(false, true));
		await page.evaluate(() => window.ashBrowserViewIntegration.oldPageStatus());
		await expect(page.getByRole('status')).toHaveText('Browser layout');
		await expect(back).toBeDisabled();
		await expect(forward).toBeEnabled();
		expect(await page.evaluate(() => window.ashBrowserViewIntegration.commands())).toEqual(['workbench.action.browser.goForward']);
		await forward.click();
		expect(await page.evaluate(() => [...window.ashBrowserViewIntegration.calls])).toEqual(['back', 'forward']);
		await page.evaluate(() => window.ashBrowserViewIntegration.detach());
		expect(await page.evaluate(() => window.ashBrowserViewIntegration.commands())).toEqual([]);
		await expect(page.locator('.ash-browser-address input')).toBeDisabled();
		await expect(page.getByRole('status')).toBeEmpty();
		await page.evaluate(() => window.ashBrowserViewIntegration.dispose());
	});

	test(`browser address suggestions apply live search settings and preserve dismissal focus in ${locale}`, async ({ page }) => {
		await page.goto(`/browserView.html?locale=${locale}`);
		await page.waitForFunction(() => !!window.ashBrowserViewIntegration);
		const label = locale === 'en' ? 'Browser address' : '浏览器地址';
		const address = page.getByRole('textbox', { name: label, exact: true });
		await expect(address).toHaveAttribute('placeholder', locale === 'en' ? 'Enter a URL' : '输入网址');
		await page.evaluate(() => window.ashBrowserViewIntegration.setSearch('google'));
		await expect(address).toHaveAttribute('placeholder', locale === 'en' ? 'Search or enter a URL' : '搜索或输入网址');
		await address.fill('intranet');
		await address.press('ArrowDown');
		const picker = page.getByRole('combobox', { name: label, exact: true });
		await expect(picker).toBeFocused();
		const options = page.getByRole('option');
		await expect(options).toContainText([locale === 'en' ? 'Search for intranet' : '搜索 intranet', locale === 'en' ? 'Go to intranet' : '转到 intranet']);
		await picker.fill('two words');
		await expect(options).toHaveCount(1);
		await page.evaluate(() => window.ashBrowserViewIntegration.setSearch('duckduckgo'));
		await picker.press('Enter');
		await expect.poll(() => page.evaluate(() => [...window.ashBrowserViewIntegration.calls])).toEqual(['https://duckduckgo.com/?q=two+words']);
		await address.fill('https://example.com/');
		await address.press('ArrowDown');
		await expect(picker).toBeFocused();
		await expect(options).toContainText([locale === 'en' ? 'Go to https://example.com/' : '转到 https://example.com/', locale === 'en' ? 'Search for https://example.com/' : '搜索 https://example.com/']);
		await picker.press('Escape');
		await expect(picker).toHaveCount(0);
		await expect(address).toHaveValue('https://example.com/');
		await expect(page.locator('.ash-browser-viewport')).toBeFocused();
		await address.fill('unfinished');
		await address.press('ArrowDown');
		await expect(picker).toBeFocused();
		const back = page.getByRole('button', { name: locale === 'en' ? 'Back' : '后退', exact: true });
		await back.focus();
		await expect(picker).toHaveCount(0);
		await expect(back).toBeFocused();
		await expect(address).toHaveValue('https://example.com/');
		await page.evaluate(() => window.ashBrowserViewIntegration.setSearch('none'));
		await expect(address).toHaveAttribute('placeholder', locale === 'en' ? 'Enter a URL' : '输入网址');
		await page.evaluate(() => window.ashBrowserViewIntegration.dispose());
	});

	for (const width of [1000, 500, 240]) {
		test(`browser navigation leaves usable address space and keyboard page actions in ${locale} at ${width}px`, async ({ page }, testInfo) => {
			await page.setViewportSize({ width, height: 600 });
			await page.goto(`/browserView.html?locale=${locale}`);
			await page.waitForFunction(() => !!window.ashBrowserViewIntegration);
			const address = page.getByRole('textbox', { name: locale === 'en' ? 'Browser address' : '浏览器地址', exact: true });
			await expect(address).toBeEnabled();
			const geometry = await page.locator('.ash-browser-toolbar').evaluate(toolbar => {
				const bounds = toolbar.getBoundingClientRect();
				const input = toolbar.querySelector('input')!.getBoundingClientRect();
				const buttons = [...toolbar.querySelectorAll('button')];
				const controls = [toolbar.querySelector('input')!, ...buttons];
				const rectangles = controls.map(control => control.getBoundingClientRect());
				return {
					addressWidth: input.width,
					toolbarWidth: bounds.width,
					nonOverlapping: rectangles.every((rect, index) => rectangles.slice(index + 1).every(other => rect.right <= other.left || other.right <= rect.left || rect.bottom <= other.top || other.bottom <= rect.top)),
					unobscured: controls.every((control, index) => {
						const rect = rectangles[index]!;
						const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
						return target !== null && control.contains(target);
					}),
					contained: [toolbar.querySelector('input')!, ...buttons].every(control => {
						const rect = control.getBoundingClientRect();
						return rect.width > 0 && rect.height > 0 && rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom;
					}),
					singleLine: [...toolbar.querySelectorAll('button')].every(button => {
						const bounds = button.getBoundingClientRect();
						return bounds.height <= 32 && button.scrollHeight <= button.clientHeight && button.scrollWidth <= button.clientWidth;
					}),
					overflow: toolbar.scrollWidth > toolbar.clientWidth,
				};
			});
			await testInfo.attach('browser-toolbar-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
			await testInfo.attach(`browser-toolbar-${locale}-${width}`, { body: await page.screenshot(), contentType: 'image/png' });
			expect(geometry.addressWidth).toBeGreaterThanOrEqual(120);
			expect(geometry).toMatchObject({ contained: true, singleLine: true, overflow: false, nonOverlapping: true, unobscured: true });
			await address.fill('https://example.com/a-readable-address');
			await expect(address).toHaveValue('https://example.com/a-readable-address');
			const more = page.locator('.ash-browser-page-actions').getByRole('button', { name: locale === 'en' ? 'More Actions' : '更多操作', exact: true });
			const labels = locale === 'en' ? ['Share with Agent', 'Reset all website permissions', 'Cancel downloads'] : ['分享给 Agent', '重置所有网站权限', '取消下载'];
			for (const [index, label] of labels.entries()) {
				await more.focus();
				await page.keyboard.press('Enter');
				await expect(page.getByRole('menuitem', { name: label, exact: true })).toBeVisible();
				await page.getByRole('menuitem', { name: label, exact: true }).focus();
				await page.keyboard.press('Enter');
				await expect.poll(() => page.evaluate(() => [...window.ashBrowserViewIntegration.calls])).toEqual(['share', 'permissions', 'downloads'].slice(0, index + 1));
				await expect(page.getByRole('menu')).toHaveCount(0);
				await expect(more).toBeFocused();
			}
			await page.evaluate(() => window.ashBrowserViewIntegration.dispose());
		});
	}
}
