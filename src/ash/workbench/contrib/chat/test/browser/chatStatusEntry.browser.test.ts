import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('AI subscription status browser', () => {
	const browser = useBrowserTests();
	for (const locale of ['en', 'zh-CN']) {
		test(`quota rows pass through the account adapter and preserve keyboard focus in ${locale}`, async () => {
			const { page } = browser;
			await page.goto(`/chatStatus.html${locale === 'en' ? '' : '?zh'}`);
			const trigger = page.getByRole('button', { name: /^AI · / });
			await trigger.focus();
			await trigger.press('Enter');
			const picker = page.getByRole('combobox');
			await expect(picker).toBeFocused();
			const window = page.getByRole('option', { name: /Codex/ });
			await expect(window).toContainText(locale === 'en' ? '75% remaining (25% used)' : '剩余 75%（已用 25%）');
			await expect(window).toContainText(locale === 'en' ? 'Resets: ' : '重置时间：');
			const bounds = await window.boundingBox();
			assert.ok(bounds && bounds.height > 0 && bounds.width > 0);
			await page.screenshot({ path: browser.info.outputPath(`quota-${locale}.png`) });
			await picker.fill(locale === 'en' ? 'Refresh Account Status and Limits' : '刷新账号状态与额度');
			await picker.press('Enter');
			await expect(page.locator('html')).toHaveAttribute('data-queries', '2');
			await expect(picker).toBeFocused();
			await picker.press('Escape');
			await expect(picker).toHaveCount(0);
			await expect(trigger).toBeFocused();
		});
	}
});
