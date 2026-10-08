import { expect, test } from '@playwright/test';

for (const locale of ['en', 'zh-CN']) {
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
				await page.keyboard.press('Home');
				for (let step = 0; step < index; step++) { await page.keyboard.press('ArrowDown'); }
				await page.keyboard.press('Enter');
				await expect.poll(() => page.evaluate(() => [...window.ashBrowserViewIntegration.calls])).toEqual(['share', 'permissions', 'downloads'].slice(0, index + 1));
				await expect(page.getByRole('menu')).toHaveCount(0);
				await expect(more).toBeFocused();
			}
			await page.evaluate(() => window.ashBrowserViewIntegration.dispose());
		});
	}
}
