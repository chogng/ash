import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { APP_SERVER_METHODS as methods, APPROVAL_MODE_DEFINITIONS } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

for (const surface of ['Code', 'Cowork'] as const) test(`${surface} MCP forms preserve optional absence and explicit false through the real harness`, { tag: ['@electron-app-server'] }, async ({ application, target, webAppServer, workbench, testWorkspace }, testInfo) => {
	test.setTimeout(180_000);
	const provider = 'custom-elicitation-fixture';
	const model = { provider, model: 'elicitation-model' };
	let calls = 0;
	const asked = new Set<string>();
	const server = createServer(async (request, response) => {
		try {
			if (request.method === 'GET') {
				response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: model.model }] }));
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tools?: { name: string; }[]; input?: { type?: string; }[]; };
			const tool = body.tools?.find(value => value.name.includes('ask_fields'));
			const scenario = JSON.stringify(body.input).includes('With optional values') ? 'explicit' : 'absent';
			const ask = tool && !asked.has(scenario);
			if (ask) asked.add(scenario);
			const id = `elicitation-${++calls}`;
			const output = ask
				? [{ type: 'function_call', id, call_id: id, name: tool.name, arguments: '{}' }]
				: [{ type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text: 'The form was received.' }] }];
			response.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })}\n\n`);
		} catch (error) { response.writeHead(500).end(String(error)); }
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const record = join(testWorkspace.directory, 'elicitation-answers.jsonl');
	const script = join(testWorkspace.directory, 'elicitation-mcp.cjs');
	await writeFile(script, `const fs = require('node:fs');
const pending = new Map();
let next = 1000;
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
 const message = JSON.parse(line);
 if (message.id === undefined) return;
 if (!message.method) {
  const call = pending.get(message.id);
  if (call === undefined) return;
  pending.delete(message.id);
  fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(message.result) + '\\n');
  send({ id: call, result: { content: [{ type: 'text', text: JSON.stringify(message.result) }] } });
  return;
 }
 if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'elicitation-fixture', version: '1' } } });
 else if (message.method === 'tools/list') send({ id: message.id, result: { tools: [{ name: 'ask_fields', description: 'Ask the synthetic form.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] } });
 else if (message.method === 'tools/call') {
  const id = ++next;
  pending.set(id, message.id);
  send({ id, method: 'elicitation/create', params: { mode: 'form', message: 'Complete the synthetic form', requestedSchema: { type: 'object', properties: {
   project: { type: 'string', title: 'Project', description: 'Required project', minLength: 1 },
   note: { type: 'string', title: 'Note', description: 'Optional note', minLength: 2 },
   color: { type: 'string', title: 'Color', description: 'Optional color', enum: ['red', 'blue'] },
   enabled: { type: 'boolean', title: 'Enabled', description: 'Optional enabled' }
  }, required: ['project'] } } });
 } else send({ id: message.id, result: {} });
});`);
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Missing synthetic model address');
		const page = await workbench.openAgentsWindow(target.kind);
		connection = await connectProfile(application, webAppServer, testWorkspace.directory, page);
		const { client } = connection;
		let config = await client.request(methods['config/read'], {});
		const mcpId = 'user:mcp:elicitation-fixture';
		await client.request(methods['mcp/server/upsert'], { commandId: 'elicitation-server', expectedRevision: config.revision, server: { id: mcpId, displayName: 'Synthetic elicitation', transport: { type: 'stdio', command: process.execPath, args: [script] }, credential: { type: 'unauthenticated' }, enablement: 'enabled' } });
		await expect.poll(async () => (await client.request(methods['mcp/server/status'], {})).servers.find(value => value.id === mcpId)?.toolCount).toBe(1);
		config = await client.request(methods['config/read'], {});
		await client.request(methods['provider/configure'], { commandId: 'elicitation-provider', expectedRevision: config.revision, config: { connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`, custom: { name: 'Synthetic elicitation model', protocol: 'responses', order: 0, contextWindow: 272_000 }, modelContext: { [model.model]: { contextWindow: 272_000 } } } });
		await client.request(methods['provider/apiKey/set'], { connection: provider, apiKey: 'synthetic-elicitation-key' });
		config = await client.request(methods['config/read'], {});
		await client.request(methods['config/update'], { commandId: 'elicitation-default-model', expectedRevision: config.revision, model });
		const created = await client.request(methods['session/create'], { commandId: 'elicitation-session', title: 'MCP optional form', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
		const sessionId = created.session.sessionId;
		const threadId = created.session.threads[0]!.threadId;
		const read = async () => (await client.request(methods['session/thread/read'], { sessionId, threadId })).thread;
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'MCP optional form' }).click();
		const bypass = APPROVAL_MODE_DEFINITIONS.find(mode => mode.id === 'bypassPermissions')!;
		await page.locator('.ash-sessions-chat-slot.active:visible').getByRole('button', { name: /^Permissions:/ }).click();
		await page.getByRole('menuitemradio', { name: bypass.label.english, exact: true }).click();
		await page.getByRole('dialog', { name: 'Confirm', exact: true }).getByRole('button', { name: bypass.label.english, exact: true }).click();
		if (surface === 'Cowork') await page.locator('[data-action-id="sessions.open.collaboration"] button').click();
		const chat = page.locator(`.ash-sessions-chat-slot.active:visible ${surface === 'Code' ? '.ash-chat' : '.ash-cowork'}`);
		const answers = async (): Promise<unknown[]> => {
			try { return (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
		};
		for (const explicit of [false, true]) {
			const input = chat.locator('.ash-chat-input-part .stanza-editor-input');
			await input.focus();
			await page.keyboard.insertText(`Use ask_fields once, then finish. ${explicit ? 'With optional values' : 'Required fields only'}`);
			await input.press('Enter');
			if (surface === 'Cowork') await chat.getByRole('button', { name: 'Approve once', exact: true }).click();
			const form = chat.locator('.ash-chat-interaction-form');
			const project = form.locator('input[name="project"]');
			try { await expect(project).toBeVisible(); }
			catch (error) {
				await testInfo.attach('elicitation-state.json', { body: JSON.stringify({ thread: await read(), answers: await answers() }), contentType: 'application/json' });
				throw error;
			}
			await expect(project).toHaveJSProperty('required', true);
			await expect(form.locator('input[name="note"]')).toHaveJSProperty('required', false);
			await expect(form.locator('select[name="color"]')).toHaveValue('');
			await expect(form.locator('select[name="enabled"]')).toHaveValue('');
			expect(await form.evaluate(element => (element as HTMLFormElement).checkValidity())).toBe(false);
			await project.fill('Synthetic project');
			if (explicit) {
				await form.locator('input[name="note"]').fill('A note');
				await form.locator('select[name="color"]').selectOption('red');
				await form.locator('select[name="enabled"]').selectOption('false');
			}
			await form.getByRole('button', { name: 'Submit answers', exact: true }).click();
			await expect.poll(async () => (await read()).turns.at(-1)?.status).toBe('completed');
			const result = { action: 'accept', content: { project: 'Synthetic project', ...(explicit ? { note: 'A note', color: 'red', enabled: false } : {}) } };
			await expect.poll(async () => (await answers()).at(-1)).toEqual(result);
			expect(await answers()).toHaveLength(explicit ? 2 : 1);
		}
		await testInfo.attach('elicitation-answers.json', { body: JSON.stringify(await answers(), null, 2), contentType: 'application/json' });
	} finally {
		await connection?.close();
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});
