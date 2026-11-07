import { createServer } from 'node:http';
import { expect, test } from '../../../automation/test.js';
import { Workbench } from '../../../automation/workbench.js';
import { APP_SERVER_METHODS as methods } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';
import { parseOpenSessionLinkUri } from '../../../../src/ash/platform/agentHost/common/openSessionLink.js';
import { URI } from '../../../../src/ash/base/common/uri.js';

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
	reply: 'shares and forks from the native reply toolbar',
	restore: 'restores a message checkpoint through the owning App Server',
	redo: 'redoes a request from its transcript marker through the owning App Server',
	queue: 'manages queued messages from their transcript rows through the owning App Server',
	turnChanges: 'opens only the captured changes for the selected reply',
	versions: 'reruns a request from its Git checkpoint and compares both results',
};

for (const surface of ['IDE', 'Agents Code', 'Agents Cowork', 'Ash Chat'] as const) for (const scenario of ['history', 'clipboard', 'checkpoint', 'reply', 'restore', 'redo', 'queue', 'turnChanges', 'versions'] as const) {
	if ((scenario === 'restore' || scenario === 'redo' || scenario === 'queue') && surface !== 'IDE') continue;
	if (scenario === 'turnChanges' && surface !== 'IDE' && surface !== 'Agents Code') continue;
	if (scenario === 'versions' && surface !== 'Agents Code') continue;
	const ashChat = surface === 'Ash Chat';
	if (scenario === 'reply' ? surface !== 'Agents Code' && !ashChat : ashChat) continue;
	test(`${surface} ${requestActionScenarios[scenario]}`, { tag: ashChat ? ['@electron-app-server'] : ['@electron-app-server', '@browser-app-server'] }, async ({ application, target, webAppServer, workbench, testWorkspace }, testInfo) => {
		const clipboardOnly = scenario === 'clipboard';
		const writesFiles = scenario === 'turnChanges' || scenario === 'versions';
		const needsCheckpoint = scenario === 'checkpoint' || scenario === 'reply' || scenario === 'restore' || scenario === 'redo' || writesFiles;
		const mode = writesFiles ? 'agent' : 'ask';
		const approvalMode = writesFiles ? 'bypassPermissions' : 'manual';
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
			if (writesFiles && modelCalls % 2 === 1) {
				const file = scenario === 'versions' && modelCalls !== 3 ? 'version.txt' : modelCalls === 1 ? 'first-turn.txt' : 'second-turn.txt';
				const line = scenario === 'versions' ? `Result from run ${Math.ceil(modelCalls / 2)}` : `Captured by ${file}`;
				const patch = `*** Begin Patch\n*** Add File: ${file}\n+${line}\n*** End Patch`;
				const delta = { tool_calls: [{ index: 0, id: `turn-changes-${modelCalls}`, type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ patch }) } }] };
				response.end(`data: ${JSON.stringify({ id: 'request-actions', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: {"id":"request-actions","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n`);
				return;
			}
			const content = `Request action answer ${writesFiles ? modelCalls / 2 : modelCalls}\n\nSee **[source.ts](ash-remote://fixture/source.ts)** and [Docs](https://example.com).`;
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
			const created = await client.request(methods['session/create'], { commandId: 'request-actions-session', kind: ashChat ? 'chat' : 'code', title: 'Request actions source', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
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
			if (ashChat) {
				await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
				await page.locator(`.ash-chat-navigation [data-item="ash:${sessionId}"] .ash-sessions-list-item`).click();
			} else if (agents) {
				await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
				await page.locator('.ash-sessions-list-item').filter({ hasText: 'Request actions source' }).click();
				if (surface === 'Agents Cowork') await openCowork();
			} else {
				await window.quickaccess.runCommand('workbench.action.chat.open');
				if (!await page.locator('.ash-chat-sessions-sidebar').isVisible()) await window.quickaccess.runCommand('agentSessions.toggleAgentSessionsSidebar');
				await page.locator('.ash-chat-sessions-sidebar .ash-agent-session-row').filter({ hasText: 'Request actions source' }).click();
			}
			const chat = page.locator(ashChat ? '.ash-native-chat-widget .ash-chat'
				: agents ? `.ash-sessions-chat-slot.active:visible ${surface === 'Agents Code' ? '.ash-chat' : '.ash-cowork'}` : '.ash-chat-view-pane .ash-chat:visible');
			const transcript = chat.locator('.ash-chat-list-widget, .ash-cowork-list-widget');
			const composer = chat.locator('.ash-chat-input-part');
			const draft = composer.locator('.stanza-editor-input');
			const checkReplyModelFeedback = async () => {
				const reply = transcript.locator('.ash-chat-item-agentMessage').filter({ hasText: 'Request action answer 1' });
				await window.menus.select(application, () => reply.getByRole('button', { name: 'More Actions', exact: true }).click(), ['Give model feedback']);
				const reporter = page.locator('.ash-issue-reporter');
				await expect(reporter).toBeVisible({ timeout: 30_000 });
				await expect(reporter.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(`Model feedback: ${model.model}`);
				await expect(reporter.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue(new RegExp(`Connection: ${provider}`, 'u'));
			};
			await expect(chat).toHaveAttribute('data-thread-id', root);
			await expect(transcript).toContainText('Request action answer 1');
			if (scenario === 'versions') {
				const request = transcript.locator('.ash-chat-item-userMessage').filter({ hasText: 'Original request' });
				const reply = (answer: number) => transcript.locator('.ash-chat-item-agentMessage').filter({ hasText: `Request action answer ${answer}` });
				const openReplyMenu = (answer: number) => reply(answer).getByRole('button', { name: 'More Actions', exact: true }).click();
				expect((await window.menus.inspect(application, () => openReplyMenu(1))).map(item => item.label)).not.toContain('Compare results');
				const source = await read(root);
				const rootDirectory = (await client.request(methods['session/thread/read'], { sessionId, threadId: root })).directory;
				const checkpointMenu = request.getByRole('toolbar', { name: 'Request checkpoint actions', exact: true });
				await window.menus.select(application, () => checkpointMenu.getByRole('button', { name: 'More Actions', exact: true }).press('Enter'), ['Run another version']);
				await expect(chat).not.toHaveAttribute('data-thread-id', root);
				await chat.getByRole('button', { name: 'Approve once', exact: true }).click();
				await expect(transcript).toContainText('Request action answer 3');
				await expect(transcript).not.toContainText('Follow-up request');
				const alternateId = (await chat.getAttribute('data-thread-id'))!;
				const alternate = await client.request(methods['session/thread/read'], { sessionId, threadId: alternateId });
				expect(alternate.thread.origin).toMatchObject({ type: 'rewind', parentThreadId: root, beforeTurnId: source.turns[0].turnId });
				expect(alternate.directory).not.toEqual(rootDirectory);
				expect(alternate.thread.turns).toHaveLength(1);
				expect(alternate.thread.turns[0].items).toEqual(expect.arrayContaining([
					expect.objectContaining({ type: 'userMessage', text: 'Original request' }),
					expect.objectContaining({ type: 'userContext', content: 'Original immutable context' }),
				]));
				expect(await read(root)).toMatchObject({ sequence: source.sequence, turns: source.turns });
				await expect.poll(async () => (await client.request(methods['turnChanges/list'], { sessionId, threadId: alternateId })).changeSets.at(-1)?.captureState).toBe('sealed');
				await expect.poll(async () => (await window.menus.inspect(application, () => openReplyMenu(3))).map(item => item.label)).toContain('Compare results');
				await window.menus.select(application, () => openReplyMenu(3), ['Compare results']);
				const diff = page.locator('.stanza-multi-diff-editor:visible');
				await expect(diff).toContainText('version.txt');
				await expect(diff).toContainText('Result from run 1');
				await expect(diff).toContainText('Result from run 3');
				await expect(diff).not.toContainText('second-turn.txt');
				expect(modelCalls).toBe(6);
				return;
			}
			if (scenario === 'reply') {
				await expect(transcript).toContainText('Request action answer 2');
				const reply = transcript.locator('.ash-chat-item-agentMessage').filter({ hasText: 'Request action answer 1' });
				const toolbar = reply.getByRole('toolbar', { name: 'Response actions', exact: true });
				await expect(toolbar.getByRole('button', { name: 'Copy message', exact: true })).toBeVisible();
				await expect(toolbar.getByRole('button', { name: /ChatGPT/u })).toHaveCount(0);
				if ('windows' in application) await expect(toolbar.getByRole('button', { name: 'Read aloud', exact: true })).toBeVisible();
				else await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
				const readClipboard = () => 'windows' in application
					? application.evaluate(({ clipboard }) => clipboard.readText())
					: page.evaluate(() => navigator.clipboard.readText());
				const previousClipboard = await readClipboard();
				try {
					await toolbar.getByRole('button', { name: 'Copy Conversation Link', exact: true }).press('Enter');
					await expect.poll(async () => {
						const link = await readClipboard();
						return link.startsWith('agent-host-session:') ? parseOpenSessionLinkUri(URI.parse(link)) : undefined;
					}).toMatchObject({ sessionId, threadId: root });
				} finally {
					if ('windows' in application) await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), previousClipboard);
					else await page.evaluate(text => navigator.clipboard.writeText(text), previousClipboard);
				}
				const openMore = () => toolbar.getByRole('button', { name: 'More Actions', exact: true }).click();
				expect((await window.menus.inspect(application, openMore)).map(item => item.label)).toEqual([
					'Fork from this reply', 'Good response', 'Bad response', 'Give model feedback',
				]);
				await window.menus.select(application, openMore, ['Good response']);
				expect((await window.menus.inspect(application, openMore)).find(item => item.label === 'Good response')).toMatchObject({ checked: true });
				await window.menus.select(application, openMore, ['Bad response']);
				const voted = await window.menus.inspect(application, openMore);
				expect(voted.find(item => item.label === 'Good response')).toMatchObject({ checked: false });
				expect(voted.find(item => item.label === 'Bad response')).toMatchObject({ checked: true });
				await window.menus.select(application, openMore, ['Fork from this reply']);
				await expect(chat).not.toHaveAttribute('data-thread-id', root);
				await expect(chat).toHaveAttribute('data-thread-id', /.+/u);
				await expect(chat).toHaveAttribute('data-session-id', sessionId);
				const fork = (await read((await chat.getAttribute('data-thread-id'))!)).turns;
				expect(fork).toHaveLength(1);
				expect(fork[0].items).toEqual(expect.arrayContaining([
					expect.objectContaining({ type: 'agentMessage', text: expect.stringContaining('Request action answer 1') }),
				]));
				expect((await read(root)).turns).toHaveLength(2);
				expect(modelCalls).toBe(2);
				return;
			}
			if (scenario === 'turnChanges') {
				const replies = transcript.locator('.ash-chat-item-agentMessage');
				const openTurnChanges = async (answer: 1 | 2) => {
					if (agents) {
						await chat.locator('summary[aria-label="Show prompts"]').press('Enter');
						const name = answer === 1 ? /^View turn changes for Original request/u : /^View turn changes for Follow-up request/u;
						await chat.getByRole('button', { name }).click();
					} else {
						await replies.filter({ hasText: `Request action answer ${answer}` })
							.getByRole('button', { name: 'Open Turn Changes: 1 file, added 1, removed 0', exact: true }).press('Enter');
					}
				};
				const diff = page.locator(agents ? '.ash-sessions-changes-editor:visible .stanza-multi-diff-editor' : '.stanza-multi-diff-editor:visible');
				await openTurnChanges(1);
				await expect(diff).toContainText('Captured by first-turn.txt');
				await expect(diff).not.toContainText('second-turn.txt');
				await openTurnChanges(2);
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
				await checkReplyModelFeedback();
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
				await expect(responseActions.getByRole('button', { name: 'Open conversation in ChatGPT', exact: true })).toHaveCount(0);
				await expect(responseActions.getByRole('button', { name: 'Share ChatGPT response', exact: true })).toHaveCount(0);
				const copyMessage = responseActions.getByRole('button', { name: 'Copy message', exact: true });
				await copyMessage.press('Enter');
				await expect(copyMessage.locator('[data-ash-icon-id="check"]')).toBeVisible();
				await expect.poll(async () => 'windows' in application
					? application.evaluate(({ clipboard }) => clipboard.readText())
					: page.evaluate(() => navigator.clipboard.readText())).toBe('Request action answer 1\n\nSee **`source.ts`** and [Docs](https://example.com).');
				await window.quickaccess.runCommand('workbench.action.chat.copyAll');
				await expect.poll(async () => 'windows' in application
					? await application.evaluate(({ clipboard }) => clipboard.readText())
					: await page.evaluate(() => navigator.clipboard.readText())).toBe('User: Original request\n\nAssistant: Request action answer 1\n\nSee **`source.ts`** and [Docs](https://example.com).');
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
			if (clipboardOnly) {
				if (surface === 'Agents Code') await checkReplyModelFeedback();
				return;
			}
			await chat.getByRole('button', { name: 'Edit message', exact: true }).click();
			const edit = chat.getByRole('textbox', { name: 'Edit request', exact: true });
			await expect(edit).toHaveValue('Original request');
			await edit.fill('Edited request');
			await chat.getByRole('button', { name: 'Send edited request', exact: true }).click();
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
