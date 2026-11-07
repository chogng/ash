import { createServer } from 'node:http';
import { expect, test } from '../../../automation/test.js';
import { Workbench } from '../../../automation/workbench.js';
import { APP_SERVER_METHODS as methods } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

test.use({ gitRepository: true, reportIssueUrl: 'https://github.com/chogng/ash/issues' });

test('IDE archives and unarchives from History with the default labels and preserves the draft', { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ application, webAppServer, workbench, testWorkspace }, testInfo) => {
	test.setTimeout(90_000);
	const page = workbench.page;
	const connection = await connectProfile(application, webAppServer, testWorkspace.directory, page);
	try {
		const { client } = connection;
		const created = await client.request(methods['session/create'], { commandId: 'archive-history-session', kind: 'code', title: 'Archive history fixture', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
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

const requestActionScenarios = {
	history: 'edits requests, starts a new chat and forks history through the owning App Server',
	clipboard: 'copies response selections through the native clipboard and restores its draft',
	checkpoint: 'forks before a request through the owning App Server',
	restore: 'restores a message checkpoint through the owning App Server',
	redo: 'redoes a request from its transcript marker through the owning App Server',
	queue: 'manages queued messages from their transcript rows through the owning App Server',
	turnChanges: 'opens only the captured changes for the selected reply',
};

for (const surface of ['IDE', 'Agents Code', 'Agents Cowork'] as const) for (const scenario of ['history', 'clipboard', 'checkpoint', 'restore', 'redo', 'queue', 'turnChanges'] as const) {
	if ((scenario === 'restore' || scenario === 'redo' || scenario === 'queue' || scenario === 'turnChanges') && surface !== 'IDE') continue;
	test(`${surface} ${requestActionScenarios[scenario]}`, { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ application, target, webAppServer, workbench, testWorkspace }, testInfo) => {
		const clipboardOnly = scenario === 'clipboard';
		const needsCheckpoint = scenario === 'checkpoint' || scenario === 'restore' || scenario === 'redo' || scenario === 'turnChanges';
		const mode = scenario === 'turnChanges' ? 'agent' : 'ask';
		const approvalMode = scenario === 'turnChanges' ? 'bypassPermissions' : 'manual';
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
			if (scenario === 'turnChanges' && (modelCalls === 1 || modelCalls === 3)) {
				const file = modelCalls === 1 ? 'first-turn.txt' : 'second-turn.txt';
				const patch = `*** Begin Patch\n*** Add File: ${file}\n+Captured by ${file}\n*** End Patch`;
				const delta = { tool_calls: [{ index: 0, id: `turn-changes-${modelCalls}`, type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ patch }) } }] };
				response.end(`data: ${JSON.stringify({ id: 'request-actions', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: {"id":"request-actions","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n`);
				return;
			}
			const content = `Request action answer ${scenario === 'turnChanges' ? modelCalls / 2 : modelCalls}\n\nSee **[source.ts](ash-remote://fixture/source.ts)** and [Docs](https://example.com).`;
			response.write(`data: ${JSON.stringify({ id: 'request-actions', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
			if (scenario === 'queue' && modelCalls === 1) return;
			response.end('data: {"id":"request-actions","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
		try {
			const agents = surface !== 'IDE';
			const page = agents ? await workbench.openAgentsWindow(target.kind) : workbench.page;
			const window = new Workbench(page);
			const openCowork = async () => {
				await page.locator('[data-action-id="sessions.activity.more"] button').click();
				await page.getByRole('menuitemradio', { name: 'Collab', exact: true }).click();
			};
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
			const created = await client.request(methods['session/create'], { commandId: 'request-actions-session', kind: 'code', title: 'Request actions source', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
			const sessionId = created.session.sessionId;
			const root = created.session.threads[0].threadId;
			const read = async (threadId: string, owner = sessionId) => (await client.request(methods['session/thread/read'], { sessionId: owner, threadId })).thread;
			const before = await read(root);
			await client.request(methods['session/request'], {
				sessionId, commandId: 'request-actions-turn', request: {
					type: 'startTurn', threadId: root, expectedSequence: before.sequence, mode, approvalMode, model,
					input: [{ type: 'context', name: 'Accepted file', content: 'Original immutable context' }, { type: 'text', text: 'Original request' }],
				}
			});
			if (scenario === 'queue') {
				await expect.poll(() => modelCalls).toBe(1);
				await expect.poll(async () => (await read(root)).turns.at(-1)?.status).toBe('running');
			} else {
				await expect.poll(async () => (await read(root)).turns.at(-1)?.status).toBe('completed');
				await expect.poll(async () => (await client.request(methods['turnChanges/list'], { sessionId, threadId: root })).changeSets.at(-1)?.captureState).toBe('sealed');
			}
			if (needsCheckpoint) {
				const source = await read(root);
				await client.request(methods['session/request'], {
					sessionId, commandId: 'request-actions-follow-up', request: {
						type: 'startTurn', threadId: root, expectedSequence: source.sequence, mode, approvalMode, model,
						input: [{ type: 'text', text: 'Follow-up request' }],
					},
				});
				await expect.poll(async () => (await read(root)).turns.at(-1)?.status).toBe('completed');
				await expect.poll(async () => (await client.request(methods['turnChanges/list'], { sessionId, threadId: root })).changeSets.at(-1)?.captureState).toBe('sealed');
			}
			if (agents) {
				await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
				await page.locator('.ash-sessions-list-item').filter({ hasText: 'Request actions source' }).click();
				if (surface === 'Agents Cowork') await openCowork();
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
			if (scenario === 'turnChanges') {
				const replies = transcript.locator('.ash-chat-item-agentMessage');
				const changes = (answer: number) => replies.filter({ hasText: `Request action answer ${answer}` })
					.getByRole('button', { name: 'Open Turn Changes: 1 file, added 1, removed 0', exact: true });
				const diff = page.locator('.stanza-multi-diff-editor:visible');
				await changes(1).press('Enter');
				await expect(diff).toContainText('Captured by first-turn.txt');
				await expect(diff).not.toContainText('second-turn.txt');
				await changes(2).click();
				await expect(diff).toContainText('Captured by second-turn.txt');
				await expect(diff).not.toContainText('first-turn.txt');
				return;
			}
			if (scenario === 'queue') {
				await draft.focus();
				await page.keyboard.insertText('Keep this unsent draft');
				const queued = async (commandId: string) => (await client.request(methods['queue/list'], { sessionId, threadId: root })).messages.find(message => message.request.commandId === commandId);
				for (const [commandId, text] of [['queue-edit', 'Edit this queued request'], ['queue-remove', 'Remove this queued request'], ['queue-send', 'Send this queued request']]) {
					await client.request(methods['queue/enqueue'], { sessionId, threadId: root, commandId, mode: 'ask', approvalMode: 'manual', model, input: [{ type: 'text', text }] });
				}
				const row = (text: string) => transcript.locator('.ash-chat-item-queuedMessage').filter({ hasText: text });
				await row('Edit this queued request').getByRole('button', { name: 'Edit queued message', exact: true }).press('Enter');
				const editor = page.getByRole('textbox', { name: 'Edit queued message', exact: true });
				await expect(editor).toHaveValue('Edit this queued request');
				await expect.poll(async () => (await queued('queue-edit'))?.status).toBe('paused');
				await editor.press('Escape');
				await expect.poll(async () => (await queued('queue-edit'))?.status).toBe('pending');
				await row('Remove this queued request').getByRole('button', { name: 'Remove queued message', exact: true }).click();
				await expect.poll(async () => (await queued('queue-remove'))?.status).toBe('cancelled');
				await expect(row('Remove this queued request')).toHaveCount(0);
				await row('Send this queued request').getByRole('button', { name: 'Send queued message immediately', exact: true }).click();
				await expect.poll(async () => (await queued('queue-send'))?.status).toBe('started');
				await expect(row('Send this queued request')).toHaveCount(0);
				await expect(composer.locator('.view-lines')).toHaveText('Keep this unsent draft');
				return;
			}
			if (scenario === 'redo') {
				await expect(transcript).toContainText('Follow-up request');
				const redo = transcript.getByRole('button', { name: 'Redo last request', exact: true });
				await expect(redo).toHaveCount(0);
				await window.quickaccess.runCommand('workbench.action.chat.undoEdit');
				await expect(transcript).not.toContainText('Follow-up request');
				await redo.press('Enter');
				await expect(transcript).toContainText('Follow-up request');
				await expect(redo).toHaveCount(0);
				expect((await read(root)).turns).toHaveLength(2);
				expect(modelCalls).toBe(2);
				const reply = transcript.locator('.ash-chat-item-agentMessage').filter({ hasText: 'Request action answer 1' });
				await reply.getByRole('button', { name: 'Give model feedback', exact: true }).click();
				const reporter = page.locator('.ash-issue-reporter');
				await expect(reporter).toBeVisible({ timeout: 30_000 });
				await expect(reporter.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(`Model feedback: ${model.model}`);
				await expect(reporter.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue(new RegExp(`Connection: ${provider}`, 'u'));
				return;
			}
			if (needsCheckpoint) {
				const messages = transcript.locator('.ash-chat-user-message');
				const action = { name: scenario === 'restore' ? 'Restore checkpoint' : 'Fork conversation from this point', exact: true };
				const initial = messages.filter({ hasText: 'Original request' });
				await expect(initial).toBeVisible();
				await expect(initial.getByRole('button', action)).toHaveCount(0);
				const button = messages.filter({ hasText: 'Follow-up request' }).getByRole('button', action);
				if (scenario === 'restore') {
					await button.press('Enter');
					const picker = page.getByRole('combobox', { name: 'Choose a checkpoint to restore into a new chat' });
					await picker.fill('Before this message');
					await picker.press('Enter');
				} else if (surface === 'Agents Code') {
					await button.press('Alt+Enter');
				} else {
					await button.click();
				}
				await expect(chat).not.toHaveAttribute('data-thread-id', root);
				await expect(chat).toHaveAttribute('data-session-id', sessionId);
				const branch = (await chat.getAttribute('data-thread-id'))!;
				const userMessages = (thread: Awaited<ReturnType<typeof read>>) => thread.turns.flatMap(turn => turn.items).filter(item => item.type === 'userMessage').map(item => item.text);
				expect(userMessages(await read(branch))).toEqual(['Original request']);
				expect(userMessages(await read(root))).toEqual(['Original request', 'Follow-up request']);
				expect(modelCalls).toBe(2);
				if (surface === 'Agents Code') await expect(page.locator(`.ash-sessions-chat-slot:visible .ash-chat[data-thread-id="${root}"]`)).toBeVisible();
				return;
			}
			await draft.focus();
			await page.keyboard.insertText('Unsent original draft');
			if (!clipboardOnly) {
				// Both command-palette and transcript shortcuts return to this composer's draft.
				await window.quickaccess.runCommand('workbench.action.chat.focusInput');
				await expect(draft).toBeFocused();
				await transcript.getByRole('button', { name: 'Copy message', exact: true }).first().focus();
				await page.keyboard.press('ControlOrMeta+ArrowDown');
				await expect(draft).toBeFocused();
			}
			if (!('windows' in application)) await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
			const previousClipboard = 'windows' in application
				? await application.evaluate(({ clipboard }) => clipboard.readText())
				: await page.evaluate(() => navigator.clipboard.readText());
			try {
				const responseActions = transcript.getByRole('toolbar', { name: 'Response actions', exact: true });
				await responseActions.getByRole('button', { name: 'Copy message', exact: true }).press('Enter');
				await expect.poll(async () => 'windows' in application
					? application.evaluate(({ clipboard }) => clipboard.readText())
					: page.evaluate(() => navigator.clipboard.readText())).toBe('Request action answer 1\n\nSee **`source.ts`** and [Docs](https://example.com).');
				await window.quickaccess.runCommand('workbench.action.chat.copyAll');
				const copied = 'windows' in application
					? await application.evaluate(({ clipboard }) => clipboard.readText())
					: await page.evaluate(() => navigator.clipboard.readText());
				expect(copied).toBe('User: Original request\n\nAssistant: Request action answer 1\n\nSee **`source.ts`** and [Docs](https://example.com).');
				await expect(composer.locator('.view-lines')).toContainText('Unsent original draft');
				const paragraph = transcript.locator('.ash-chat-markdown-part p').filter({ hasText: 'See source.ts and Docs.' });
				const selected = await paragraph.evaluate(element => {
					(element.closest<HTMLElement>('[data-item-id]'))!.focus();
					const range = element.ownerDocument.createRange();
					range.selectNodeContents(element);
					const selection = element.ownerDocument.defaultView!.getSelection()!;
					selection.removeAllRanges();
					selection.addRange(range);
					return { text: selection.toString(), active: element.ownerDocument.activeElement?.className, userSelect: getComputedStyle(element).userSelect, hasFocus: element.ownerDocument.hasFocus() };
				});
				await testInfo.attach('clipboard-selection.json', { body: JSON.stringify(selected), contentType: 'application/json' });
				expect(selected.userSelect).toBe('text');
				expect(selected.text).toBe('See source.ts and Docs.');
				await page.keyboard.press('ControlOrMeta+c');
				await expect.poll(async () => 'windows' in application
					? application.evaluate(({ clipboard }) => clipboard.readText())
					: page.evaluate(() => navigator.clipboard.readText())).toBe('See source.ts and Docs.');
				await draft.focus();
				await page.keyboard.press('ControlOrMeta+a');
				await page.keyboard.press('ControlOrMeta+v');
				await expect(composer.locator('.view-lines')).toHaveText('See **`source.ts`** and [Docs](https://example.com).');
				await page.keyboard.press('ControlOrMeta+z');
				await expect(composer.locator('.view-lines')).toHaveText('Unsent original draft');
				expect(modelCalls).toBe(1);
			} finally {
				if ('windows' in application) await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), previousClipboard);
				else await page.evaluate(text => navigator.clipboard.writeText(text), previousClipboard);
			}
			if (clipboardOnly) { return; }
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
			if (surface === 'Agents Cowork') await openCowork();
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
