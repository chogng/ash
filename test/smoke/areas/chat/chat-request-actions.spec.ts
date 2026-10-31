import { createServer } from 'node:http';
import { expect, test } from '../../../automation/test.js';
import { Workbench } from '../../../automation/workbench.js';
import { APP_SERVER_METHODS as methods } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

test.use({ gitRepository: true });

test('IDE archives and unarchives from History with the default labels and preserves the draft', { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ application, webAppServer, workbench, testWorkspace }, testInfo) => {
	test.setTimeout(90_000);
	const page = workbench.page;
	const connection = await connectProfile(application, webAppServer, testWorkspace.directory, page);
	try {
		const { client } = connection;
		const created = await client.request(methods['session/create'], { commandId: 'archive-history-session', title: 'Archive history fixture', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
		const sessionId = created.session.sessionId;
		const root = created.session.threads[0].threadId;
		await workbench.quickaccess.runCommand('workbench.action.chat.open');
		const historyButton = page.locator('[data-action-id="workbench.action.chat.showHistory"] button');
		await historyButton.click();
		const row = page.getByRole('option').filter({ hasText: 'Archive history fixture' });
		await row.click();
		const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
		await expect(chat).toHaveAttribute('data-thread-id', root);
		await chat.locator('.stanza-editor-input').focus();
		await page.keyboard.insertText('Keep this archived draft');
		const titleMenu = await workbench.menus.inspect(application, () => page.locator('.ash-chat-title-actions .ash-toolbar-more-actions button').click());
		expect(titleMenu.map(item => item.label)).not.toContain('Archive');
		expect(titleMenu.map(item => item.label)).not.toContain('Unarchive');
		await historyButton.click();
		const openMore = async (): Promise<void> => {
			await row.hover();
			await row.getByRole('button', { name: 'More session actions', exact: true }).click();
		};
		const actions = await workbench.menus.inspect(application, openMore);
		expect(actions.map(item => item.label)).toEqual(['Rename', 'Fork', 'Archive', 'Delete']);
		const confirmation = await workbench.dialogs.confirm(application, 'Confirm', 'Archive', () => workbench.menus.select(application, openMore, ['Archive']));
		expect(confirmation.message).toContain('Archive history fixture');
		await expect.poll(async () => (await client.request(methods['session/read'], { sessionId })).session.status).toBe('archived');
		await expect(row).toContainText('Archived. Press Enter to Unarchive.');
		await row.hover();
		await expect(row.getByRole('button', { name: 'Unarchive', exact: true })).toBeVisible();
		const archivedActions = await workbench.menus.inspect(application, openMore);
		expect(archivedActions.map(item => item.label)).toEqual(['Unarchive', 'Delete']);
		await testInfo.attach('history-menus.json', { body: JSON.stringify({ titleMenu, actions, archivedActions }), contentType: 'application/json' });
		await page.screenshot({ path: testInfo.outputPath('history-archived.png') });
		await workbench.menus.select(application, openMore, ['Unarchive']);
		await expect.poll(async () => (await client.request(methods['session/read'], { sessionId })).session.status).toBe('active');
		await row.hover();
		await expect(row.getByRole('button', { name: 'Pin session', exact: true })).toBeVisible();
		await row.click();
		await expect(chat).toHaveAttribute('data-thread-id', root);
		await expect(chat.locator('.view-lines')).toContainText('Keep this archived draft');
	} finally {
		await connection.close();
	}
});

for (const surface of ['IDE', 'Agents Code', 'Agents Cowork'] as const) {
	test(`${surface} edits requests, starts a new chat and forks history through the owning App Server`, { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ application, target, webAppServer, workbench, testWorkspace }, testInfo) => {
		test.setTimeout(180_000);
		let modelCalls = 0;
		const server = createServer(async (request, response) => {
			if (request.method === 'GET') {
				response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'request-actions-model' }] }));
				return;
			}
			for await (const _chunk of request) { /* Consume the model input before completing the controlled response. */ }
			modelCalls++;
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.end(`data: {"id":"request-actions","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Request action answer ${modelCalls}"},"finish_reason":null}]}\n\ndata: {"id":"request-actions","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
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
			if (!address || typeof address === 'string') throw new Error('Missing request model fixture port');
			const provider = 'custom-request-actions-fixture';
			const model = { provider, model: 'request-actions-model' };
			const config = await client.request(methods['config/read'], {});
			await client.request(methods['provider/configure'], {
				commandId: 'request-provider', expectedRevision: config.revision, config: {
					connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`,
					custom: { name: 'Request actions fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 },
					modelContext: { [model.model]: { contextWindow: 272_000 } },
				}
			});
			await client.request(methods['provider/apiKey/set'], { connection: provider, apiKey: 'isolated-request-actions-key' });
			const configured = await client.request(methods['config/read'], {});
			await client.request(methods['config/update'], { commandId: 'request-default-model', expectedRevision: configured.revision, model });
			const created = await client.request(methods['session/create'], { commandId: 'request-actions-session', title: 'Request actions source', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
			const sessionId = created.session.sessionId;
			const root = created.session.threads[0].threadId;
			const read = async (threadId: string, owner = sessionId) => (await client.request(methods['session/thread/read'], { sessionId: owner, threadId })).thread;
			const before = await read(root);
			await client.request(methods['session/request'], {
				sessionId, commandId: 'request-actions-turn', request: {
					type: 'startTurn', threadId: root, expectedSequence: before.sequence, mode: 'ask', approvalMode: 'manual', model,
					input: [{ type: 'context', name: 'Accepted file', content: 'Original immutable context' }, { type: 'text', text: 'Original request' }],
				}
			});
			await expect.poll(async () => (await read(root)).turns.at(-1)?.status).toBe('completed');
			await expect.poll(async () => (await client.request(methods['turnChanges/list'], { sessionId, threadId: root })).changeSets.at(-1)?.captureState).toBe('sealed');
			if (agents) {
				await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
				await page.locator('.ash-sessions-list-item').filter({ hasText: 'Request actions source' }).click();
				if (surface === 'Agents Cowork') await page.locator('[data-action-id="sessions.open.collaboration"] button').click();
			} else {
				await window.quickaccess.runCommand('workbench.action.chat.open');
				if (!await page.locator('.ash-chat-sessions-sidebar').isVisible()) await window.quickaccess.runCommand('agentSessions.toggleAgentSessionsSidebar');
				await page.locator('.ash-chat-sessions-sidebar .ash-agent-session-row').filter({ hasText: 'Request actions source' }).click();
			}
			const chat = page.locator(agents ? `.ash-sessions-chat-slot.active:visible ${surface === 'Agents Code' ? '.ash-chat' : '.ash-cowork'}` : '.ash-chat-view-pane .ash-chat:visible');
			const transcript = chat.locator('.ash-chat-list-widget, .ash-cowork-list-widget');
			const composer = chat.locator('.ash-chat-input-part');
			const draft = composer.locator('.stanza-editor-input');
			await expect(chat).toHaveAttribute('data-thread-id', root);
			await expect(transcript).toContainText('Request action answer 1');
			await draft.focus();
			await page.keyboard.insertText('Unsent original draft');
			await chat.getByRole('button', { name: 'Edit message', exact: true }).click();
			const edit = chat.getByRole('textbox', { name: 'Edit request', exact: true });
			await expect(edit).toHaveValue('Original request');
			await edit.fill('Edited request');
			await edit.press('ControlOrMeta+Enter');
			await expect(chat).not.toHaveAttribute('data-thread-id', root);
			await expect(chat).toHaveAttribute('data-thread-id', /.+/u);
			const edited = (await chat.getAttribute('data-thread-id'))!;
			await expect.poll(async () => (await read(edited)).turns.at(-1)?.status).toBe('completed');
			await expect(transcript).toContainText('Edited request');
			await expect(transcript).toContainText('Request action answer 2');
			const replacement = await read(edited);
			expect(replacement.turns.flatMap(turn => turn.items).filter(item => item.type === 'userMessage').map(item => item.text)).toEqual(['Edited request']);
			expect(replacement.turns.flatMap(turn => turn.items).filter(item => item.type === 'userContext').map(item => ({ name: item.name, content: item.content }))).toEqual([{ name: 'Accepted file', content: 'Original immutable context' }]);
			expect((await read(root)).turns.flatMap(turn => turn.items).filter(item => item.type === 'userMessage').map(item => item.text)).toEqual(['Original request']);
			const beforeNewChat = (await client.request(methods['session/read'], { sessionId })).session.threads.map(thread => thread.threadId);
			await page.locator(agents ? '[data-action-id="sessions.newSession"] button' : '.ash-chat-title-actions .ash-split-action-primary button').click();
			// New opens Code in this workspace; Collab presents the same draft in Cowork.
			if (surface === 'Agents Cowork') await page.locator('[data-action-id="sessions.open.collaboration"] button').click();
			await expect(chat).toHaveAttribute('data-untitled-session-id', /.+/u);
			await expect(composer.locator('.view-lines')).not.toContainText('Unsent original draft');
			expect((await client.request(methods['session/read'], { sessionId })).session.threads.map(thread => thread.threadId)).toEqual(beforeNewChat);
			// History numbers follow the current catalog order, which may put newer chats first.
			const catalog = (await client.request(methods['session/read'], { sessionId })).session;
			const rootIndex = catalog.threads.filter(thread => thread.status === 'active').findIndex(thread => thread.threadId === root);
			expect(rootIndex).toBeGreaterThanOrEqual(0);
			await window.quickaccess.runCommand('workbench.action.chat.showHistory');
			await page.getByRole('option').filter({ has: page.locator('.ash-quick-pick-row-description, .ash-quick-pick-row-detail', { hasText: new RegExp(`(?:^| · )Thread ${rootIndex + 1}(?: · |$)`, 'u') }) }).click();
			await expect(chat).toHaveAttribute('data-thread-id', root);
			await expect(composer.locator('.view-lines')).toContainText('Unsent original draft');
			await window.quickaccess.runCommand('workbench.action.chat.forkConversation');
			await expect(chat).not.toHaveAttribute('data-thread-id', root);
			await expect(chat).toHaveAttribute('data-thread-id', /.+/u);
			const forked = (await chat.getAttribute('data-thread-id'))!;
			const forkedSession = (await chat.getAttribute('data-session-id'))!;
			if (agents) expect(forkedSession).toBe(sessionId);
			else expect(forkedSession).not.toBe(sessionId);
			const fork = await read(forked, forkedSession);
			expect(fork.turns.flatMap(turn => turn.items).filter(item => item.type === 'userMessage').map(item => item.text)).toEqual(['Original request']);
			await expect(transcript).toContainText('Request action answer 1');
			expect(modelCalls).toBe(2);
			await testInfo.attach('request-action-identities.json', { body: JSON.stringify({ surface, sessionId, root, edited, forkedSession, forked, modelCalls }), contentType: 'application/json' });
			await page.screenshot({ path: testInfo.outputPath('request-actions.png') });
		} finally {
			await connection?.close();
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
}
