import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { APP_SERVER_METHODS as methods } from '../../../../.build/protocol/typescript/index.js';
import { expect, test } from '../../../automation/test.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

interface ModelInput {
	type?: string;
	role?: string;
	name?: string;
	call_id?: string;
	output?: string | { text?: string; }[];
}

test.use({ electronWindowMode: 'active' });

test('Windows Computer Use authorizes a window only for the current Ash turn', { tag: ['@electron-app-server'] }, async ({ application, target, workbench, testWorkspace }, testInfo) => {
	test.skip(process.platform !== 'win32' || process.arch !== 'x64', 'Windows x64 Computer Use');
	test.setTimeout(180_000);
	const fixtureScript = await readFile(new URL('../../../../extensions/computer-use/tests/fixture.ps1', import.meta.url), 'utf8');
	const system = process.env.SystemRoot;
	if (!system) throw new Error('Windows system directory is unavailable');
	const fixture = spawn(join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-Sta', '-EncodedCommand', Buffer.from(fixtureScript, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
	const fixtureExit = once(fixture, 'exit');
	let fixtureError = '';
	fixture.stderr.setEncoding('utf8').on('data', (chunk: string) => { fixtureError += chunk; });
	const title = `Ash Computer Use fixture ${fixture.pid}`;
	const provider = 'custom-computer-use-fixture';
	const model = { provider, model: 'computer-use-fixture' };
	let sequence = 0;
	let firstTurnObserved = false;
	let secondTurnDenied = false;
	const errors: string[] = [];
	const server = createServer(async (request, response) => {
		try {
			if (request.method === 'GET') {
				response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: model.model }] }));
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tools?: { name: string; }[]; input: ModelInput[]; };
			const lastUser = body.input.findLastIndex(item => item.role === 'user' && /Select and observe the synthetic window\.|Check expired selection\./.test(JSON.stringify(item)));
			if (lastUser === -1) throw new Error('The model turn is missing its synthetic user prompt');
			const nextTurn = JSON.stringify(body.input[lastUser]).includes('Check expired selection.');
			const current = body.input.slice(lastUser + 1);
			const latest = current.findLast(item => item.type === 'function_call_output');
			const call = latest && current.find(item => item.type === 'function_call' && item.call_id === latest.call_id);
			const result = typeof latest?.output === 'string' ? latest.output : latest?.output?.map(part => part.text ?? '').join('');
			const id = `computer-use-${++sequence}`;
			const tool = (name: string, args: object) => {
				if (!body.tools?.some(tool => tool.name === name)) throw new Error(`Tool ${name} is absent from this Windows turn. Tools: ${body.tools?.map(tool => tool.name).join(", ")}`);
				return [{ type: 'function_call', id, call_id: id, name, arguments: JSON.stringify(args) }];
			};
			let output: object[];
			if (!latest) output = nextTurn ? tool('computer_use_observe', { screenshot: false }) : tool('computer_use_select_window', { query: title });
			else if (call?.name === 'computer_use_select_window') {
				if (!result?.includes(title)) throw new Error(`Unexpected window selection: ${result}`);
				output = tool('computer_use_observe', { screenshot: false });
			} else if (call?.name === 'computer_use_act') {
				if (!result?.includes('applied')) throw new Error(`Unexpected action result: ${result}`);
				output = tool('computer_use_observe', { screenshot: false });
			} else if (!nextTurn && !current.some(item => item.type === 'function_call' && item.name === 'computer_use_act')) {
				const observation = JSON.parse(result ?? '') as { observation: number; elements: { id: number; name: string; actions: string[]; }[]; };
				const field = observation.elements.find(element => element.name === 'Test value' && element.actions.includes('set_value'));
				if (!field) throw new Error('The authorized window did not expose the test field');
				output = tool('computer_use_act', { observation: observation.observation, element: field.id, action: 'set_value', value: 'written through Ash' });
			} else {
				if (nextTurn) secondTurnDenied = result?.includes('select a window first') ?? false;
				else firstTurnObserved = result?.includes('written through Ash') ?? false;
				output = [{ type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text: nextTurn ? 'Selection scope checked.' : 'Selected window observed.' }] }];
			}
			response.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })}\n\n`);
		} catch (error) {
			errors.push(String(error));
			response.writeHead(500).end(String(error));
		}
	});
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		const [ready] = await Promise.race([once(fixture.stdout, 'data'), fixtureExit.then(() => { throw new Error(`Fixture exited before startup: ${fixtureError}`); })]);
		expect(String(ready).trim()).toBe('ready');
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Missing synthetic model address');
		const page = await workbench.openAgentsWindow(target.kind);
		connection = await connectProfile(application, undefined, testWorkspace.directory, page);
		const { client } = connection;
		let config = await client.request(methods['config/read'], {});
		await client.request(methods['provider/configure'], { commandId: 'computer-use-provider', expectedRevision: config.revision, config: { connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`, custom: { name: 'Synthetic Computer Use model', protocol: 'responses', order: 0, contextWindow: 272_000 }, modelContext: { [model.model]: { contextWindow: 272_000 } } } });
		await client.request(methods['provider/apiKey/set'], { connection: provider, apiKey: 'synthetic-computer-use-key' });
		config = await client.request(methods['config/read'], {});
		await client.request(methods['config/update'], { commandId: 'computer-use-default-model', expectedRevision: config.revision, model });
		await client.request(methods['session/create'], { commandId: 'computer-use-session', kind: 'code', title: 'Computer Use scope fixture', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'Computer Use scope fixture' }).click();
		const chat = page.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
		const input = chat.locator('.ash-chat-input-part .stanza-editor-input');
		const send = async (text: string) => {
			await input.focus();
			await page.keyboard.insertText(text);
			await input.press('Enter');
		};
		await send('Select and observe the synthetic window.');
		const form = chat.locator('.ash-chat-interaction-form');
		await expect(form.getByText('Select a window to let the agent read and operate it for this turn.')).toBeVisible();
		await form.locator('select[name="ash.computerUse.window"]').selectOption(`1. ${title}`);
		await form.getByRole('button', { name: 'Submit answers', exact: true }).click();
		await expect(chat.getByText('Selected window observed.')).toBeVisible();
		await send('Check expired selection.');
		await expect(chat.getByText('Selection scope checked.')).toBeVisible();
		expect(errors).toEqual([]);
		expect(firstTurnObserved).toBe(true);
		expect(secondTurnDenied).toBe(true);
	} catch (error) {
		await testInfo.attach('computer-use-fixture.json', { body: JSON.stringify({ errors, fixtureError }), contentType: 'application/json' });
		if (errors.length) throw new Error(errors[0], { cause: error });
		throw error;
	} finally {
		await connection?.close();
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
		fixture.kill();
		await fixtureExit;
	}
});
