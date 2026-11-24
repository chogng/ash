import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import type { } from '../../../../../../../test/fixtures/browser/sessions.page.js';

suite('Sessions input state persistence browser recovery', () => {
	const browserTests = useBrowserTests();

	test('startup ignores retired draft keys and preserves current image drafts', async () => {
		const { page } = browserTests;
		const draft = {
			text: '/swarm Inspect the attached image',
			contexts: [{ id: 'image', kind: 'image', name: 'screen.png', content: `data:image/png;base64,${'A'.repeat(64 * 1024)}` }],
		};
		const attachmentsId = '7f9ee2d7-8c9f-45ce-92c5-138649235cb5';
		await page.addInitScript(({ value, attachmentsId }) => {
			localStorage.setItem('ash.storage.workspace.sessions', JSON.stringify({
				version: 1,
				entries: {
					'sessions.draftState:broken': { value: '{broken', target: 'machine' },
					'sessions.codeDraftState:untitled:legacy': { value: JSON.stringify({ ...value, mode: 'swarm', contexts: [] }), target: 'machine' },
					'sessions.inputDraft:untitled:saved': { value: JSON.stringify({ state: JSON.stringify({ text: value.text, contexts: [] }), attachments: attachmentsId }), target: 'machine' },
					[`sessions.inputDraftAttachments:untitled:saved:${attachmentsId}`]: { value: JSON.stringify(value.contexts), target: 'machine' },
				},
			}));
		}, { value: draft, attachmentsId });
		await page.goto('/sessions.html?artifacts');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await expect(page.getByRole('region', { name: 'Notifications', exact: true }).getByText(/^Could not restore the Chat draft:/u)).toHaveCount(0);
		const saved = await page.evaluate(() => {
			const entries = JSON.parse(localStorage.getItem('ash.storage.workspace.sessions')!).entries;
			const raw = entries['sessions.inputDraft:untitled:saved'].value;
			const record = JSON.parse(raw);
			return {
				broken: entries['sessions.draftState:broken'].value,
				migratedLegacy: entries['sessions.inputDraft:untitled:legacy'],
				state: JSON.parse(record.state),
				attachments: JSON.parse(entries[`sessions.inputDraftAttachments:untitled:saved:${record.attachments}`].value),
				stateLength: raw.length,
			};
		});
		expect(saved).toEqual({
			broken: '{broken', migratedLegacy: undefined,
			state: { ...draft, contexts: [] }, attachments: draft.contexts,
			stateLength: expect.any(Number),
		});
		expect(saved.stateLength).toBeLessThan(1024);
		expect(await page.evaluate(() => window.ashSessionsIntegration.disposeAndCheckErrorHandler())).toBe(true);
	});
});
