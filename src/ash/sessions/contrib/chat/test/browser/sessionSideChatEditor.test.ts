import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import type { } from '../../../../../../../test/fixtures/browser/sessions.page.js';

suite('Side Chat', () => {
	const browser = useBrowserTests();

	test('switches the model and Skill catalogs with the draft host and keeps unsent input', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?multiHost&sideChatHostSwitch');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await page.evaluate(async () => {
			const fixture = window.ashSessionsIntegration.multiHost!;
			await fixture.open('Host A');
			await fixture.openSideChat();
		});
		const chat = page.locator('.ash-session-side-chat-editor');
		const input = chat.locator('.ash-chat-input-editor').getByRole('textbox');
		const model = chat.locator('.ash-chat-input-model-action');
		await expect(model).toHaveText('Host A model');
		await input.focus();
		await page.keyboard.insertText('Review $host-a-skill');
		await input.evaluate(element => {
			const transfer = new DataTransfer();
			transfer.items.add(new File(['original contents'], 'draft.txt', { type: 'text/plain' }));
			element.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
		});
		await expect(chat.locator('.ash-chat-code-reference')).toHaveText('draft.txt');

		await chat.getByRole('button', { name: 'Run on: Host A' }).press('ArrowDown');
		await page.locator('.ash-sessions-environment-menu').getByRole('menuitemradio', { name: 'Host B' }).press('Enter');
		await expect(chat.getByRole('button', { name: 'Run on: Host B' })).toBeVisible();
		await expect(input).toBeFocused();
		await expect(chat.locator('.ash-chat-input-editor .view-lines')).toContainText('Review $host-a-skill');
		await expect(chat.locator('.ash-chat-code-reference')).toHaveText('draft.txt');
		await expect(model).toHaveText('Host B model');
		await model.press('ArrowDown');
		const picker = page.locator('.ash-chat-model-picker');
		await expect(picker.getByRole('menuitemradio', { name: 'Host A model' })).toHaveCount(0);
		await picker.getByRole('menuitemradio', { name: 'Host B alternative' }).press('Enter');
		await expect(model).toHaveText('Host B alternative');
		await input.press('End');
		await input.pressSequentially(' $');
		const skillOption = (name: string) => page.getByRole('option').filter({
			has: page.locator('.stanza-editor-completion-label', { hasText: name }),
		});
		await expect(skillOption('$host-b-skill')).toBeVisible();
		await expect(skillOption('$host-a-skill')).toHaveCount(0);
		await input.press('Tab');
		await input.press('Enter');

		await expect.poll(() => page.evaluate(() => window.ashSessionsIntegration.multiHost!.submissions)).toMatchObject([{
			host: 'Host B',
			text: expect.stringContaining('Review $host-a-skill'),
			model: { provider: 'fixture', model: 'Host B alternative' },
			skills: [{ id: { source: 'Host B', name: 'host-b-skill' } }],
			contexts: [{ name: 'draft.txt', content: 'original contents' }],
		}]);
	});
});
