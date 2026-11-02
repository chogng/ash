import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import type { } from '../../../../../../../test/fixtures/browser/sessions.page.js';

suite('Sessions input state persistence browser recovery', () => {
	const browserTests = useBrowserTests();

	test('startup preserves a corrupt legacy entry and migrates another draft with its image', async () => {
		const { page } = browserTests;
		const draft = {
			mode: 'agent', text: 'Synthetic preserved image draft',
			contexts: [{ id: 'image', kind: 'image', name: 'screen.png', content: `data:image/png;base64,${'A'.repeat(64 * 1024)}` }],
		};
		await page.addInitScript(value => {
			localStorage.setItem('ash.storage.workspace.sessions', JSON.stringify({
				version: 1,
				entries: {
					'sessions.draftState:broken': { value: '{broken', target: 'machine' },
					'sessions.codeDraftState:untitled:saved': { value: JSON.stringify(value), target: 'machine' },
				},
			}));
		}, draft);
		await page.goto('/sessions.html?creator');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await expect(page.getByRole('region', { name: 'Notifications', exact: true }).getByText(/^Could not restore the Chat draft:/u)).toBeVisible();
		const saved = await page.evaluate(() => {
			const entries = JSON.parse(localStorage.getItem('ash.storage.workspace.sessions')!).entries;
			const raw = entries['sessions.inputDraft:untitled:saved'].value;
			const record = JSON.parse(raw);
			return {
				broken: entries['sessions.draftState:broken'].value,
				legacy: entries['sessions.codeDraftState:untitled:saved'],
				state: JSON.parse(record.state),
				attachments: JSON.parse(entries[`sessions.inputDraftAttachments:untitled:saved:${record.attachments}`].value),
				stateLength: raw.length,
			};
		});
		expect(saved).toEqual({
			broken: '{broken', legacy: undefined,
			state: { ...draft, contexts: [] }, attachments: draft.contexts,
			stateLength: expect.any(Number),
		});
		expect(saved.stateLength).toBeLessThan(1024);
		expect(await page.evaluate(() => window.ashSessionsIntegration.disposeAndCheckErrorHandler())).toBe(true);
	});
});
