import { createServer, type ServerResponse } from 'node:http';
import { expect, test } from '../../../automation/test.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

test('Real reasoning streams keep disclosure and focus through canonical completion', { tag: ['@electron-app-server'] }, async ({ application, target, webAppServer, workbench, testWorkspace }, testInfo) => {
	test.setTimeout(180_000);
	const provider = 'custom-thinking-fixture';
	const model = { provider, model: 'thinking-model' };
	let stream: ServerResponse | undefined;
	const server = createServer(async (request, response) => {
		if (request.method === 'GET') {
			response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: model.model }] }));
			return;
		}
		for await (const _chunk of request) { /* Drain the provider request before controlling its stream. */ }
		if (stream) {
			response.writeHead(500).end('Unexpected second model request');
			return;
		}
		stream = response;
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		response.flushHeaders();
	});
	const send = (event: Record<string, unknown>): void => {
		if (!stream || stream.destroyed) { throw new Error('The reasoning fixture stream is not open'); }
		stream.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
	};
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		const page = await workbench.openAgentsWindow(target.kind);
		connection = await connectProfile(application, webAppServer, testWorkspace.directory, page);
		const { client } = connection;
		const address = server.address();
		if (!address || typeof address === 'string') { throw new Error('Missing reasoning fixture port'); }
		const config = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['provider/configure'], {
			commandId: 'thinking-provider', expectedRevision: config.revision,
			config: {
				connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`,
				custom: { name: 'Synthetic reasoning stream', protocol: 'responses', order: 0, contextWindow: 272_000 },
				modelContext: { [model.model]: { contextWindow: 272_000 } },
			},
		});
		await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'synthetic-thinking-fixture-key' });
		const created = await client.request(APP_SERVER_METHODS['session/create'], {
			commandId: 'thinking-session', title: 'Reasoning disclosure', agent: { type: 'default' },
			executionTarget: { type: 'local', root: testWorkspace.directory },
		});
		const sessionId = created.session.sessionId;
		const threadId = created.session.threads[0].threadId;
		const read = async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread;
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'Reasoning disclosure' }).click();
		const chat = page.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
		await expect(chat).toHaveAttribute('data-thread-id', threadId);
		await client.request(APP_SERVER_METHODS['session/request'], {
			commandId: 'thinking-turn', sessionId,
			request: {
				type: 'startTurn', threadId, expectedSequence: (await read()).sequence,
				mode: 'ask', approvalMode: 'bypassPermissions', model,
				input: [{ type: 'text', text: 'Return the synthetic reasoning and final answer.' }],
			},
		});
		await expect.poll(() => !!stream).toBe(true);
		const initial = 'Stable **synthetic reasoning**.\n\nStarting analysis.';
		send({ type: 'response.reasoning_summary_text.delta', delta: initial });
		const details = chat.locator('.ash-chat-thinking');
		const summary = details.locator('summary');
		await expect(summary).toHaveText('Thinking…');
		await expect(details).not.toHaveAttribute('open');
		await summary.focus();
		await page.keyboard.press('Enter');
		await expect(details.locator('strong')).toHaveText('synthetic reasoning');
		const retained = await details.elementHandle();
		send({ type: 'response.reasoning_summary_text.delta', delta: ' More evidence.' });
		await expect(details).toContainText('More evidence.');
		await expect(summary).toBeFocused();
		await page.keyboard.press('Space');
		send({ type: 'response.reasoning_summary_text.delta', delta: ' Final check.' });
		await expect(details).not.toHaveAttribute('open');
		await page.keyboard.press('Space');
		await expect(details).toContainText('Final check.');
		const fullText = initial + ' More evidence. Final check.';
		send({
			type: 'response.completed',
			response: {
				id: 'thinking-response', status: 'completed',
				output: [
					{ type: 'reasoning', id: 'reasoning-output', summary: [{ type: 'summary_text', text: fullText }] },
					{ type: 'message', id: 'final-output', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic final answer.' }] },
				],
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			},
		});
		stream!.end();
		await expect.poll(async () => (await read()).turns.at(-1)?.status).toBe('completed');
		await expect(summary).toHaveText('Reasoning complete');
		await expect(summary).toBeFocused();
		await expect(details).toHaveAttribute('open');
		expect(await details.evaluate((element, old) => element === old, retained)).toBe(true);
		expect((await read()).turns.at(-1)!.items.filter(item => item.type === 'reasoning').map(item => item.text)).toEqual([fullText]);
		await testInfo.attach('reasoning-complete.png', { body: await page.screenshot(), contentType: 'image/png' });
		await retained?.dispose();
	} finally {
		stream?.destroy();
		await connection?.close();
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});
