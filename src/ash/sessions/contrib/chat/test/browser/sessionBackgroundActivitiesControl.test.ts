import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import type { } from '../../../../../../../test/fixtures/browser/sessions.page.js';

suite('Session background activities', () => {
	const browser = useBrowserTests();

	test('opens a directly delegated agent beside its source and preserves the source draft', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?multiHost&sideThreads&backgroundActivities&locale=zh-CN');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.locator('.ash-window-mode-control').getByRole('button', { name: '代码', exact: true }).click();
		await page.evaluate(() => window.ashSessionsIntegration.multiHost!.open('Host A'));
		const slots = page.locator('.ash-sessions-chat-slot:visible');
		await slots.first().locator('.ash-chat-input-editor .stanza-editor').getByRole('textbox').focus();
		await page.keyboard.insertText('Keep my draft');
		const activities = slots.first().locator('.ash-sessions-background-activities');
		await activities.getByText('后台活动', { exact: true }).click();
		await expect(activities.getByRole('button')).toHaveCount(1);
		await activities.getByRole('button', { name: 'Research worker · 运行中' }).click();
		await expect(slots).toHaveCount(2);
		await expect(slots.first().locator('.ash-chat-input-editor .view-lines')).toHaveText('Keep my draft');
		await expect(slots.last().locator('.ash-chat-input-editor .stanza-editor').getByRole('textbox')).toBeFocused();
	});
});
