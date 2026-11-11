import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { expect, test } from '../../../automation/test.js';
import { Workbench } from '../../../automation/workbench.js';
import { APP_SERVER_METHODS as methods } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

test.use({ gitRepository: true });

test('Agents Code reorders durable queued messages with the keyboard and by dragging', { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ application, target, webAppServer, workbench, testWorkspace }) => {
	const model = { provider: 'custom-reorder-queue-fixture', model: 'reorder-queue-model' };
	const server = createServer((request, response) => {
		if (request.method === 'GET') {
			response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: model.model }] }));
			return;
		}
		request.resume();
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		response.write('data: {"choices":[{"index":0,"delta":{"content":"Queue fixture is running."}}]}\n\n');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		const page = await workbench.openAgentsWindow(target.kind);
		connection = await connectProfile(application, webAppServer, testWorkspace.directory, page);
		const { client } = connection;
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Missing queue fixture port');
		const config = await client.request(methods['config/read'], {});
		await client.request(methods['provider/configure'], {
			commandId: 'reorder-queue-provider', expectedRevision: config.revision, config: {
				connection: model.provider, provider: model.provider, baseUrl: `http://127.0.0.1:${address.port}/v1`,
				custom: { name: 'Queue reorder fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 },
				modelContext: { [model.model]: { contextWindow: 272_000 } },
			},
		});
		await client.request(methods['provider/apiKey/set'], { connection: model.provider, apiKey: 'isolated-queue-key' });
		const { session } = await client.request(methods['session/create'], {
			commandId: 'reorder-queue-session', kind: 'code', title: 'Reorder queue fixture', agent: { type: 'default' },
			executionTarget: { type: 'local', root: testWorkspace.directory },
		});
		const sessionId = session.sessionId;
		const threadId = session.threads[0]!.threadId;
		const read = async () => (await client.request(methods['session/thread/read'], { sessionId, threadId })).thread;
		const queue = async () => (await client.request(methods['queue/list'], { sessionId, threadId })).messages;
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'Reorder queue fixture' }).click();
		const chat = page.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
		await expect(chat).toHaveAttribute('data-thread-id', threadId);
		await client.request(methods['session/request'], {
			commandId: 'reorder-queue-active', sessionId, request: {
				type: 'startTurn', threadId, expectedSequence: (await read()).sequence, mode: 'ask', model,
				input: [{ type: 'text', text: 'Wait for pending queue fixtures.' }],
			},
		});
		await expect(chat).toContainText('Queue fixture is running.');
		for (const [commandId, text] of [['queue-first', 'First queued fixture'], ['queue-second', 'Second queued fixture']]) {
			await client.request(methods['queue/enqueue'], {
				commandId, sessionId, threadId, mode: 'ask', model,
				input: [{ type: 'text', text }, { type: 'context', name: 'Frozen context', content: 'Keep these bytes.' }],
			});
		}
		const original = await queue();
		const rows = chat.locator('[data-item-id^="queue:"]');
		const first = rows.filter({ hasText: 'First queued fixture' });
		const second = rows.filter({ hasText: 'Second queued fixture' });
		const reorder = first.getByRole('button', { name: 'Reorder queued message', exact: true });
		const order = async () => (await queue()).map(message => message.request.commandId);
		await expect(rows.first()).toContainText('First queued fixture');
		await reorder.press('Enter');
		await page.getByRole('menuitem', { name: 'Move later', exact: true }).press('Enter');
		await expect.poll(order).toEqual(['queue-second', 'queue-first']);
		await expect(rows.first()).toContainText('Second queued fixture');
		await reorder.dragTo(second);
		await expect.poll(order).toEqual(['queue-first', 'queue-second']);
		await expect(rows.first()).toContainText('First queued fixture');
		expect((await queue()).map(message => message.request)).toEqual(original.map(message => message.request));
	} finally {
		await connection?.close();
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

test('Agents Code sends Auto through the App Server and records the default fallback', { tag: ['@electron-app-server'] }, async ({ application, target, webAppServer, workbench, testWorkspace }) => {
	const provider = 'custom-auto-routing-fixture';
	const model = { provider, model: 'auto-routing-fixture' };
	const requests: string[] = [];
	const server = createServer(async (request, response) => {
		if (request.method === 'GET') {
			response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: model.model }] }));
			return;
		}
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		requests.push(body.model);
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		response.end('data: {"id":"auto","choices":[{"index":0,"delta":{"content":"Automatic reply"},"finish_reason":null}]}\n\ndata: {"id":"auto","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		const page = await workbench.openAgentsWindow(target.kind);
		connection = await connectProfile(application, webAppServer, testWorkspace.directory, page);
		const { client } = connection;
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Missing Auto routing fixture port');
		const config = await client.request(methods['config/read'], {});
		await client.request(methods['provider/configure'], {
			commandId: 'auto-routing-provider', expectedRevision: config.revision, config: {
				connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`,
				custom: { name: 'Auto routing fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 },
				modelContext: { [model.model]: { contextWindow: 272_000 } },
			}
		});
		await client.request(methods['provider/apiKey/set'], { connection: provider, apiKey: 'isolated-auto-routing-key' });
		const configured = await client.request(methods['config/read'], {});
		await client.request(methods['config/update'], { commandId: 'auto-routing-default', expectedRevision: configured.revision, model });
		const created = await client.request(methods['session/create'], {
			commandId: 'auto-routing-session', kind: 'code', title: 'Auto routing conversation', agent: { type: 'default' },
			executionTarget: { type: 'local', root: testWorkspace.directory }
		});
		const { sessionId, threads: [{ threadId }] } = created.session;
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'Auto routing conversation' }).click();
		const chat = page.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
		await expect(chat).toHaveAttribute('data-thread-id', threadId);
		await new Workbench(page).quickaccess.runCommand('workbench.action.chat.openModelPicker');
		const auto = page.getByRole('dialog', { name: 'Choose a chat model' }).getByRole('switch', { name: 'Auto', exact: true });
		if (!await auto.isChecked()) await auto.press('Space');
		await expect(auto).toBeChecked();
		await page.keyboard.press('Escape');
		await chat.locator('.stanza-editor-input').focus();
		await page.keyboard.insertText('Use automatic routing');
		await page.keyboard.press('Enter');
		await expect.poll(async () => (await client.request(methods['session/thread/read'], { sessionId, threadId })).thread.turns[0]).toMatchObject({
			status: 'completed', modelRouting: 'fallback', model,
		});
		expect(requests).toEqual([model.model]);
	} finally {
		await connection?.close();
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

for (const surface of ['IDE', 'Agents Code', 'Agents Cowork'] as const) {
	test(`${surface} sends, queues, steers and stops through the owning execution model`, { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ application, target, webAppServer, workbench, testWorkspace }, testInfo) => {
		test.setTimeout(180_000);
		const controlledReply = 'Controlled execution is running.\n\n```ts\nconst codeBlockFixture = 1;\n```\n\n```ts\nconst codeBlockFixture = 2;\n```';
		const streams = new Map<ServerResponse, boolean>();
		let releaseInitial = false;
		let calls = 0;
		const finish = (response: ServerResponse): void => {
			response.end('data: {"id":"execution","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
		};
		const server = createServer(async (request, response) => {
			if (request.method === 'GET') {
				response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'execution-model' }] }));
				return;
			}
			let body = '';
			for await (const chunk of request) { body += chunk.toString(); }
			const queued = body.includes('execution-queued-fixture');
			calls++;
			streams.set(response, queued);
			response.once('close', () => streams.delete(response));
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.write(`data: ${JSON.stringify({ id: 'execution', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: controlledReply }, finish_reason: null }] })}\n\n`);
			if (body.includes('side-question-fixture') || releaseInitial && !queued) finish(response);
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
			if (!address || typeof address === 'string') throw new Error('Missing execution fixture port');
			const provider = 'custom-execution-fixture';
			const model = { provider, model: 'execution-model' };
			const config = await client.request(methods['config/read'], {});
			await client.request(methods['provider/configure'], {
				commandId: 'execution-provider', expectedRevision: config.revision, config: {
					connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`,
					custom: { name: 'Execution fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 },
					modelContext: { [model.model]: { contextWindow: 272_000 } },
				}
			});
			await client.request(methods['provider/apiKey/set'], { connection: provider, apiKey: 'isolated-execution-key' });
			const configured = await client.request(methods['config/read'], {});
			await client.request(methods['config/update'], { commandId: 'execution-default-model', expectedRevision: configured.revision, model });
			const created = await client.request(methods['session/create'], { commandId: 'execution-session', kind: 'code', title: 'Execution queue conversation', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
			const sessionId = created.session.sessionId;
			const threadId = created.session.threads[0].threadId;
			const read = async () => (await client.request(methods['session/thread/read'], { sessionId, threadId })).thread;
			const queued = async () => (await client.request(methods['queue/list'], { sessionId, threadId })).messages;
			if (agents) {
				await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
				await page.locator('.ash-sessions-list-item').filter({ hasText: 'Execution queue conversation' }).click();
				if (surface === 'Agents Cowork') await page.locator('[data-action-id="sessions.open.collaboration"] button').click();
			} else {
				const closeWelcome = page.getByRole('button', { name: 'Close Agent Sessions Welcome', exact: true });
				if (await closeWelcome.isVisible()) await closeWelcome.click();
				await window.quickaccess.runCommand('workbench.action.chat.open');
				await page.locator('[data-action-id="workbench.action.chat.showHistory"] button').click();
				await page.getByRole('option').filter({ hasText: 'Execution queue conversation' }).click();
			}
			const chat = page.locator(agents ? `.ash-sessions-chat-slot.active:visible ${surface === 'Agents Code' ? '.ash-chat' : '.ash-native-chat'}` : '.ash-chat-view-pane .ash-chat:visible');
			const composer = chat.locator('.ash-chat-input-part');
			const draft = composer.locator('.stanza-editor-input');
			await expect(chat).toHaveAttribute('data-thread-id', threadId);
			await draft.focus();
			await page.keyboard.insertText('Preserve picker draft');
			await window.quickaccess.runCommand('workbench.action.chat.configureTools');
			const toolPicker = page.getByRole('dialog');
			await expect(toolPicker.getByRole('tree')).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(toolPicker).toBeHidden();
			await expect(composer.locator('.view-lines')).toContainText('Preserve picker draft');
			await window.quickaccess.runCommand('workbench.action.chat.openModelPicker');
			const models = page.getByRole('dialog', { name: 'Choose a chat model' });
			await expect(models).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(models).toBeHidden();
			await draft.focus();
			await page.keyboard.press('ControlOrMeta+Alt+.');
			await expect(models).toBeVisible();
			await page.keyboard.press('Escape');
			await draft.focus();
			await page.keyboard.press('ControlOrMeta+.');
			const modes = page.locator('.ash-chat-input-mode-menu');
			if (surface === 'Agents Cowork') {
				await expect(modes).toBeHidden();
			} else {
				await expect(modes).toBeVisible();
				await modes.getByRole('menuitemradio', { name: 'Ask', exact: true }).click();
				await expect(modes).toBeHidden();
				await draft.focus();
				await window.quickaccess.runCommand('workbench.action.chat.openModePicker');
				await expect(modes.getByRole('menuitemradio', { name: 'Ask', exact: true })).toHaveAttribute('aria-checked', 'true');
				await page.keyboard.press('Escape');
			}
			await draft.focus();
			await window.quickaccess.runCommand('workbench.action.chat.openPermissionPicker');
			if (surface === 'Agents Cowork') await page.getByRole('option').filter({ has: page.locator('.ash-quick-pick-row-label').getByText('Auto', { exact: true }) }).click();
			else await page.getByRole('menuitemradio', { name: 'Auto', exact: true }).click();
			await expect(composer.locator('.view-lines')).toContainText('Preserve picker draft');
			expect((await read()).turns).toHaveLength(0);
			expect(calls).toBe(0);
			await draft.focus();
			await page.keyboard.press('ControlOrMeta+A');
			await page.keyboard.press('Backspace');

			const send = async (text: string, command: string): Promise<void> => {
				await draft.focus();
				await page.keyboard.insertText(text);
				await window.quickaccess.runCommand(command);
				await expect(composer.locator('.view-lines')).not.toContainText(text);
			};
			await send('execution-active-fixture', 'workbench.action.chat.submit');
			await expect.poll(async () => (await read()).turns.at(-1)?.status).toBe('running');
			await expect.poll(() => calls).toBe(1);
			const initialTurn = (await read()).turns.at(-1)!;
			expect(initialTurn.mode).toBe(surface === 'Agents Cowork' ? 'agent' : 'ask');
			expect(initialTurn.approvalMode).toBe('auto');
			await expect(chat.locator('.ash-chat-list-widget, .ash-native-chat-list-widget')).toContainText('Controlled execution is running.');
			await window.quickaccess.runCommand('workbench.action.chat.nextCodeBlock');
			const codeInputs = chat.locator('.ash-chat-code-block .stanza-editor-input');
			await expect(codeInputs.nth(0)).toBeFocused();
			await page.keyboard.press('ControlOrMeta+Alt+PageDown');
			await expect(codeInputs.nth(1)).toBeFocused();
			await page.keyboard.press('ControlOrMeta+Alt+PageDown');
			await expect(codeInputs.nth(0)).toBeFocused();
			await page.keyboard.press('ControlOrMeta+Alt+PageUp');
			await expect(codeInputs.nth(1)).toBeFocused();

			// Both public entries create an independent persisted branch while the source stream stays active.
			for (const entry of ['menu', 'slash'] as const) {
				await expect(chat).toHaveClass(/has-conversation/);
				await expect(chat.locator('.ash-chat-list-widget, .ash-native-chat-list-widget')).toContainText('Controlled execution is running.');
				await draft.focus();
				await page.keyboard.insertText(`${entry === 'slash' ? '/btw ' : ''}side-question-fixture ${entry}`);
				if (entry === 'menu') {
					await composer.getByRole('button', { name: 'More Send Options' }).click();
					await page.getByRole('menuitem', { name: 'Ask in Side Chat', exact: true }).click();
				} else {
					await expect(composer.locator('.view-lines')).toContainText('/btw side-question-fixture slash');
					if (!agents) await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
					await page.keyboard.press('Escape');
					await draft.press('Enter');
				}
				try { await expect(chat).not.toHaveAttribute('data-thread-id', threadId); }
				catch (error) {
					await testInfo.attach(`side-${entry}-admission.json`, { body: JSON.stringify({ thread: await read(), session: await client.request(methods['session/read'], { sessionId }), calls }), contentType: 'application/json' });
					throw error;
				}
				const sideThreadId = (await chat.getAttribute('data-thread-id'))!;
				const side = async () => (await client.request(methods['session/thread/read'], { sessionId, threadId: sideThreadId })).thread;
				await expect.poll(async () => (await side()).turns.at(-1)?.status).toBe('completed');
				const child = await side();
				expect(child.origin).toMatchObject({ type: 'sideChat', parentThreadId: threadId, sourceTurnId: initialTurn.turnId });
				expect(child.turns.at(-1)?.items.filter(item => item.type === 'userMessage').map(item => item.text)).toEqual([`side-question-fixture ${entry}`]);
				expect((await read()).turns.map(turn => ({ id: turn.turnId, status: turn.status }))).toEqual([{ id: initialTurn.turnId, status: 'running' }]);
				expect((await read()).turns[0].items.filter(item => item.type === 'userMessage').map(item => item.text)).toEqual(['execution-active-fixture']);
				await expect(chat.locator('.ash-chat-side-chat-origin')).toBeVisible();
				await page.screenshot({ path: testInfo.outputPath(`side-chat-${entry}.png`) });
				await chat.locator('.ash-chat-side-chat-origin').getByRole('button').click();
				await expect(chat).toHaveAttribute('data-thread-id', threadId);
				await expect(chat.locator('.ash-chat-list-widget, .ash-native-chat-list-widget')).toContainText('Controlled execution is running.');
				await expect(composer.locator('.view-lines')).not.toContainText('side-question-fixture');
			}

			await send('execution-queued-fixture', 'workbench.action.chat.queueMessage');
			try {
				await expect.poll(async () => (await queued()).filter(message => message.status === 'pending').length).toBe(1);
			} catch (error) {
				await testInfo.attach('queue-admission.json', { body: JSON.stringify({ thread: await read(), queue: await queued(), calls }), contentType: 'application/json' });
				await page.screenshot({ path: testInfo.outputPath('queue-admission.png') });
				throw error;
			}
			expect((await read()).turns.map(turn => turn.turnId)).toEqual([initialTurn.turnId]);
			await send('execution-steer-fixture', 'workbench.action.chat.steerWithMessage');
			await expect.poll(async () => (await read()).turns[0].items.filter(item => item.type === 'userMessage').map(item => item.text)).toContain('execution-steer-fixture');
			expect((await queued()).filter(message => message.status === 'pending')).toHaveLength(1);
			expect((await read()).turns.map(turn => turn.turnId)).toEqual([initialTurn.turnId]);
			// Only release the first task. The queued task stays in a real provider stream until Stop.
			releaseInitial = true;
			for (const [response, isQueued] of streams) { if (!isQueued) finish(response); }
			await expect.poll(async () => (await read()).turns[0].status).toBe('completed');
			await expect.poll(async () => (await read()).turns.length, { timeout: 30_000 }).toBe(2);
			await expect.poll(async () => (await read()).turns[1].status).toBe('running');
			await expect.poll(async () => (await queued()).map(message => message.status)).toEqual(['started']);
			const active = (await read()).turns[1];
			expect(active.items.filter(item => item.type === 'userMessage').map(item => item.text)).toEqual(['execution-queued-fixture']);
			await draft.focus();
			await page.keyboard.insertText('Keep this unsent execution draft');
			await page.keyboard.press(process.platform === 'win32' ? 'Alt+Backspace' : 'Control+Escape');
			await expect.poll(async () => (await read()).turns[1].status).toBe('interrupted');
			await expect(composer.locator('.view-lines')).toContainText('Keep this unsent execution draft');
			// Seed frozen queue inputs through Core, then manage them through actual commands.
			await expect.poll(async () => (await client.request(methods['turnChanges/list'], { sessionId, threadId })).changeSets.at(-1)?.captureState).toBe('sealed');
			const beforeManagement = await read();
			await client.request(methods['session/request'], {
				sessionId, commandId: 'managed-active', request: {
					type: 'startTurn', threadId, expectedSequence: beforeManagement.sequence, mode: initialTurn.mode, approvalMode: 'manual', model,
					input: [{ type: 'text', text: 'execution-queued-fixture management-active' }],
				}
			});
			await expect.poll(async () => (await read()).turns.at(-1)?.status).toBe('running');
			const managedTurn = (await read()).turns.at(-1)!;
			for (const [commandId, text] of [['managed-edit', 'queue-edit-fixture\noriginal'], ['managed-remove', 'queue-remove-fixture'], ['managed-now', 'execution-queued-fixture immediate'], ['managed-steer-edit', 'queue-switch-fixture']] as const) {
				await client.request(methods['queue/enqueue'], {
					sessionId, threadId, commandId, mode: initialTurn.mode, approvalMode: 'manual', model,
					input: [{ type: 'text', text }, { type: 'context', name: 'Frozen queue context', content: 'Original captured bytes' }, ...(commandId === 'managed-steer-edit' ? [] : [{ type: 'toolSelection' as const, disabled: [] }])],
				});
			}
			const findQueued = async (id: string) => (await queued()).find(message => message.request.commandId === id)!;
			const frozen = await findQueued('managed-edit');
			const order = (await queued()).map(message => message.request.commandId);
			const choose = async (command: string, text: string): Promise<void> => {
				await draft.focus();
				await window.quickaccess.runCommand(command);
				await page.getByRole('option').filter({ hasText: text }).click();
			};
			await choose('workbench.action.chat.editPendingRequest', 'queue-edit-fixture');
			const edit = page.getByRole('textbox', { name: 'Edit queued message', exact: true });
			await expect(edit).toHaveValue('queue-edit-fixture\noriginal');
			await expect(edit).toBeFocused();
			const queueDialog = page.getByRole('dialog', { name: 'Edit queued message', exact: true });
			expect(await queueDialog.evaluate(element => element.matches(':modal'))).toBe(true);
			await page.screenshot({ path: testInfo.outputPath('queue-editor.png') });
			await expect.poll(async () => (await findQueued('managed-edit')).status).toBe('paused');
			await edit.fill('Do not save this text');
			await edit.press('Escape');
			await expect(edit).toBeHidden();
			await expect.poll(async () => (await findQueued('managed-edit')).status).toBe('pending');
			expect((await findQueued('managed-edit')).request).toEqual(frozen.request);
			expect((await queued()).map(message => message.request.commandId)).toEqual(order);
			await choose('workbench.action.chat.editPendingRequest', 'queue-edit-fixture');
			await expect(edit).toBeVisible();
			await edit.fill('execution-queued-fixture edited\nsecond line');
			await edit.press('Enter');
			await expect(edit).toBeHidden();
			const edited = await findQueued('managed-edit');
			expect(edited.revision).toBeGreaterThan(frozen.revision);
			expect(edited.request.input.filter(item => item.type === 'text')).toEqual([{ type: 'text', text: 'execution-queued-fixture edited\nsecond line' }]);
			expect(edited.request.input.filter(item => item.type !== 'text')).toEqual(frozen.request.input.filter(item => item.type !== 'text'));
			await expect(client.request(methods['queue/cancel'], { sessionId, threadId, commandId: 'managed-edit', expectedRevision: frozen.revision })).rejects.toMatchObject({ code: -32122 });
			// The queued editor overrides the global steer default; Alt+Enter explicitly changes delivery.
			await choose('workbench.action.chat.editPendingRequest', 'queue-switch-fixture');
			await expect(edit).toBeVisible();
			await edit.fill('execution-switched-fixture');
			await edit.press('Alt+Enter');
			await expect(edit).toBeHidden();
			try {
				await expect.poll(async () => { const message = await findQueued('managed-steer-edit'); return message.status === 'rejected' ? `rejected: ${message.error}` : message.status; }).toBe('started');
			} catch (error) {
				const path = testInfo.outputPath('queue-steering.json');
				await writeFile(path, JSON.stringify({ message: await findQueued('managed-steer-edit'), thread: await read() }));
				await testInfo.attach('queue-steering.json', { path, contentType: 'application/json' });
				throw error;
			}
			expect((await findQueued('managed-steer-edit')).request.steerTurn).toBe(managedTurn.turnId);
			expect((await findQueued('managed-steer-edit')).request.input.filter(item => item.type !== 'text')).toEqual([{ type: 'context', name: 'Frozen queue context', content: 'Original captured bytes' }]);
			await expect.poll(async () => (await read()).turns.find(turn => turn.turnId === managedTurn.turnId)?.items.filter(item => item.type === 'userMessage').map(item => item.text)).toContain('execution-switched-fixture');
			await choose('workbench.action.chat.removePendingRequest', 'queue-remove-fixture');
			await expect.poll(async () => (await findQueued('managed-remove')).status).toBe('cancelled');
			await expect(composer.locator('.view-lines')).toContainText('Keep this unsent execution draft');
			await choose('workbench.action.chat.sendPendingImmediately', 'execution-queued-fixture immediate');
			await expect.poll(async () => (await read()).turns.find(turn => turn.turnId === managedTurn.turnId)?.status).toBe('interrupted');
			await expect.poll(async () => (await findQueued('managed-now')).status, { timeout: 30_000 }).toBe('started');
			const immediate = await findQueued('managed-now');
			await expect.poll(async () => (await read()).turns.find(turn => turn.turnId === immediate.turnId)?.status).toBe('running');
			expect((await findQueued('managed-edit')).status).toBe('pending');
			expect(immediate.request.commandId).toBe('managed-now');
			await expect(composer.locator('.view-lines')).toContainText('Keep this unsent execution draft');
			await draft.focus();
			await window.quickaccess.runCommand('workbench.action.chat.removeAllPendingRequests');
			await expect.poll(async () => (await findQueued('managed-edit')).status).toBe('cancelled');
			expect((await findQueued('managed-now')).status).toBe('started');
			expect((await read()).turns.find(turn => turn.turnId === immediate.turnId)?.status).toBe('running');
			if (!('windows' in application)) { await page.context().grantPermissions(['clipboard-read', 'clipboard-write']); }
			const previousClipboard = 'windows' in application ? await application.evaluate(({ clipboard }) => clipboard.readText()) : await page.evaluate(() => navigator.clipboard.readText());
			try {
				await window.quickaccess.runCommand('workbench.action.chat.copyFinalResponse');
				await expect.poll(async () => 'windows' in application ? application.evaluate(({ clipboard }) => clipboard.readText()) : page.evaluate(() => navigator.clipboard.readText())).toBe(controlledReply);
			} finally {
				if ('windows' in application) { await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), previousClipboard); }
				else { await page.evaluate(text => navigator.clipboard.writeText(text), previousClipboard); }
			}
			await expect(composer.locator('.view-lines')).toContainText('Keep this unsent execution draft');
			if ('windows' in application) {
				const path = `${testWorkspace.directory}/saved-transcript.json`;
				const originals = await application.evaluateHandle(({ dialog }) => ({ save: dialog.showSaveDialog, open: dialog.showOpenDialog }));
				try {
					await application.evaluate(({ dialog }, filePath) => {
						dialog.showSaveDialog = async () => ({ canceled: false, filePath });
						dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
					}, path);
					await window.quickaccess.runCommand('workbench.action.chat.export');
					await expect.poll(async () => { try { return JSON.parse(await readFile(path, 'utf8')).format; } catch { return undefined; } }).toBe('ash.chat.transcript');
					const saved = JSON.parse(await readFile(path, 'utf8'));
					expect(saved.messages.some((message: { text: string; }) => message.text === controlledReply)).toBe(true);
					await window.quickaccess.runCommand('workbench.action.chat.import');
					await expect(window.editors.element.getByRole('tab', { name: `Saved Chat: ${saved.title}` })).toBeVisible();
					const content = page.getByRole('tabpanel', { name: `Saved Chat: ${saved.title}`, exact: true });
					await expect(content.locator('.stanza-editor-input:visible')).toHaveAttribute('aria-readonly', 'true');
					await expect(content.locator('.view-lines')).toContainText('Controlled execution is running.');
				} finally {
					await application.evaluate(({ dialog }, saved) => { dialog.showSaveDialog = saved.save; dialog.showOpenDialog = saved.open; }, originals);
					await originals.dispose();
				}
			}
			await testInfo.attach('managed-queue.json', { body: JSON.stringify(await queued()), contentType: 'application/json' });
			await testInfo.attach('execution-queue-identities.json', { body: JSON.stringify({ surface, sessionId, threadId, initialTurn: initialTurn.turnId, queuedTurn: active.turnId, calls }), contentType: 'application/json' });
			await page.screenshot({ path: testInfo.outputPath('execution-queue.png') });
		} finally {
			await connection?.close();
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
}
