import { randomUUID } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { APP_SERVER_METHODS, type TerminalCommandSessionAction } from '../../../../.build/protocol/typescript/index.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { expect, test } from '../../../automation/test.js';
import { connectProfile } from './sessionProfileFixture.js';

test('Manually approved Agent terminal keeps the original command across handoffs', { tag: ['@electron-app-server'] }, async ({ application, webAppServer, target, testWorkspace, workbench }, testInfo) => {
	test.setTimeout(120_000);
	const provider = 'custom-agent-command-terminal';
	const model = { provider, model: 'terminal-fixture' };
	const program = process.execPath;
	const approvedCall = 'fixture-terminal-start';
	const declinedCall = 'fixture-terminal-decline';
	const approvedMarker = 'approved-terminal.jsonl';
	const declinedMarker = 'declined-terminal.txt';
	const terminalScript = `const fs = require('node:fs');
		const record = input => fs.appendFileSync(${JSON.stringify(approvedMarker)}, JSON.stringify({ input, pid: process.pid, cwd: fs.realpathSync(process.cwd()) }) + '\\n');
		record('start');
		console.log('ready:' + process.pid);
		require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
			record(line);
			process.stdout.write('received:' + line + ':' + process.pid + '\\n', () => {
				if (line === 'second') process.exit(0);
			});
		});`;
	const declinedScript = `require('node:fs').writeFileSync(${JSON.stringify(declinedMarker)}, 'started');`;
	const start = (script: string) => ({ action: 'start', session_id: null, program, arguments: ['--no-warnings', '-e', script], working_directory: '.', input: null, stdout_cursor: null, stderr_cursor: null, wait_ms: 2000, timeout_ms: 90_000, terminal_rows: 24, terminal_cols: 80 });
	let commandSessionId: string | undefined;
	const server = createServer(async (request, response) => {
		if (request.method === 'GET') {
			response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: model.model }] }));
			return;
		}
		let text = '';
		for await (const chunk of request) text += chunk;
		const messages = (JSON.parse(text) as { messages: { role: string; tool_call_id?: string; content?: unknown; }[]; }).messages;
		const startResult = messages.find(message => message.role === 'tool' && message.tool_call_id === approvedCall);
		const terminalId = JSON.stringify(startResult?.content ?? '').match(/cmd-[0-9a-f]{32}/u)?.[0];
		if (terminalId) commandSessionId = terminalId;
		const finished = !!startResult && (!terminalId || messages.some(message => message.tool_call_id === 'fixture-terminal-wait'));
		const tool = (index: number, id: string, name: string, args: object) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
		const delta = finished ? { content: 'The command finished.' } : startResult ? {
			tool_calls: [
				tool(0, 'fixture-terminal-wait', 'shell-session', { action: 'wait', session_id: terminalId, program: null, arguments: null, working_directory: null, input: null, stdout_cursor: 0, stderr_cursor: 0, wait_ms: 60_000, timeout_ms: null, terminal_rows: null, terminal_cols: null }),
			]
		} : {
			tool_calls: [
				tool(0, 'fixture-short-command', 'shell-command', { program, arguments: ['-e', 'console.log("short-output"); console.error("short-error"); process.exitCode = 3;'], working_directory: '.' }),
				tool(1, declinedCall, 'shell-session', start(declinedScript)),
				tool(2, approvedCall, 'shell-session', start(terminalScript)),
			]
		};
		const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'command-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		response.end(chunk(delta, null) + chunk({}, finished ? 'stop' : 'tool_calls') + 'data: [DONE]\n\n');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	let terminalConnection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		connection = await connectProfile(application, webAppServer, testWorkspace.directory, workbench.page);
		const { client } = connection;
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Missing fixture port');
		const revision = async () => (await client.request(APP_SERVER_METHODS['config/read'], {})).revision;
		await client.request(APP_SERVER_METHODS['provider/configure'], { commandId: randomUUID(), expectedRevision: await revision(), config: { connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`, custom: { name: 'Agent command terminal fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 }, modelContext: { [model.model]: { contextWindow: 272_000 } } } });
		await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'synthetic-fixture-key' });
		const config = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['config/update'], {
			commandId: randomUUID(), expectedRevision: config.revision, model,
			execution: { ...config.execution, approvalMode: 'manual' },
		});
		for (const name of ['shell-command', 'shell-session']) {
			await client.request(APP_SERVER_METHODS['execPolicy/rule/upsert'], { commandId: randomUUID(), expectedRevision: await revision(), rule: { id: `fixture-${name}`, selector: { type: 'source', source: 'built_in_tool', sourceId: name }, effect: { type: 'allowUnsandboxed' }, justification: 'Runs the synthetic terminal fixture in an isolated test profile.' } });
		}
		// Starts use the shell-command policy. Match just the PTY launches so the
		// short structured command and the model's later wait can run directly.
		await client.request(APP_SERVER_METHODS['execPolicy/rule/upsert'], {
			commandId: randomUUID(), expectedRevision: await revision(), rule: {
				id: 'fixture-review-pty-start', selector: { type: 'commandPrefix', pattern: [program, '--no-warnings'].map(value => ({ type: 'literal', value })) },
				effect: { type: 'requireApproval' }, justification: 'Exercise manual approval of the synthetic PTY launches.',
			},
		});
		const page = await workbench.openAgentsWindow(target.kind);
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		const { session } = await client.request(APP_SERVER_METHODS['session/create'], {
			commandId: randomUUID(), kind: 'code', title: 'Agent command terminal fixture', agent: { type: 'default' },
			executionTarget: { type: 'local', root: testWorkspace.directory },
		});
		const { sessionId, threads: [thread] } = session;
		const threadId = thread!.threadId;
		await page.locator(`[data-item="session:${sessionId}"] .ash-sessions-list-item`).click();
		const chat = page.locator('.ash-sessions-chat-slot.active:visible .ash-chat:visible');
		await expect(chat).toHaveAttribute('data-thread-id', threadId);
		const read = () => client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId });
		const { directory } = await read();
		if (directory?.type !== 'local') throw new Error('Missing local execution directory');
		const cwd = await realpath(directory.root);
		const approvedEvidence = join(cwd, approvedMarker);
		const declinedEvidence = join(cwd, declinedMarker);
		if (process.platform === 'win32') {
			const host = await connectProfile(application, webAppServer, testWorkspace.directory, page, { directoryGrantsHost: true });
			try {
				// The runtime needs execute authority on its source. Only the managed
				// working copy should contribute file authority to the command scope.
				const list = () => host.client.request(APP_SERVER_METHODS['config/directoryGrants/list'], {});
				await host.client.request(APP_SERVER_METHODS['config/directoryGrants/set'], {
					commandId: randomUUID(), expectedRevision: (await list()).revision,
					path: testWorkspace.directory, permissions: ['executeCommands'],
				});
				const { entries } = await list();
				expect(entries).toHaveLength(1);
				expect(await realpath(entries[0]!.path!)).toBe(testWorkspace.directory);
				expect(entries[0]!.permissions).toEqual(['executeCommands']);
				const permissions = ['readFiles', 'writeFiles', 'executeCommands'] as const;
				const { dirs } = await host.client.request(APP_SERVER_METHODS['session/dirs/add'], { sessionId, path: cwd, permissions: [...permissions] });
				expect(dirs).toHaveLength(1);
				expect(await realpath(dirs[0]!.path)).toBe(cwd);
				expect(dirs[0]!.permissions).toHaveLength(permissions.length);
				expect(dirs[0]!.permissions).toEqual(expect.arrayContaining([...permissions]));
			} finally {
				await host.close();
			}
			// Protected metadata would require a sandbox even with an explicit grant.
			expect((await readdir(cwd)).filter(name => /^\.(?:git|agents|codex|ash|env)$/iu.test(name))).toEqual([]);
		}
		await expect(chat.locator('.ash-chat-input-mode-selector.mode-agent')).toBeVisible();
		await expect(chat.getByRole('button', { name: 'Permissions: Manual', exact: true })).toBeVisible();
		const input = new Editor(chat).input;
		await input.focus();
		await page.keyboard.insertText('Run the command terminal fixture');
		await input.press('Enter');
		const expectApproval = async (toolCallId: string) => {
			await expect.poll(async () => {
				const turn = (await read()).thread.turns.at(-1);
				const pending = turn?.pendingInteraction;
				return pending?.kind === 'approval' && turn?.items.find(item => item.type === 'toolCall' && item.itemId === pending.itemId);
			}, { timeout: 30_000 }).toMatchObject({ toolCallId });
			const turn = (await read()).thread.turns.at(-1)!;
			expect(turn.startedToolCallIds ?? []).not.toContain(toolCallId);
			await expect(chat.getByRole('button', { name: 'Show Terminal', exact: true })).toHaveCount(0);
		};
		await expectApproval(declinedCall);
		await expect(readFile(declinedEvidence)).rejects.toMatchObject({ code: 'ENOENT' });
		await chat.getByRole('button', { name: 'Decline', exact: true }).click();
		await expectApproval(approvedCall);
		await expect(readFile(approvedEvidence)).rejects.toMatchObject({ code: 'ENOENT' });
		await chat.getByRole('button', { name: 'Approve once', exact: true }).click();

		await expect.poll(async () => {
			const turn = (await read()).thread.turns.at(-1);
			return turn?.items.filter(item => item.type === 'toolResult');
		}, { timeout: 10_000 }).toEqual(expect.arrayContaining([
			expect.objectContaining({ toolCallId: 'fixture-short-command', isError: false }),
			expect.objectContaining({ toolCallId: declinedCall, isError: true }),
			expect.objectContaining({ toolCallId: approvedCall, isError: false, text: expect.stringContaining('"status": "running"') }),
		]));
		const short = chat.locator('.ash-chat-tool-invocation').filter({ has: page.locator('summary').filter({ hasText: 'short-output' }) });
		await expect(short).toHaveAttribute('data-state', 'completed', { timeout: 30_000 });
		for (const [section, output] of [['stdout', 'short-output'], ['stderr', 'short-error'], ['result', 'Exit code: 3']]) {
			await expect(short.locator(`[data-tool-section="${section}"] pre`)).toContainText(output);
		}
		const interactive = chat.locator('.ash-chat-tool-invocation').filter({ has: page.locator('summary').filter({ hasText: 'ready:' }) });
		await expect(interactive).toHaveAttribute('data-state', 'completed');
		if (await interactive.getAttribute('open') === null) await interactive.locator(':scope > summary').press('Enter');
		const initialOutput = interactive.locator('[data-tool-section="stdout"] pre');
		await expect(initialOutput).toContainText(/ready:\d+/u);
		const pid = (await initialOutput.textContent())!.match(/ready:(\d+)/u)![1];
		await expect.poll(() => commandSessionId).toMatch(/^cmd-[0-9a-f]{32}$/u);
		const command = { sessionId, threadId, toolCallId: approvedCall, commandSessionId: commandSessionId! };
		const operation = (action: TerminalCommandSessionAction, commandTarget = command) => client.request(APP_SERVER_METHODS['terminal/commandSession'], { ...commandTarget, action });
		const write = (line: string): TerminalCommandSessionAction => ({ type: 'write', dataBase64: Buffer.from(`${line}\r`).toString('base64') });
		const take = { type: 'takeInput' } as const;
		const foreign = await client.request(APP_SERVER_METHODS['session/create'], { commandId: randomUUID(), kind: 'code', title: 'Unrelated terminal fixture session', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
		const foreignTarget = { ...command, sessionId: foreign.session.sessionId, threadId: foreign.session.threads[0]!.threadId };
		for (const action of [{ type: 'attach' }, { type: 'read', cursor: 0 }, take, write('foreign')] as const) {
			await expect(operation(action, foreignTarget)).rejects.toMatchObject({ code: -32011 });
		}
		await expect(operation(write('without-control'))).rejects.toMatchObject({ code: -32010 });
		await expect(operation({ type: 'resize', rows: 24, cols: 80 })).rejects.toMatchObject({ code: -32010 });
		const terminal = page.locator('.ash-terminal-editor:visible');
		await expect(terminal).toHaveCount(0);
		await interactive.getByRole('button', { name: 'Show Terminal', exact: true }).press('Enter');
		const rows = terminal.locator('.xterm-rows');
		await expect(rows).toContainText(`ready:${pid}`);
		const keys = terminal.locator('.xterm-helper-textarea');
		await keys.press('x');
		await interactive.getByRole('button', { name: 'Take Over Terminal Input', exact: true }).press('Enter');
		await expect(keys).toBeFocused();
		await expect(terminal).toHaveCount(1);
		await expect(operation(take)).rejects.toMatchObject({ code: -32010 });
		await expect(operation(write('while-ui-controls'))).rejects.toMatchObject({ code: -32010 });
		await keys.pressSequentially('first');
		await keys.press('Enter');
		await expect(rows).toContainText(`received:first:${pid}`);
		await new QuickAccess(page).runCommand('workbench.action.closeActiveEditor');
		await expect(terminal).toHaveCount(0);

		terminalConnection = await connectProfile(application, webAppServer, testWorkspace.directory, page);
		const relayOperation = (action: TerminalCommandSessionAction) => terminalConnection!.client.request(APP_SERVER_METHODS['terminal/commandSession'], { ...command, action });
		await relayOperation({ type: 'attach' });
		await expect(async () => {
			await expect(relayOperation(take)).resolves.toEqual({ type: 'acknowledged' });
		}).toPass({ timeout: 5000 });
		await relayOperation(write('relay'));
		await expect(operation(take)).rejects.toMatchObject({ code: -32010 });
		// Closing this fixture terminates its relay process. It sends no detach or
		// release RPC, so only App Server connection cleanup can free the lease.
		await terminalConnection.close();
		terminalConnection = await connectProfile(application, webAppServer, testWorkspace.directory, page);
		await relayOperation({ type: 'attach' });
		await expect(relayOperation(write('without-reacquiring'))).rejects.toMatchObject({ code: -32010 });
		await expect(async () => {
			await expect(relayOperation(take)).resolves.toEqual({ type: 'acknowledged' });
		}).toPass({ timeout: 5000 });
		await relayOperation(write('reconnected'));
		await relayOperation({ type: 'releaseInput' });
		await expect(relayOperation(write('after-release'))).rejects.toMatchObject({ code: -32010 });

		await interactive.getByRole('button', { name: 'Take Over Terminal Input', exact: true }).press('Enter');
		await expect(keys).toBeFocused();
		await expect(rows).toContainText(`received:reconnected:${pid}`);
		await keys.pressSequentially('second');
		await keys.press('Enter');
		await expect(rows).toContainText(`received:second:${pid}`);
		await expect.poll(async () => {
			const result = await relayOperation({ type: 'read', cursor: 0 });
			return result.type === 'output' && { exited: result.exited, exitCode: result.exitCode };
		}).toEqual({ exited: true, exitCode: 0 });
		await expect(relayOperation(take)).rejects.toMatchObject({ errorName: 'CoreOperationFailed' });
		await expect.poll(async () => (await read()).thread.turns.at(-1)?.status).toBe('completed');
		await expect(readFile(declinedEvidence)).rejects.toMatchObject({ code: 'ENOENT' });
		const evidence = (await readFile(approvedEvidence, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
		expect(evidence).toEqual(['start', 'first', 'relay', 'reconnected', 'second'].map(input => ({ input, pid: Number(pid), cwd })));
		await testInfo.attach('command-terminal-identity.json', {
			body: JSON.stringify(evidence, null, 2), contentType: 'application/json',
		});
	} finally {
		await terminalConnection?.close();
		await connection?.close();
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});
