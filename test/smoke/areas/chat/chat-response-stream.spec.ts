import { createServer, type ServerResponse } from 'node:http';
import type { Locator } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

// The provider HTTP stream is controlled; profile daemon, Core, durable Thread,
// transport and response widgets are the same ones used by the product.
test.use({ video: 'on' });

test('Real streamed Chat responses retain code selection, focus and reading position through media and corrections', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, target, webAppServer, workbench, testWorkspace }, testInfo) => {
	test.setTimeout(180_000);
	const provider = 'custom-chat-response-fixture';
	const model = { provider, model: 'chat-response-model' };
	const requests: unknown[] = [];
	const stages: { stage: string; at: string; }[] = [];
	let stream: ServerResponse | undefined;
	const server = createServer(async (request, response) => {
		if (request.method === 'GET') {
			response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: model.model }] }));
			return;
		}
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			if (stream) throw new Error('The response fixture expected exactly one model request');
			stream = response;
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.flushHeaders();
		} catch (error) { response.writeHead(500).end(String(error)); }
	});
	const send = (event: Record<string, unknown>): void => {
		if (!stream || stream.destroyed) throw new Error('The real model response stream is not open');
		stream.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
	};
	const message = (index: number, text: string) => ({ type: 'message', id: `response-message-${index}`, role: 'assistant', phase: index === 0 ? 'commentary' : 'final_answer', content: [{ type: 'output_text', text }] });
	const delta = (index: number, text: string): void => send({ type: 'response.output_text.delta', output_index: index, item_id: `response-message-${index}`, delta: text });
	const mark = (stage: string): void => { stages.push({ stage, at: new Date().toISOString() }); };
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	let readThread: (() => Promise<unknown>) | undefined;
	try {
		// The Browser connection belongs to this realm, so open Agents before creating it.
		const page = await workbench.openAgentsWindow(target.kind);
		connection = await connectProfile(application, webAppServer, testWorkspace.directory, page);
		const { client } = connection;
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Missing response fixture port');
		const config = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['provider/configure'], { commandId: 'response-provider', expectedRevision: config.revision, config: { connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`, custom: { name: 'Isolated response stream fixture', protocol: 'responses', order: 0, contextWindow: 272_000 }, modelContext: { [model.model]: { contextWindow: 272_000 } } } });
		await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'synthetic-fixture-key' });
		const created = await client.request(APP_SERVER_METHODS['session/create'], { commandId: 'response-session', title: 'Controlled Chat response', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
		const sessionId = created.session.sessionId;
		const threadId = created.session.threads[0]!.threadId;
		const read = async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread;
		readThread = read;
		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Code', exact: true }).click();
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'Controlled Chat response' }).click();
		const chat = page.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
		await expect(chat).toHaveAttribute('data-thread-id', threadId);
		const before = await read();
		await client.request(APP_SERVER_METHODS['session/request'], { commandId: 'response-turn', sessionId, request: { type: 'startTurn', threadId, expectedSequence: before.sequence, mode: 'ask', approvalMode: 'bypassPermissions', model, input: [{ type: 'text', text: 'Return the synthetic streamed response without using tools.' }] } });
		await expect.poll(() => requests.length).toBe(1);
		const code = '```typescript\nconst value = 1;\n```';
		for (const index of [0, 1]) send({ type: 'response.output_item.added', output_index: index, item: message(index, '') });
		delta(0, 'Synthetic media is being prepared.');
		delta(1, code);
		mark('initial-code');
		const block = chat.locator('.ash-chat-code-block');
		const editor = block.locator('.stanza-editor');
		await expect(editor).toBeVisible();
		const originalEditor = await editor.elementHandle();
		await block.locator('.stanza-editor-input').focus();
		await page.keyboard.press('ControlOrMeta+A');
		// Read the browser's public editing selection. No renderer service or model
		// is replaced, and no debug API is added to the product for this assertion.
		const selection = async () => block.locator('.stanza-editor-input').evaluate(element => {
			const context = (element as HTMLElement & { editContext?: { text: string; selectionStart: number; selectionEnd: number; }; }).editContext;
			const input = element as HTMLTextAreaElement;
			return context ? { start: context.selectionStart, end: context.selectionEnd } : { start: input.selectionStart, end: input.selectionEnd };
		});
		const selected = await selection();
		expect(selected.start).toBe(0);
		expect(selected.end).toBe('const value = 1;'.length);
		const copy = block.getByRole('button', { name: 'Copy', exact: true });
		await copy.focus();
		await expect(copy).toBeFocused();
		const viewport = chat.locator('.ash-chat-list-widget .ash-scrollbar-viewport');
		await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
		const paragraphs = Array.from({ length: 32 }, (_, index) => `Response section ${index}. ${'Synthetic reading content. '.repeat(8)}`).join('\n\n');
		delta(1, '\n\n' + paragraphs);
		mark('streamed-following');
		await expect(chat).toContainText('Response section 31.');
		await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBe(0);
		expect(await editor.evaluate((element, previous) => element === previous, originalEditor)).toBe(true);
		expect(await selection()).toEqual(selected);
		await expect(copy).toBeFocused();
		await testInfo.attach('streaming-follow.png', { body: await page.screenshot(), contentType: 'image/png' });

		const paragraph = chat.locator('.ash-chat-markdown-part p').filter({ hasText: /^Response section 12\./u });
		await viewport.evaluate((element, target) => { element.scrollTop += target!.getBoundingClientRect().top - element.getBoundingClientRect().top + 20; }, await paragraph.elementHandle());
		const geometry = async (anchor: Locator) => ({ top: await anchor.evaluate(element => element.getBoundingClientRect().top), scroll: await viewport.evaluate(element => ({ top: element.scrollTop, maximum: element.scrollHeight - element.clientHeight, distance: element.scrollHeight - element.scrollTop - element.clientHeight })) });
		await expect.poll(async () => (await geometry(paragraph)).scroll.distance).toBeGreaterThan(100);
		const reading = await geometry(paragraph);
		await testInfo.attach('reading-before-media.png', { body: await page.screenshot(), contentType: 'image/png' });
		const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=';
		const media = `Synthetic media is ready.\n\n![Synthetic response media](data:image/png;base64,${png}|width=320,height=320)`;
		const corrected = code.replace('= 1', '= 2') + '\n\n' + paragraphs;
		const output = [message(0, media), message(1, corrected)];
		for (const [index, item] of output.entries()) send({ type: 'response.output_item.done', output_index: index, item });
		send({ type: 'response.completed', response: { id: 'response-fixture', status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
		stream!.end();
		mark('completed-media-and-correction');
		await expect.poll(async () => (await read()).turns.at(-1)?.status).toBe('completed');
		await expect.poll(() => chat.getByRole('img', { name: 'Synthetic response media', exact: true }).evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(2);
		await expect(block.locator('.view-lines')).toContainText('const value = 2;');
		await expect.poll(async () => Math.abs((await geometry(paragraph)).top - reading.top)).toBeLessThanOrEqual(1);
		expect((await geometry(paragraph)).scroll.distance).toBeGreaterThan(100);
		expect(await editor.evaluate((element, previous) => element === previous, originalEditor)).toBe(true);
		expect(await selection()).toEqual(selected);
		await expect(copy).toBeFocused();
		const durable = await read();
		const messages = durable.turns.at(-1)!.items.filter(item => item.type === 'agentMessage');
		expect(messages.map(item => item.text)).toEqual([media, corrected]);
		await testInfo.attach('reading-after-media.png', { body: await page.screenshot(), contentType: 'image/png' });
		await testInfo.attach('response-state.json', { body: JSON.stringify({ target, sessionId, threadId, selected, restoredSelection: await selection(), readingBefore: reading, readingAfter: await geometry(paragraph), stages, durable }, null, 2), contentType: 'application/json' });
		await originalEditor?.dispose();
	} finally {
		try {
			await testInfo.attach('controlled-model-requests.json', { body: JSON.stringify({ requests, stages }, null, 2), contentType: 'application/json' });
			if (readThread) await testInfo.attach('actual-response-thread.json', { body: JSON.stringify(await readThread(), null, 2), contentType: 'application/json' });
		} finally {
			await connection?.close();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		}
	}
});
