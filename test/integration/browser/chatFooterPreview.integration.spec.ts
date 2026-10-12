import { expect, test } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

test.use({ deviceScaleFactor: 2, viewport: { width: 640, height: 430 } });

test('Capture context hover and details in both capacity states', async ({ page }) => {
	const output = resolve('.build/desktop/previews/chat-secondary-toolbar');
	mkdirSync(output, { recursive: true });
	await page.goto('/chatInput.html?footerPreview=1&locale=zh-CN&theme=light');
	await page.addStyleTag({ content: readFileSync('src/ash/workbench/browser/media/style.css', 'utf8') });
	await page.evaluate(() => {
		window.ashChatInputIntegration.showModels();
		for (const output of document.querySelectorAll('output')) output.style.display = 'none';
		const main = document.querySelector('main')!;
		main.style.width = '480px';
		main.style.padding = '16px';
		main.style.margin = '180px auto 0';
		main.style.background = 'var(--ash-sideBar-background)';
	});
	const context = page.getByRole('button', { name: /^上下文用量：/ });
	for (const state of ['known', 'unknown']) {
		if (state === 'unknown') await page.evaluate(() => window.ashChatInputIntegration.setContextUsage(true));
		await page.mouse.move(20, 20);
		await context.hover();
		await expect(page.locator('.ash-hover')).toBeVisible();
		await expect(page.locator('.ash-hover')).toContainText(state === 'known' ? '上下文占用：20%' : '无法获取上下文容量');
		await page.screenshot({ path: resolve(output, `${state}-hover.png`), clip: { x: 65, y: 110, width: 510, height: 235 } });
		await context.click();
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText('当前上下文估算：200 个 token');
		await expect(dialog).toContainText(state === 'known' ? '上下文容量：1,000 个 token' : '无法获取上下文容量');
		await dialog.screenshot({ path: resolve(output, `${state}-details.png`) });
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
	}
});
