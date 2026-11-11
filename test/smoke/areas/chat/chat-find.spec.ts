import { createServer } from 'node:http';
import { expect, test } from '../../../automation/test.js';
import { Workbench } from '../../../automation/workbench.js';
import { APP_SERVER_METHODS as methods } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

test.use({ gitRepository: true });

for (const surface of ['IDE', 'Agents Code', 'Agents Cowork'] as const) {
	test(`${surface} finds earlier conversation content without changing the draft or sending a request`, { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ application, target, webAppServer, workbench, testWorkspace }, testInfo) => {
		test.setTimeout(180_000);
		let calls = 0;
		const code = Array.from({ length: 80 }, (_, index) => index === 69 ? 'const old_code_needle = 42;' : `const line${index} = ${index};`).join('\n');
		const answer = '**needle** [visible](https://needle.invalid)\n\n```ts\n' + code + '\n```';
		const server = createServer(async (request, response) => {
			if (request.method === 'GET') {
				response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'chat-find-model' }] }));
				return;
			}
			for await (const _chunk of request) { /* Consume the fixture model input. */ }
			calls++;
			const content = calls === 1 ? answer : `Ordinary response ${calls}`;
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
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
			if (!address || typeof address === 'string') throw new Error('Missing Find fixture port');
			const provider = 'custom-chat-find-fixture';
			const model = { provider, model: 'chat-find-model' };
			const config = await client.request(methods['config/read'], {});
			await client.request(methods['provider/configure'], {
				commandId: 'find-provider', expectedRevision: config.revision, config: {
					connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`,
					custom: { name: 'Find fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 },
					modelContext: { [model.model]: { contextWindow: 272_000 } },
				}
			});
			await client.request(methods['provider/apiKey/set'], { connection: provider, apiKey: 'isolated-find-fixture-key' });
			const created = await client.request(methods['session/create'], { commandId: 'find-session', kind: 'code', title: 'Find earlier conversation', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
			const sessionId = created.session.sessionId;
			const threadId = created.session.threads[0].threadId;
			const read = async () => (await client.request(methods['session/thread/read'], { sessionId, threadId })).thread;
			// Exceed the product's recent-history window so Find must use the owning loader.
			for (let index = 0; index < 21; index++) {
				const thread = await read();
				await client.request(methods['session/request'], {
					sessionId, commandId: `find-turn-${index}`, request: {
						type: 'startTurn', threadId, expectedSequence: thread.sequence, mode: 'ask', approvalMode: 'manual', model,
						input: [{ type: 'text', text: index === 0 ? 'Needle request' : `Ordinary request ${index}` }],
					}
				});
				await expect.poll(async () => (await read()).turns.at(-1)?.status, { intervals: [30, 60, 100] }).toBe('completed');
			}
			const before = await read();
			if (agents) {
				await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
				await page.locator('.ash-sessions-list-item').filter({ hasText: 'Find earlier conversation' }).click();
				if (surface === 'Agents Cowork') await page.locator('[data-action-id="sessions.open.collaboration"] button').click();
			} else {
				await window.quickaccess.runCommand('workbench.action.chat.open');
				await page.locator('[data-action-id="workbench.action.chat.showHistory"] button').click();
				await page.getByRole('option').filter({ hasText: 'Find earlier conversation' }).click();
			}
			const chat = page.locator(agents ? `.ash-sessions-chat-slot.active:visible ${surface === 'Agents Code' ? '.ash-chat' : '.ash-native-chat'}` : '.ash-chat-view-pane .ash-chat:visible');
			await expect(chat).toHaveAttribute('data-thread-id', threadId);
			const composer = chat.locator('.ash-chat-input-part');
			const draft = composer.locator('.stanza-editor-input');
			if (surface !== 'Agents Cowork') {
				await expect(chat.getByRole('button', { name: 'Load earlier messages', exact: true })).toBeVisible();
				await expect(chat).not.toContainText('Needle request');
			}
			await draft.focus();
			await page.keyboard.insertText('Unsent needle draft');
			await page.keyboard.press('ControlOrMeta+f');
			const find = chat.getByRole('search', { name: 'Find in Chat', exact: true });
			const query = find.getByRole('textbox', { name: 'Find in conversation', exact: true });
			await expect(query).toBeFocused();
			await query.fill('needle');
			const status = find.getByRole('status');
			await expect(status).toHaveText('1 of 3 matches');
			const controls = await find.boundingBox();
			const firstMatch = await chat.getByText('Needle request', { exact: true }).boundingBox();
			expect(firstMatch!.y).toBeGreaterThanOrEqual(controls!.y + controls!.height);
			await query.press('Enter');
			await expect(status).toHaveText('2 of 3 matches');
			await query.press('Shift+Enter');
			await expect(status).toHaveText('1 of 3 matches');
			await draft.focus();
			await page.keyboard.press('F3');
			await expect(status).toHaveText('2 of 3 matches');
			await page.keyboard.press('Shift+F3');
			await expect(status).toHaveText('1 of 3 matches');
			await query.fill('old_code_needle');
			await expect(status).toHaveText('1 of 1 matches');
			await expect(chat.locator('.ash-chat-find-code-current')).toBeVisible();
			await chat.locator('.ash-chat-find-active .ash-chat-code-block .stanza-editor-input').focus();
			await page.keyboard.press('ControlOrMeta+f');
			await expect(query).toBeFocused();
			await query.fill('needle.invalid');
			await expect(status).toHaveText('No results');
			await query.fill('needle');
			await find.getByRole('button', { name: 'Whole word', exact: true }).click();
			await expect(status).toHaveText('1 of 2 matches');
			await find.getByRole('button', { name: 'Regular expression', exact: true }).click();
			await query.fill('[');
			await expect(query).toHaveAttribute('aria-invalid', 'true');
			await expect(status).toHaveText('Invalid regular expression');
			await query.press('Escape');
			await expect(find).toBeHidden();
			await expect(draft).toBeFocused();
			await expect(composer.locator('.view-lines')).toContainText('Unsent needle draft');
			expect(await read()).toEqual(before);
			expect(calls).toBe(21);
			await window.quickaccess.runCommand('workbench.action.chat.find');
			await expect(query).toBeFocused();
			await find.getByRole('button', { name: 'Regular expression', exact: true }).click();
			await find.getByRole('button', { name: 'Whole word', exact: true }).click();
			await query.fill('needle');
			await expect(status).toHaveText(/[1-3] of 3 matches/u);
			await page.keyboard.press('Alt+F1');
			const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true }).getByRole('textbox');
			await expect(help).toHaveValue(/Find in Chat[\s\S]*Earlier messages/u);
			await expect(help).not.toHaveValue(/<keybinding:/u);
			await page.keyboard.press('Escape');
			await expect(query).toBeFocused();
			await testInfo.attach('chat-find-state.json', { body: JSON.stringify({ surface, sessionId, threadId, calls, sequence: before.sequence }), contentType: 'application/json' });
			await page.screenshot({ path: testInfo.outputPath('chat-find.png') });
			await query.press('Escape');
			if (!agents) {
				await page.keyboard.press('ControlOrMeta+n');
				const editor = window.editors.groupAt(0).editor;
				await editor.waitForEditorFocus();
				await page.keyboard.press('ControlOrMeta+f');
				await expect(page.locator('.stanza-editor-find-widget:visible')).toBeVisible();
				await expect(find).toBeHidden();
			}

		} finally {
			await connection?.close();
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
}
