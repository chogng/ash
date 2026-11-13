import { createServer } from 'node:http';
import { expect, test } from '../../../automation/test.js';
import { APP_SERVER_METHODS as methods } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

test.use({ gitRepository: true });

for (const surface of ['Code', 'native Chat'] as const) {
	test(`${surface} Side Chat preserves source command semantics${surface === 'native Chat' ? ' through slash and send menu' : ' through slash'}`, { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ application, target, webAppServer, workbench, testWorkspace }, testInfo) => {
		test.setTimeout(180_000);
		const model = { provider: 'custom-side-chat-semantics-fixture', model: 'controlled-side-chat-model' };
		const requests: string[] = [];
		const server = createServer(async (request, response) => {
			if (request.method === 'GET') {
				response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: model.model }] }));
				return;
			}
			let body = '';
			for await (const chunk of request) body += chunk.toString();
			requests.push(body);
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			// The first completion belongs to the explicitly submitted source Turn.
			if (requests.length === 1) {
				response.write('data: {"choices":[{"index":0,"delta":{"content":"Synthetic source task remains active."}}]}\n\n');
				return;
			}
			response.end('data: {"choices":[{"index":0,"delta":{"content":"Synthetic side question received."},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
		try {
			const page = await workbench.openAgentsWindow(target.kind);
			connection = await connectProfile(application, webAppServer, testWorkspace.directory, page);
			const { client } = connection;
			const address = server.address();
			if (!address || typeof address === 'string') throw new Error('Missing Side Chat fixture port');
			const config = await client.request(methods['config/read'], {});
			await client.request(methods['provider/configure'], {
				commandId: 'side-chat-semantics-provider', expectedRevision: config.revision, config: {
					connection: model.provider, provider: model.provider, baseUrl: `http://127.0.0.1:${address.port}/v1`,
					custom: { name: 'Side Chat semantics fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 },
					modelContext: { [model.model]: { contextWindow: 272_000 } },
				},
			});
			await client.request(methods['provider/apiKey/set'], { connection: model.provider, apiKey: 'synthetic-side-chat-key' });
			const configured = await client.request(methods['config/read'], {});
			await client.request(methods['config/update'], { commandId: 'side-chat-semantics-model', expectedRevision: configured.revision, model });
			// Deliberately keep a Code Session: the visible input surface owns interpretation.
			const { session } = await client.request(methods['session/create'], {
				commandId: 'side-chat-semantics-session', kind: 'code', title: 'Side Chat command semantics', agent: { type: 'default' },
				executionTarget: { type: 'local', root: testWorkspace.directory },
			});
			const { sessionId, threads: [{ threadId }] } = session;
			const readSource = async () => (await client.request(methods['session/thread/read'], { sessionId, threadId })).thread;
			await client.request(methods['session/request'], { sessionId, commandId: 'side-chat-source-turn', request: { type: 'startTurn', threadId, expectedSequence: (await readSource()).sequence, input: [{ type: 'text', text: 'Synthetic source conversation' }], mode: surface === 'Code' ? 'ask' : 'agent', model } });
			await expect.poll(async () => (await readSource()).turns.at(-1)?.status).toBe('running');
			const source = await readSource();
			await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
			await page.locator('.ash-sessions-list-item').filter({ hasText: session.title }).click();
			if (surface === 'native Chat') {
				await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
				await page.locator('[data-action-id="sessions.activity.more"] button').click();
				await page.getByRole('menuitemradio', { name: 'Collab', exact: true }).click();
			}
			const chat = page.locator(`.ash-sessions-chat-slot.active:visible ${surface === 'Code' ? '.ash-chat' : '.ash-native-chat'}`);
			const composer = chat.locator('.ash-chat-input-part');
			const draft = composer.locator('.stanza-editor-input');
			await expect(chat).toHaveAttribute('data-thread-id', threadId);
			await expect(chat.locator('.ash-chat-list-widget, .ash-native-chat-list-widget')).toContainText('Synthetic source task remains active.');
			const outcomes = [];
			const expectedThreads = [threadId];
			const entries = surface === 'Code' ? ['slash'] as const : ['slash', 'menu'] as const;
			for (const entry of entries) for (const query of ['/init', '/develop synthetic task']) {
				await expect(chat).toHaveAttribute('data-thread-id', threadId);
				await draft.focus();
				await page.keyboard.insertText(`${entry === 'slash' ? '/btw ' : ''}${query}`);
				await page.keyboard.press('Escape');
				// Keep the command first: a prepended file label would itself bypass command selection.
				expect(await draft.evaluate(element => {
					const transfer = new DataTransfer();
					transfer.items.add(new File(['Frozen side question context'], 'side-context.txt', { type: 'text/plain' }));
					const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
					element.dispatchEvent(paste);
					return paste.defaultPrevented;
				})).toBe(true);
				await expect(composer.locator('.ash-chat-code-reference').filter({ hasText: 'side-context.txt' })).toBeVisible();
				await draft.focus();
				if (entry === 'slash') {
					await page.keyboard.press('Escape');
					await draft.press('Enter');
				} else {
					await composer.getByRole('button', { name: 'More Send Options' }).click();
					await page.getByRole('menuitem', { name: 'Ask in Side Chat', exact: true }).click();
				}
				await expect(chat).not.toHaveAttribute('data-thread-id', threadId);
				const sideThreadId = (await chat.getAttribute('data-thread-id'))!;
				const readSide = async () => client.request(methods['session/thread/read'], { sessionId, threadId: sideThreadId });
				await expect.poll(async () => (await readSide()).thread.turns.at(-1)?.status).toBe('completed');
				const { thread: side, directory } = await readSide();
				const turn = side.turns.at(-1)!;
				expectedThreads.push(sideThreadId);
				const currentSession = (await client.request(methods['session/read'], { sessionId })).session;
				expect(currentSession.threads.map(value => value.threadId).sort()).toEqual([...expectedThreads].sort());
				expect(side.agentId).toBe(source.agentId);
				expect(directory?.type).toBe('local');
				expect(turn.directory).toEqual(directory);
				expect(side.origin).toMatchObject({ type: 'sideChat', parentThreadId: threadId, sourceTurnId: source.turns[0].turnId });
				expect(turn.items.filter(item => item.type === 'userMessage').map(item => item.text)).toEqual([`${query} `]);
				expect(turn.items.filter(item => item.type === 'userContext').map(item => ({ name: item.name, content: item.content }))).toContainEqual({ name: 'side-context.txt', content: 'Frozen side question context' });
				expect(turn.mode).toBe(surface === 'Code' ? 'ask' : 'agent');
				// Persisted instruction identity distinguishes /init Setup from ordinary Agent input.
				expect(turn.instructions?.id).toBe(surface === 'Code' && query === '/init' ? 'instructions/init' : source.turns[0].instructions?.id);
				expect(turn.model).toEqual(model);
				expect((await readSource()).turns.map(value => ({ id: value.turnId, status: value.status, messages: value.items.filter(item => item.type === 'userMessage').map(item => item.text) }))).toEqual([{ id: source.turns[0].turnId, status: 'running', messages: ['Synthetic source conversation'] }]);
				outcomes.push({ entry, query, sideThreadId, turn });
				await page.screenshot({ path: testInfo.outputPath(`${entry}-${query.startsWith('/init') ? 'init' : 'develop'}.png`) });
				await chat.locator('.ash-chat-side-chat-origin').getByRole('button').click();
			}
			await client.request(methods['session/request'], { sessionId, commandId: 'stop-side-chat-source', request: { type: 'interruptTurn', threadId, turnId: source.turns[0].turnId, expectedSequence: (await readSource()).sequence } });
			await expect.poll(async () => (await readSource()).turns[0].status).toBe('interrupted');
			await testInfo.attach('side-chat-command-semantics.json', { body: JSON.stringify({ surface, sessionId, threadId, outcomes, requests }, null, 2), contentType: 'application/json' });
		} finally {
			await connection?.close();
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
}
