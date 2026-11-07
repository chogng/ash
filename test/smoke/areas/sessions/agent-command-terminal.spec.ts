import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { basename } from 'node:path';
import { APP_SERVER_METHODS, APPROVAL_MODE_DEFINITIONS } from '../../../../.build/protocol/typescript/index.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { expect, test } from '../../../automation/test.js';
import { connectProfile } from './sessionProfileFixture.js';

test('Chat output and terminal handoff use the original Agent command', { tag: ['@electron-app-server'] }, async ({ application, webAppServer, target, testWorkspace, workbench }) => {
	test.setTimeout(120_000);
	const provider = 'custom-agent-command-terminal';
	const model = { provider, model: 'terminal-fixture' };
	const program = process.execPath;
	const terminalScript = `console.log('ready:' + process.pid);
		require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
			console.log('received:' + line + ':' + process.pid);
			if (line === 'second') process.exit(0);
		});`;
	const server = createServer(async (request, response) => {
		if (request.method === 'GET') {
			response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: model.model }] }));
			return;
		}
		let text = '';
		for await (const chunk of request) text += chunk;
		const messages = (JSON.parse(text) as { messages: { role: string; tool_call_id?: string; content?: unknown; }[]; }).messages;
		const startResult = messages.find(message => message.role === 'tool' && message.tool_call_id === 'fixture-terminal-start');
		const terminalId = JSON.stringify(startResult?.content ?? '').match(/cmd-[0-9a-f]{32}/u)?.[0];
		const finished = !!startResult && (!terminalId || messages.some(message => message.tool_call_id === 'fixture-terminal-wait'));
		const tool = (index: number, id: string, name: string, args: object) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
		const delta = finished ? { content: 'The command finished.' } : startResult ? {
			tool_calls: [
				tool(0, 'fixture-terminal-wait', 'shell-session', { action: 'wait', session_id: terminalId, program: null, arguments: null, working_directory: null, input: null, stdout_cursor: 0, stderr_cursor: 0, wait_ms: 60_000, timeout_ms: null, terminal_rows: null, terminal_cols: null }),
			]
		} : {
			tool_calls: [
				tool(0, 'fixture-short-command', 'shell-command', { program, arguments: ['-e', 'console.log("short-output"); console.error("short-error"); process.exitCode = 3;'], working_directory: '.' }),
				tool(1, 'fixture-terminal-start', 'shell-session', { action: 'start', session_id: null, program, arguments: ['-e', terminalScript], working_directory: '.', input: null, stdout_cursor: null, stderr_cursor: null, wait_ms: 5000, timeout_ms: 90_000, terminal_rows: 24, terminal_cols: 80 }),
			]
		};
		const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'command-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		response.end(chunk(delta, null) + chunk({}, finished ? 'stop' : 'tool_calls') + 'data: [DONE]\n\n');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		connection = await connectProfile(application, webAppServer, testWorkspace.directory, workbench.page);
		const { client } = connection;
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Missing fixture port');
		const revision = async () => (await client.request(APP_SERVER_METHODS['config/read'], {})).revision;
		await client.request(APP_SERVER_METHODS['provider/configure'], { commandId: randomUUID(), expectedRevision: await revision(), config: { connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`, custom: { name: 'Agent command terminal fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 }, modelContext: { [model.model]: { contextWindow: 272_000 } } } });
		await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'synthetic-fixture-key' });
		await client.request(APP_SERVER_METHODS['config/update'], { commandId: randomUUID(), expectedRevision: await revision(), model });
		for (const name of ['shell-command', 'shell-session']) {
			await client.request(APP_SERVER_METHODS['execPolicy/rule/upsert'], { commandId: randomUUID(), expectedRevision: await revision(), rule: { id: `fixture-${name}`, selector: { type: 'source', source: 'built_in_tool', sourceId: name }, effect: { type: 'allowUnsandboxed' }, justification: 'Runs the synthetic terminal fixture in an isolated test profile.' } });
		}
		const page = await workbench.openAgentsWindow(target.kind);
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		const chat = page.locator('.ash-sessions-chat-slot.active:visible .ash-chat:visible');
		const picker = chat.locator('.ash-sessions-workspace-picker');
		const workspaceName = basename(testWorkspace.directory);
		if ((await picker.textContent())?.trim() !== workspaceName) {
			await picker.press('Enter');
			await page.getByRole('menuitemradio', { name: workspaceName, exact: true }).click();
		}
		await chat.locator('.ash-chat-input-mode-action').click();
		await page.locator('.ash-chat-input-mode-menu').getByRole('menuitemradio', { name: 'Agent', exact: true }).click();
		await chat.getByRole('button', { name: /^Permissions:/ }).click();
		const bypass = APPROVAL_MODE_DEFINITIONS.find(mode => mode.id === 'bypassPermissions')!;
		await page.getByRole('menuitemradio', { name: bypass.label.english, exact: true }).click();
		await page.getByRole('dialog', { name: 'Confirm', exact: true }).getByRole('button', { name: bypass.label.english, exact: true }).click();
		const input = new Editor(chat).input;
		await input.focus();
		await page.keyboard.insertText('Run the command terminal fixture');
		await input.press('Enter');

		const short = chat.locator('.ash-chat-tool-invocation').filter({ has: page.locator('summary').filter({ hasText: 'short-output' }) });
		await expect(short).toHaveAttribute('data-state', 'completed', { timeout: 30_000 });
		if (await short.getAttribute('open') === null) await short.locator(':scope > summary').press('Enter');
		for (const [section, output] of [['stdout', 'short-output'], ['stderr', 'short-error'], ['result', 'Exit code: 3']]) {
			const details = short.locator(`[data-tool-section="${section}"]`);
			await details.locator('summary').press('Enter');
			await expect(details.locator('pre')).toContainText(output);
		}
		const interactive = chat.locator('.ash-chat-tool-invocation').filter({ has: page.locator('summary').filter({ hasText: 'ready:' }) });
		await expect(interactive).toHaveAttribute('data-state', 'completed');
		if (await interactive.getAttribute('open') === null) await interactive.locator(':scope > summary').press('Enter');
		const initialOutput = interactive.locator('[data-tool-section="stdout"] pre');
		await expect(initialOutput).toContainText(/ready:\d+/u);
		const pid = (await initialOutput.textContent())!.match(/ready:(\d+)/u)![1];
		await interactive.getByRole('button', { name: 'Show Terminal', exact: true }).press('Enter');
		const terminal = page.locator('.ash-terminal-editor:visible');
		const rows = terminal.locator('.xterm-rows');
		await expect(rows).toContainText(`ready:${pid}`);
		const keys = terminal.locator('.xterm-helper-textarea');
		await keys.press('x');
		await interactive.getByRole('button', { name: 'Take Over Terminal Input', exact: true }).press('Enter');
		await expect(keys).toBeFocused();
		await expect(terminal).toHaveCount(1);
		await keys.pressSequentially('first');
		await keys.press('Enter');
		await expect(rows).toContainText(`received:first:${pid}`);
		await new QuickAccess(page).runCommand('workbench.action.closeActiveEditor');
		await expect(terminal).toHaveCount(0);
		await interactive.getByRole('button', { name: 'Take Over Terminal Input', exact: true }).press('Enter');
		await expect(keys).toBeFocused();
		await keys.pressSequentially('second');
		await keys.press('Enter');
		await expect(rows).toContainText(`received:second:${pid}`);
	} finally {
		await connection?.close();
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});
