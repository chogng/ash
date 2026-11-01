import { createServer } from 'node:http';
import { expect, test } from '../../../automation/test.js';
import { Workbench } from '../../../automation/workbench.js';
import { APP_SERVER_METHODS as methods } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

test.use({ gitRepository: true });

for (const surface of ['IDE', 'Agents Code', 'Agents Cowork'] as const) {
	test(`${surface} navigates messages and focuses a pending confirmation without sending or answering`, { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ application, target, webAppServer, workbench, testWorkspace }, testInfo) => {
		test.setTimeout(180_000);
		let calls = 0;
		const server = createServer(async (request, response) => {
			if (request.method === 'GET') {
				response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'navigation-model' }] }));
				return;
			}
			for await (const _chunk of request) { /* Consume the isolated fixture input. */ }
			calls++;
			const delta = calls === 3
				? { tool_calls: [{ index: 0, id: 'navigation-confirmation', type: 'function', function: { name: 'switch_mode', arguments: JSON.stringify({ mode: 'agent', reason: 'Synthetic navigation confirmation' }) } }] }
				: { content: `Navigation answer ${calls}` };
			const chunk = (delta: unknown, finish: string | null): string => `data: ${JSON.stringify({ id: 'navigation', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.end(chunk(delta, null) + chunk({}, calls === 3 ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
		try {
			const agents = surface !== 'IDE';
			const page = agents ? await workbench.openAgentsWindow(target.kind) : workbench.page;
			const window = new Workbench(page);
			connection = await connectProfile(application, webAppServer, testWorkspace.directory, page);
			const { client } = connection;
			const address = server.address();
			if (!address || typeof address === 'string') throw new Error('Missing navigation fixture port');
			const provider = 'custom-navigation-fixture';
			const model = { provider, model: 'navigation-model' };
			const config = await client.request(methods['config/read'], {});
			await client.request(methods['provider/configure'], {
				commandId: 'navigation-provider', expectedRevision: config.revision, config: {
					connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`,
					custom: { name: 'Navigation fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 },
					modelContext: { [model.model]: { contextWindow: 272_000 } },
				}
			});
			await client.request(methods['provider/apiKey/set'], { connection: provider, apiKey: 'isolated-navigation-fixture-key' });
			const created = await client.request(methods['session/create'], { commandId: 'navigation-session', title: 'Navigation conversation', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
			const sessionId = created.session.sessionId;
			const threadId = created.session.threads[0].threadId;
			const read = async () => (await client.request(methods['session/thread/read'], { sessionId, threadId })).thread;
			const start = async (index: number): Promise<void> => {
				const thread = await read();
				await client.request(methods['session/request'], {
					sessionId, commandId: `navigation-turn-${index}`, request: {
						type: 'startTurn', threadId, expectedSequence: thread.sequence, mode: 'ask', approvalMode: 'manual', model,
						input: [{ type: 'text', text: `Navigation prompt ${index}` }],
					}
				});
			};
			for (const index of [1, 2]) {
				await start(index);
				await expect.poll(async () => (await read()).turns.at(-1)?.status).toBe('completed');
			}
			if (agents) {
				await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
				await page.locator('.ash-sessions-list-item').filter({ hasText: 'Navigation conversation' }).click();
				if (surface === 'Agents Cowork') await page.locator('[data-action-id="sessions.open.collaboration"] button').click();
			} else {
				await window.quickaccess.runCommand('workbench.action.chat.open');
				await page.locator('[data-action-id="workbench.action.chat.showHistory"] button').click();
				await page.getByRole('option').filter({ hasText: 'Navigation conversation' }).click();
			}
			const chat = page.locator(agents ? `.ash-sessions-chat-slot.active:visible ${surface === 'Agents Code' ? '.ash-chat' : '.ash-cowork'}` : '.ash-chat-view-pane .ash-chat:visible');
			await expect(chat).toHaveAttribute('data-thread-id', threadId);
			const composer = chat.locator('.ash-chat-input-part');
			const draft = composer.locator('.stanza-editor-input');
			const row = (text: string) => chat.locator('article[data-item-id]').filter({ hasText: text });
			await expect(row('Navigation answer 2')).toBeVisible();
			await draft.focus();
			await page.keyboard.insertText('Unsent first line\nSecond line');
			const before = await read();
			if (process.platform === 'darwin') {
				await page.keyboard.press('ControlOrMeta+ArrowUp');
				await expect(draft).toBeFocused();
			}
			await page.keyboard.press('ControlOrMeta+ArrowUp');
			await expect(row('Navigation answer 2')).toBeFocused();
			await page.keyboard.press('ControlOrMeta+Alt+ArrowUp');
			await expect(row('Navigation prompt 1')).toBeFocused();
			await page.keyboard.press('ControlOrMeta+Alt+ArrowUp');
			await expect(row('Navigation prompt 1')).toBeFocused();
			await page.keyboard.press('ControlOrMeta+Alt+ArrowDown');
			await expect(row('Navigation prompt 2')).toBeFocused();
			await page.keyboard.press('ControlOrMeta+ArrowDown');
			await expect(draft).toBeFocused();
			await page.keyboard.press('ControlOrMeta+Shift+ArrowUp');
			await expect(row('Navigation prompt 2')).toBeFocused();
			await window.quickaccess.runCommand('chat.action.focus');
			await expect(row('Navigation answer 2')).toBeFocused();
			await window.quickaccess.runCommand('editor.action.accessibleView');
			const accessible = page.locator('.ash-accessible-view-content');
			await expect(accessible).toBeFocused();
			await expect(accessible).toHaveValue(/Navigation prompt 1[\s\S]*Navigation answer 2/u);
			await accessible.press('Escape');
			await expect(row('Navigation answer 2')).toBeFocused();
			await window.quickaccess.runCommand('workbench.chat.action.focusLastFocused');
			await expect(row('Navigation answer 2')).toBeFocused();
			expect(await read()).toEqual(before);
			expect(calls).toBe(2);
			await window.quickaccess.runCommand('workbench.action.chat.focusInput');
			await expect(draft).toBeFocused();
			await page.keyboard.press('Alt+F1');
			const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true }).getByRole('textbox');
			await expect(help).toHaveValue(/user prompts without wrapping[\s\S]*Focusing never accepts or declines/u);
			await expect(help).not.toHaveValue(/<keybinding:/u);
			await page.keyboard.press('Escape');
			await expect(draft).toBeFocused();
			await start(3);
			const question = chat.getByRole('combobox', { name: 'Synthetic navigation confirmation', exact: true });
			await expect(question).toBeVisible();
			const pending = await read();
			await window.quickaccess.runCommand('editor.action.toggleScreenReaderAccessibilityMode');
			await draft.focus();
			await page.keyboard.press('ControlOrMeta+Shift+a');
			await expect(question).toBeFocused();
			await page.keyboard.press('ControlOrMeta+Shift+a');
			await expect(draft).toBeFocused();
			await window.quickaccess.runCommand('workbench.action.chat.focusConfirmation');
			await expect(question).toBeFocused();
			expect(await read()).toEqual(pending);
			expect(calls).toBe(3);
			await expect(composer.locator('.view-lines')).toContainText('Unsent first line');
			await expect(composer.locator('.view-lines')).toContainText('Second line');
			await page.screenshot({ path: testInfo.outputPath('chat-navigation.png') });
		} finally {
			await connection?.close();
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
}
